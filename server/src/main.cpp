// Neon Vanguard — server entry point.
//
// Usage:
//   neon_vanguard_server [--config <path>] [--port <n>] [--log-level <level>]
//                        [--arena <WxH>] [--db <connection-string>] [--help]
//
// Everything on the command line overrides the config file, which overrides
// the NEON_* environment variables' defaults, which override the built-in
// defaults. Print --help and exit 0; anything unrecognised is a hard error so
// a typo in a deployment script fails loudly instead of silently starting on
// the wrong port.

#include <cstdlib>
#include <iostream>
#include <string>

#include "core/Config.hpp"
#include "core/Server.hpp"
#include "utils/Logger.hpp"

namespace {

void printUsage(const char* program) {
    std::cout
        << "Neon Vanguard game server\n\n"
        << "Usage: " << program << " [options]\n\n"
        << "Options:\n"
        << "  -c, --config <path>     JSON configuration file\n"
        << "      --port <n>          Listen port (default 8080)\n"
        << "      --host <addr>       Bind address (default 0.0.0.0)\n"
        << "      --tick-rate <hz>    Simulation rate (default 60)\n"
        << "      --arena <WxH>       Arena size in world units (default 960x600)\n"
        << "      --snapshot-hz <n>   Snapshot broadcast rate (default 20)\n"
        << "      --db <conn-string>  PostgreSQL connection string; omit for in-memory\n"
        << "      --log-level <lvl>   trace|debug|info|warn|error|off\n"
        << "  -h, --help              Show this help\n\n"
        << "Endpoints:\n"
        << "  ws://host:port/ws/game   Real-time gameplay\n"
        << "  http://host:port/api    REST API\n"
        << "  http://host:port/healthz Health and statistics\n";
}

/// Pulls the value that follows an option, or reports a missing value.
bool takeValue(int argc, char** argv, int& i, const char* flag, std::string& out) {
    if (i + 1 >= argc) {
        std::cerr << "error: " << flag << " requires a value\n";
        return false;
    }
    out = argv[++i];
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    std::string configPath = neon::core::Server::resolveConfigPath(argc, argv);

    // First pass: collect overrides so they can be applied after the file.
    std::string port, host, tickRate, arena, snapshotHz, db, logLevel;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "-h" || arg == "--help") {
            printUsage(argv[0]);
            return 0;
        }
        if (arg == "-c" || arg == "--config") {
            if (!takeValue(argc, argv, i, "--config", configPath)) return 2;
        } else if (arg == "--port") {
            if (!takeValue(argc, argv, i, "--port", port)) return 2;
        } else if (arg == "--host") {
            if (!takeValue(argc, argv, i, "--host", host)) return 2;
        } else if (arg == "--tick-rate") {
            if (!takeValue(argc, argv, i, "--tick-rate", tickRate)) return 2;
        } else if (arg == "--arena") {
            if (!takeValue(argc, argv, i, "--arena", arena)) return 2;
        } else if (arg == "--snapshot-hz") {
            if (!takeValue(argc, argv, i, "--snapshot-hz", snapshotHz)) return 2;
        } else if (arg == "--db") {
            if (!takeValue(argc, argv, i, "--db", db)) return 2;
        } else if (arg == "--log-level") {
            if (!takeValue(argc, argv, i, "--log-level", logLevel)) return 2;
        } else {
            std::cerr << "error: unrecognised option '" << arg << "'\n\n";
            printUsage(argv[0]);
            return 2;
        }
    }

    neon::core::Config config;
    std::string error;
    neon::core::Config::load(configPath, config, error);
    if (!error.empty() && configPath.empty()) {
        // No config file was requested at all: silence the warning.
        error.clear();
    }

    // Command line beats file beats environment.
    if (!port.empty()) config.port = static_cast<uint16_t>(std::strtoul(port.c_str(), nullptr, 10));
    if (!host.empty()) config.host = host;
    if (!tickRate.empty()) config.tick_rate = std::atoi(tickRate.c_str());
    if (!snapshotHz.empty()) config.tick.snapshot_hz = std::atoi(snapshotHz.c_str());
    if (!db.empty()) config.db.connection_string = db;
    if (!logLevel.empty()) config.log_level = logLevel;
    if (!arena.empty()) {
        const std::size_t x = arena.find('x');
        if (x == std::string::npos) {
            std::cerr << "error: --arena expects WxH, for example 960x600\n";
            return 2;
        }
        config.arena_w = std::atof(arena.substr(0, x).c_str());
        config.arena_h = std::atof(arena.substr(x + 1).c_str());
    }

    if (!config.validate(error)) {
        std::cerr << "error: " << error << "\n";
        return 2;
    }

    neon::utils::LogLevel level{};
    neon::utils::parseLogLevel(config.log_level, level);
    neon::utils::Logger::instance().setLevel(level);
    if (config.log_to_file &&
        !neon::utils::Logger::instance().setFile(config.log_file)) {
        NEON_WARN("could not open log file ", config.log_file, "; logging to stdout only");
    }

    neon::core::Server server(config);
    if (!server.start(error)) {
        std::cerr << "error: " << error << "\n";
        return 1;
    }
    server.run();
    return 0;
}
