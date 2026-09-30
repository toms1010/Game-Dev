// Neon Vanguard — logging.
//
// Deliberately tiny: a level, a timestamp, a source location and a variadic
// message. Writes to stdout and optionally a file. The server is a single
// io_context with a small thread pool, so the only real concurrency hazard is
// the database writer thread; a mutex around the sink is enough.

#pragma once

#include <cstdio>
#include <mutex>
#include <sstream>
#include <string>
#include <string_view>

namespace neon::utils {

enum class LogLevel { Trace = 0, Debug = 1, Info = 2, Warn = 3, Error = 4, Off = 5 };

bool parseLogLevel(std::string_view text, LogLevel& out);
const char* logLevelName(LogLevel level);

class Logger {
public:
    static Logger& instance();

    void setLevel(LogLevel level) { level_ = level; }
    LogLevel level() const { return level_; }

    /// Mirrors every record into a file. Returns false if it cannot be opened.
    bool setFile(const std::string& path);

    void log(LogLevel level, const char* file, int line, const std::string& message);

    template <typename... Args>
    void trace(const char* file, int line, Args&&... args) { emit(LogLevel::Trace, file, line, args...); }
    template <typename... Args>
    void debug(const char* file, int line, Args&&... args) { emit(LogLevel::Debug, file, line, args...); }
    template <typename... Args>
    void info(const char* file, int line, Args&&... args) { emit(LogLevel::Info, file, line, args...); }
    template <typename... Args>
    void warn(const char* file, int line, Args&&... args) { emit(LogLevel::Warn, file, line, args...); }
    template <typename... Args>
    void error(const char* file, int line, Args&&... args) { emit(LogLevel::Error, file, line, args...); }

private:
    Logger() = default;
    template <typename... Args>
    void emit(LogLevel level, const char* file, int line, Args&&... args) {
        if (level < level_) return;
        std::ostringstream os;
        (os << ... << args);
        log(level, file, line, os.str());
    }

    LogLevel level_ = LogLevel::Info;
    std::mutex mutex_;
    std::FILE* file_ = nullptr;
};

}  // namespace neon::utils

// Short, scoped macros. The `__FILE__`/`__LINE__` capture is the point: in a
// 60 Hz loop, knowing which call site logged matters.
#define NEON_TRACE(...) ::neon::utils::Logger::instance().trace(__FILE__, __LINE__, __VA_ARGS__)
#define NEON_DEBUG(...) ::neon::utils::Logger::instance().debug(__FILE__, __LINE__, __VA_ARGS__)
#define NEON_INFO(...) ::neon::utils::Logger::instance().info(__FILE__, __LINE__, __VA_ARGS__)
#define NEON_WARN(...) ::neon::utils::Logger::instance().warn(__FILE__, __LINE__, __VA_ARGS__)
#define NEON_ERROR(...) ::neon::utils::Logger::instance().error(__FILE__, __LINE__, __VA_ARGS__)
