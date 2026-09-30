#include "utils/Logger.hpp"

#include <chrono>
#include <ctime>
#include <iostream>
#include <mutex>

namespace neon::utils {

bool parseLogLevel(std::string_view text, LogLevel& out) {
    if (text == "trace") out = LogLevel::Trace;
    else if (text == "debug") out = LogLevel::Debug;
    else if (text == "info") out = LogLevel::Info;
    else if (text == "warn" || text == "warning") out = LogLevel::Warn;
    else if (text == "error") out = LogLevel::Error;
    else if (text == "off" || text == "none") out = LogLevel::Off;
    else return false;
    return true;
}

const char* logLevelName(LogLevel level) {
    switch (level) {
        case LogLevel::Trace: return "TRACE";
        case LogLevel::Debug: return "DEBUG";
        case LogLevel::Info: return "INFO";
        case LogLevel::Warn: return "WARN";
        case LogLevel::Error: return "ERROR";
        case LogLevel::Off: return "OFF";
    }
    return "?";
}

namespace {

/// Short file name, so log lines stay readable without the build path.
const char* shortFile(const char* path) {
    const char* slash = path;
    for (const char* p = path; *p; ++p) {
        if (*p == '/' || *p == '\\') slash = p + 1;
    }
    return slash;
}

std::string timestamp() {
    using namespace std::chrono;
    const auto now = system_clock::now();
    const auto secs = system_clock::to_time_t(now);
    const auto ms = duration_cast<milliseconds>(now.time_since_epoch()).count() % 1000;
    std::tm tm{};
#if defined(_WIN32)
    localtime_s(&tm, &secs);
#else
    gmtime_r(&secs, &tm);
#endif
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &tm);
    char out[48];
    std::snprintf(out, sizeof(out), "%s.%03dZ", buf, static_cast<int>(ms));
    return out;
}

}  // namespace

Logger& Logger::instance() {
    static Logger logger;
    return logger;
}

bool Logger::setFile(const std::string& path) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (file_ != nullptr) {
        std::fclose(file_);
        file_ = nullptr;
    }
    file_ = std::fopen(path.c_str(), "a");
    return file_ != nullptr;
}

void Logger::log(LogLevel level, const char* file, int line, const std::string& message) {
    if (level < level_) return;
    const std::string line_text =
        timestamp() + " [" + logLevelName(level) + "] " + shortFile(file) + ":" + std::to_string(line) +
        "  " + message;

    std::lock_guard<std::mutex> lock(mutex_);
    std::fputs(line_text.c_str(), stdout);
    std::fputc('\n', stdout);
    // stdout is block buffered when it is a pipe, so an unflushed record is
    // lost if the process dies before the buffer fills. Every line is worth
    // having immediately.
    std::fflush(stdout);
    // Errors go to stderr as well, so a container log can filter on them.
    if (level >= LogLevel::Warn) {
        std::fputs(line_text.c_str(), stderr);
        std::fputc('\n', stderr);
        std::fflush(stderr);
    }
    if (file_ != nullptr) {
        std::fputs(line_text.c_str(), file_);
        std::fputc('\n', file_);
        std::fflush(file_);
    }
}

}  // namespace neon::utils
