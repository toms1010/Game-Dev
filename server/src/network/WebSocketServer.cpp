#include "network/WebSocketServer.hpp"

#include <algorithm>
#include <cctype>
#include <deque>
#include <utility>

#include <boost/asio/buffer.hpp>
#include <boost/asio/detached.hpp>
#include <boost/asio/post.hpp>
#include <boost/asio/read.hpp>
#include <boost/asio/write.hpp>
#include <boost/beast/http/read.hpp>
#include <boost/beast/http/write.hpp>

#include "utils/Logger.hpp"

namespace neon::network {

const char* sessionStateName(SessionState state) {
    switch (state) {
        case SessionState::Connected: return "connected";
        case SessionState::Handshaking: return "handshaking";
        case SessionState::Authenticated: return "authenticated";
        case SessionState::InMatch: return "in-match";
        case SessionState::Closed: return "closed";
    }
    return "unknown";
}

namespace {

std::string lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return value;
}

/// True when the request is a WebSocket upgrade aimed at the game endpoint.
bool isGameUpgrade(const http::request<http::string_body>& request) {
    if (request.method() != http::verb::get) return false;
    std::string target(request.target());
    const std::size_t query = target.find('?');
    if (query != std::string::npos) target.resize(query);
    if (target != "/ws/game") return false;
    return lower(std::string(request[http::field::upgrade])).find("websocket") !=
           std::string::npos;
}

}  // namespace

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * One accepted socket.
 *
 * Owns the whole lifecycle: read the HTTP request, decide whether it is a
 * WebSocket upgrade or a REST call, then either upgrade and pump frames or
 * answer once and close. Held by `shared_ptr` from the acceptor, so it
 * outlives every async chain that references it.
 *
 * The `Session` itself lives in the server's table, not here, so there is
 * exactly one copy of it in the process.
 */
class WebSocketServer::Connection : public std::enable_shared_from_this<WebSocketServer::Connection> {
public:
    Connection(WebSocketServer& server, tcp::socket socket, uint32_t sessionId)
        : server_(server), stream_(std::move(socket)), id_(sessionId) {
        stream_.socket().set_option(tcp::no_delay(true));
    }

    void run() {
        server_.connections_[id_] = shared_from_this();
        Session& s = server_.createSession(id_);
        s.connectedAtSeconds = server_.handler_.now();
        s.lastSeenSeconds = s.connectedAtSeconds;
        server_.handler_.onSessionOpened(s);
        readRequest();
    }

    uint32_t id() const { return id_; }
    Session& session() { return server_.session(id_); }

    /// Queues a text frame. Writes are serialized through `writeQueue_`.
    void sendText(std::string payload) {
        if (closed_ || !upgraded_) return;
        // Back-pressure guard: a client that cannot drain is dropped rather
        // than allowed to grow this queue without bound.
        if (writeQueue_.size() >= kMaxPendingWrites) {
            NEON_WARN("session ", id_, ": write backlog full, closing connection");
            close("client too slow");
            return;
        }
        writeQueue_.push_back(std::move(payload));
        if (!writing_) doWrite();
    }

    void close(const std::string& reason) {
        if (closed_) return;
        closed_ = true;
        closeReason_ = reason;
        boost::system::error_code ignored;
        // Beast's close() takes a code, not a reason string; the code plus
        // the server-side log is what the operator actually needs.
        (void)reason;
        if (upgraded_) ws_->close(websocket::close_code::normal, ignored);
        teardown();
    }

private:
    // ---- phase 1: read the HTTP request (headers + body in one operation) ----
    void readRequest() {
        auto self = shared_from_this();
        // Drop anything left from a previous (failed) attempt.
        httpBuffer_.consume(httpBuffer_.size());
        // beast's overload consumes exactly one request (headers then body)
        // and reports a body_limit overflow rather than buffering forever.
        http::async_read(
            stream_, httpBuffer_, restRequest_,
            [self](boost::system::error_code ec, std::size_t) {
                if (ec) {
                    if (ec != http::error::end_of_stream) {
                        NEON_DEBUG("session ", self->id_, ": bad request: ", ec.message());
                    }
                    self->teardown();
                    return;
                }
                self->dispatch();
            });
    }

