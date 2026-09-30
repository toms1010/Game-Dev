#include "core/Server.hpp"

#include <algorithm>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>

#include <boost/asio/signal_set.hpp>

#include "utils/Logger.hpp"

namespace neon::core {

Server::Server(const Config& config) : config_(config) { io_.restart(); }

Server::~Server() { teardown(); }

unsigned Server::workerThreadCount(unsigned requested) {
    if (requested > 0) return requested;
    const unsigned cores = std::thread::hardware_concurrency();
    if (cores == 0) return 2;
    // The game loop is a single timer handler; more than a few io_context
    // threads mostly adds contention on the session mutex.
    return std::clamp(cores - 1, 2u, 8u);
}

std::string Server::resolveConfigPath(int argc, char** argv) {
    for (int i = 1; i < argc - 1; ++i) {
        if (std::strcmp(argv[i], "--config") == 0 || std::strcmp(argv[i], "-c") == 0) {
            return argv[i + 1];
        }
    }
    if (const char* env = std::getenv("NEON_CONFIG"); env != nullptr && *env != '\0') return env;
    {
        std::ifstream probe("config/server.json");
        if (probe.good()) return "config/server.json";
    }
    return "";
}

bool Server::start(std::string& error) {
    game_ = std::make_unique<GameServer>(io_.get_executor(), config_);
    game_->setIoStopHandler([this] { io_.stop(); });

    if (!game_->start(error)) {
        game_.reset();
        return false;
    }

    const unsigned threads = workerThreadCount(config_.io_threads);
    workers_.reserve(threads);
    for (unsigned i = 0; i < threads; ++i) {
        workers_.emplace_back([this] {
            try {
                io_.run();
            } catch (const std::exception& e) {
                NEON_ERROR("io_context: ", e.what());
            }
        });
    }
    started_ = true;
    installSignalHandlers();
    NEON_INFO("started with ", threads, " io thread(s); tick rate ", config_.tick_rate, " Hz");
    return true;
}

void Server::run() {
    if (!started_) return;
    // Block until every worker returns, which happens once io_context stops.
    for (std::thread& worker : workers_) {
        if (worker.joinable()) worker.join();
    }
    teardown();
    NEON_INFO("stopped cleanly");
}

void Server::stop() {
    if (!started_ || stopping_.exchange(true)) return;
    // A signal handler cannot take a lock, so the actual teardown is posted
    // onto the io_context and happens on a worker thread.
    boost::asio::post(io_, [this] {
        if (game_) game_->stop();
        io_.stop();
    });
}

void Server::installSignalHandlers() {
    // signal_set on the io_context delivers SIGINT/SIGTERM asynchronously, so
    // the handler does no work beyond waking the loop. It is a member: a
    // local would be destroyed here, un-catching the signal and turning
    // SIGTERM back into an abrupt kill.
    signals_ = std::make_unique<boost::asio::signal_set>(io_, SIGINT, SIGTERM);
    signals_->async_wait([this](const boost::system::error_code& ec, int signal) {
        if (ec) return;
        NEON_INFO("received signal ", signal, ", shutting down");
        signals_->cancel();
        if (game_) game_->stop();
        io_.stop();
    });
}

void Server::teardown() {
    if (signals_) {
        signals_->cancel();
        signals_.reset();
    }
    if (game_) {
        game_->stop();
        game_.reset();
    }
    started_ = false;
}

}  // namespace neon::core
