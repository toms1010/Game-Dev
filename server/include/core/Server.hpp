// Neon Vanguard — process entry point.
//
// Wires the io_context, the worker threads, signal handling and the game
// server, then runs until asked to stop.

#pragma once

#include <atomic>
#include <memory>
#include <string>
#include <vector>

#include <boost/asio/io_context.hpp>
#include <boost/asio/signal_set.hpp>

#include "core/Config.hpp"
#include "core/GameServer.hpp"

namespace neon::core {

class Server {
public:
    explicit Server(const Config& config);
    ~Server();

    /// Creates the game server and binds the listener.
    bool start(std::string& error);

    /// Blocks until `stop()` is called (including via SIGINT/SIGTERM).
    void run();

    /// Asynchronous; safe to call from a signal handler.
    void stop();

    /// Hardware concurrency, clamped to a sane range for the worker pool.
    static unsigned workerThreadCount(unsigned requested);

    /// Resolves the config path: `--config`, then `NEON_CONFIG`, then
    /// `config/server.json`, then built-in defaults.
    static std::string resolveConfigPath(int argc, char** argv);

private:
    void installSignalHandlers();
    void teardown();

    Config config_;
    boost::asio::io_context io_;
    /// Must outlive the wait: a signal_set that is destroyed stops catching
    /// signals, and SIGTERM would go back to killing the process outright.
    std::unique_ptr<boost::asio::signal_set> signals_;
    std::unique_ptr<GameServer> game_;
    std::vector<std::thread> workers_;
    std::atomic<bool> stopping_{false};
    bool started_ = false;
};

}  // namespace neon::core