    void dispatch() {
        if (isGameUpgrade(restRequest_)) {
            upgrade();
        } else {
            answerRest();
        }
    }

    // ---- phase 2: WebSocket ----
    void upgrade() {
        upgraded_ = true;
        auto self = shared_from_this();
        // The websocket layer wraps the same flat stream, so no bytes are lost
        // between the HTTP handshake and the first frame.
        ws_ = std::make_unique<websocket::stream<beast::tcp_stream>>(std::move(stream_));
        ws_->set_option(websocket::stream_base::timeout::suggested(beast::role_type::server));

        ws_->async_accept(restRequest_, [self](boost::system::error_code ec) {
            if (ec) {
                self->teardown();
                return;
            }
            NEON_DEBUG("session ", self->id_, ": websocket established");
            self->doRead();
        });
    }

    void doRead() {
        auto self = shared_from_this();
        readBuffer_.clear();
        // A dynamic buffer accumulates exactly one whole message and enforces
        // the frame cap. A fixed-size buffer would split a large frame into
        // two "messages" and corrupt the framing. The buffer is captured by
        // the handler so it outlives the read.
        auto buffer = net::dynamic_buffer(readBuffer_, kMaxFrameBytes);
        ws_->async_read(
            buffer, [self, buffer = std::move(buffer)](boost::system::error_code ec, std::size_t) {
                if (ec) {
                    self->fail(ec);
                    return;
                }
                self->session().lastSeenSeconds = self->server_.handler_.now();
                self->server_.handler_.onTextMessage(self->session(), self->readBuffer_);
                if (!self->closed_) self->doRead();
            });
    }

    void doWrite() {
        if (writeQueue_.empty() || closed_) {
            writing_ = false;
            return;
        }
        writing_ = true;
        writeBuffer_ = std::move(writeQueue_.front());
        writeQueue_.pop_front();

        auto self = shared_from_this();
        ws_->async_write(boost::asio::buffer(writeBuffer_), [self](boost::system::error_code ec, std::size_t) {
            if (ec) {
                self->fail(ec);
                return;
            }
            if (!self->closed_) self->doWrite();
        });
    }

    // ---- phase 3: REST ----
    void answerRest() {
        HttpRequest parsed;
        parsed.method = std::string(restRequest_.method_string());
        parsed.target = std::string(restRequest_.target());
        const std::size_t query = parsed.target.find('?');
        if (query != std::string::npos) {
            parsed.path = parsed.target.substr(0, query);
            parsed.query = parsed.target.substr(query + 1);
        } else {
            parsed.path = parsed.target;
        }
        for (const auto& field : restRequest_) {
            parsed.headers[lower(std::string(field.name_string()))] = std::string(field.value());
        }
        parsed.body = std::move(restRequest_.body());

        const HttpResponse response = server_.handler_.onHttp(parsed);

        http::response<http::string_body> out;
        out.version(11);
        out.result(static_cast<unsigned>(response.status));
        out.set(http::field::server, "neon-vanguard");
        out.set(http::field::content_type, response.contentType);
        out.set(http::field::access_control_allow_origin, "*");
        out.set(http::field::access_control_allow_methods, "GET, POST, OPTIONS");
        out.set(http::field::access_control_allow_headers, "content-type, authorization");
        out.set(http::field::cache_control, "no-store");
        out.body() = response.body;
        out.prepare_payload();

        closeReason_ = "rest";
        auto self = shared_from_this();
        http::async_write(stream_, out, [self](boost::system::error_code, std::size_t) {
            self->teardown();
        });
    }

    // ---- teardown ----
    void fail(const boost::system::error_code& ec) {
        if (tornDown_) return;
        // A clean close, a half-open socket and a cancelled operation are all
        // the ordinary way a client goes away; anything else is worth a log.
        if (ec == websocket::error::closed || ec == net::error::operation_aborted ||
            ec == http::error::end_of_stream || ec == net::error::eof) {
            closeReason_ = "peer";
        } else {
            closeReason_ = "error";
            NEON_DEBUG("session ", id_, ": read failed: ", ec.message());
        }
        teardown();
    }

