// Neon Vanguard — transport.
//
// One acceptor serves both protocols on one port, which is what a real
// deployment needs: `wss://host/ws/game` and `https://host/api/...` cannot
// share a port otherwise without a proxy in front.
//
// The first request on a connection decides the protocol. A GET carrying
// `Upgrade: websocket` on the game path becomes a WebSocket session;
// anything else is answered from the REST router and the connection closes.

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include <boost/asio/any_io_executor.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>

#include "core/Config.hpp"
#include "network/ClientSession.hpp"

namespace beast = boost::beast;
namespace http = beast::http;
namespace websocket = beast::websocket;
namespace net = boost::asio;
using tcp = boost::asio::ip::tcp;

namespace neon::network {

/// Largest inbound frame accepted. A legitimate input message is well under
/// 200 bytes; this is purely a guard against a client trying to exhaust memory.
inline constexpr std::size_t kMaxFrameBytes = 16 * 1024;
/// Outgoing queue ceiling per connection, to bound a slow reader.
inline constexpr std::size_t kMaxPendingWrites = 64;
/// Largest REST body accepted. The only POST bodies are small JSON records.
inline constexpr std::size_t kMaxRestBodyBytes = 64 * 1024;

/// A parsed REST request.
struct HttpRequest {
    std::string method;
    std::string target;
    std::string path;
    std::string query;
    std::string body;
    std::unordered_map<std::string, std::string> headers;
};

struct HttpResponse {
    int status = 200;
    std::string contentType = "application/json";
    std::string body;
};

/// Callbacks the transport invokes. Implemented by `core::GameServer`.
class TransportHandler {
public:
    virtual ~TransportHandler() = default;

    /// A new connection was accepted and its session registered. This is
    /// where per-connection budgets must be created: it has to happen before
    /// the first message is rate limited, not when the client says CONNECT.
    virtual void onSessionOpened(Session& session) = 0;

    /// A complete text frame arrived on a live WebSocket session.
    virtual void onTextMessage(Session& session, const std::string& payload) = 0;

    /// A WebSocket session ended. `reason` is "peer" or "error".
    virtual void onSessionClosed(Session& session, const std::string& reason) = 0;

    /// Sends a text frame. Queued if the socket is busy.
    virtual void send(Session& session, const std::string& payload) = 0;

    /// A non-WebSocket request arrived; answer it and close.
    virtual HttpResponse onHttp(const HttpRequest& request) = 0;

    /// Monotonic seconds since server start, for session timestamps.
    virtual double now() const = 0;
};

class WebSocketServer {
public:
    using Executor = net::any_io_executor;

    WebSocketServer(Executor executor, const core::Config& config, TransportHandler& handler);
    ~WebSocketServer();

    /// Binds and starts accepting. False means the port could not be bound,
    /// which the caller must surface rather than idle on.
    bool start();
    void stop();

    bool listening() const { return running_; }

    uint16_t port() const { return config_.port; }
    std::size_t activeSessions() const { return connections_.size(); }
    /// Total accepted connections since boot.
    uint64_t totalAccepted() const { return totalAccepted_; }

    /// The live session for a connection. There is exactly one `Session` per
    /// connection, owned here, so the transport and the game server can never
    /// drift out of sync by holding copies.
    Session& session(uint32_t sessionId) { return sessions_[sessionId]; }
    /// Creates (or replaces) the session record for a new connection.
    Session& createSession(uint32_t sessionId);
    const std::unordered_map<uint32_t, Session>& sessions() const { return sessions_; }
    /// Mutable view, used by the game loop to stamp per-session counters.
    std::unordered_map<uint32_t, Session>& mutableSessions() { return sessions_; }

    /// Closes a session from the game side (kick, match finished, idle).
    void closeSession(uint32_t sessionId, const std::string& reason);

    /// Queues a text frame on a session. Silently drops unknown ids, so the
    /// caller does not have to check for a race with teardown.
    void sendTo(uint32_t sessionId, const std::string& payload);

private:
    class Connection;
    friend class Connection;

    using ConnectionPtr = std::shared_ptr<Connection>;

    void accept();
    void onAccept(tcp::socket socket);
    void dropSession(uint32_t sessionId);

    Executor executor_;
    core::Config config_;
    TransportHandler& handler_;
    tcp::acceptor acceptor_;
    std::unordered_map<uint32_t, ConnectionPtr> connections_;
    std::unordered_map<uint32_t, Session> sessions_;
    uint32_t nextSessionId_ = 1;
    uint64_t totalAccepted_ = 0;
    bool running_ = false;
};

}  // namespace neon::network