    void teardown() {
        if (tornDown_) return;
        tornDown_ = true;
        closed_ = true;
        // The handler must run while the session still exists.
        server_.handler_.onSessionClosed(session(), closeReason_);
        server_.dropSession(id_);
        boost::system::error_code ignored;
        stream_.socket().shutdown(tcp::socket::shutdown_both, ignored);
        stream_.socket().close(ignored);
    }

    WebSocketServer& server_;
    /// A flat stream owns the read/write buffers, which is why the websocket
    /// layer can be moved straight out of it during the upgrade.
    beast::tcp_stream stream_;
    beast::flat_buffer httpBuffer_;
    http::request<http::string_body> restRequest_;
    std::unique_ptr<websocket::stream<beast::tcp_stream>> ws_;

    uint32_t id_;
    std::string closeReason_ = "closed";
    std::string readBuffer_;
    std::deque<std::string> writeQueue_;
    std::string writeBuffer_;
    bool writing_ = false;
    bool upgraded_ = false;
    bool closed_ = false;
    bool tornDown_ = false;
};

// ---------------------------------------------------------------------------
// WebSocketServer
// ---------------------------------------------------------------------------

WebSocketServer::WebSocketServer(Executor executor, const core::Config& config, TransportHandler& handler)
    : executor_(executor), config_(config), handler_(handler), acceptor_(executor) {}

WebSocketServer::~WebSocketServer() { stop(); }

Session& WebSocketServer::createSession(uint32_t id) {
    Session fresh;
    fresh.id = id;
    fresh.lastSeenSeconds = handler_.now();
    return sessions_.insert_or_assign(id, std::move(fresh)).first->second;
}

void WebSocketServer::dropSession(uint32_t id) {
    sessions_.erase(id);
    connections_.erase(id);
}

bool WebSocketServer::start() {
    const tcp::endpoint endpoint{net::ip::make_address(config_.host), config_.port};
    boost::system::error_code ec;
    acceptor_.open(endpoint.protocol(), ec);
    if (ec) {
        NEON_ERROR("listen: open failed: ", ec.message());
        return false;
    }
    acceptor_.set_option(net::socket_base::reuse_address(true), ec);
    acceptor_.bind(endpoint, ec);
    if (ec) {
        NEON_ERROR("listen: bind to ", config_.host, ":", config_.port, " failed: ", ec.message());
        return false;
    }
    acceptor_.listen(net::socket_base::max_listen_connections, ec);
    if (ec) {
        NEON_ERROR("listen: failed: ", ec.message());
        return false;
    }
    running_ = true;
    NEON_INFO("listening on ", config_.host, ":", config_.port,
              "  (websocket /ws/game, REST /api, health /healthz)");
    accept();
    return true;
}

void WebSocketServer::stop() {
    if (!running_) return;
    running_ = false;
    boost::system::error_code ignored;
    acceptor_.close(ignored);
    // Copy first: close() synchronously tears the session down, which erases
    // from the map we would otherwise be iterating.
    std::vector<ConnectionPtr> live;
    live.reserve(connections_.size());
    for (auto& [id, connection] : connections_) live.push_back(connection);
    for (const ConnectionPtr& connection : live) connection->close("server shutting down");
    connections_.clear();
    sessions_.clear();
}

void WebSocketServer::accept() {
    if (!running_) return;
    acceptor_.async_accept([this](boost::system::error_code ec, tcp::socket socket) {
        if (ec) {
            if (ec != net::error::operation_aborted) NEON_WARN("accept failed: ", ec.message());
            return;
        }
        ++totalAccepted_;
        onAccept(std::move(socket));
        accept();
    });
}

void WebSocketServer::onAccept(tcp::socket socket) {
    auto connection = std::make_shared<Connection>(*this, std::move(socket), nextSessionId_++);
    connection->run();
}

void WebSocketServer::closeSession(uint32_t sessionId, const std::string& reason) {
    auto it = connections_.find(sessionId);
    if (it != connections_.end()) it->second->close(reason);
}

void WebSocketServer::sendTo(uint32_t sessionId, const std::string& payload) {
    auto it = connections_.find(sessionId);
    if (it == connections_.end()) return;  // already gone; nothing to do
    it->second->sendText(payload);
}

}  // namespace neon::network
