// Neon Vanguard — minimal test harness.
//
// Deliberately not a framework dependency: the server already needs nothing
// but Boost and a C++20 compiler, and the test build should keep that property.
// The macro shape (`TEST_CASE`, `CHECK`, `CHECK_EQ`) is familiar enough to
// read at a glance, and failures report file, line and both values.

#pragma once

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <string>
#include <vector>

namespace neon::test {

struct TestCase {
    const char* suite;
    const char* name;
    void (*fn)();
};

/// Registry of every test in the binary, ordered so runs are reproducible.
inline std::vector<TestCase>& registry() {
    static std::vector<TestCase> cases;
    return cases;
}

struct Registrar {
    Registrar(const char* suite, const char* name, void (*fn)()) {
        registry().push_back(TestCase{suite, name, fn});
    }
};

/// Thrown by a failing assertion so the runner can report and continue.
struct Failure {
    std::string message;
};

inline void reportFailure(const char* file, int line, const std::string& detail) {
    throw Failure{std::string(file) + ":" + std::to_string(line) + "  " + detail};
}

template <typename T>
std::string describe(const T& value) {
    if constexpr (std::is_convertible_v<T, std::string>) {
        return "\"" + std::string(value) + "\"";
    } else if constexpr (std::is_floating_point_v<T>) {
        char buffer[32];
        std::snprintf(buffer, sizeof(buffer), "%.6f", static_cast<double>(value));
        return buffer;
    } else {
        return std::to_string(value);
    }
}

inline int runAll(const char* suiteFilter) {
    int passed = 0;
    int failed = 0;
    std::vector<std::string> failures;

    for (const TestCase& test : registry()) {
        if (suiteFilter != nullptr && std::string(test.suite) != suiteFilter) continue;
        try {
            test.fn();
            ++passed;
            std::printf("  \033[32mPASS\033[0m  %s\n", test.name);
        } catch (const Failure& failure) {
            ++failed;
            failures.push_back(std::string(test.name) + "\n        " + failure.message);
            std::printf("  \033[31mFAIL\033[0m  %s\n        %s\n", test.name, failure.message.c_str());
        } catch (const std::exception& e) {
            ++failed;
            failures.push_back(std::string(test.name) + "\n        threw: " + e.what());
            std::printf("  \033[31mFAIL\033[0m  %s\n        threw: %s\n", test.name, e.what());
        }
    }

    std::printf("\n%d passed, %d failed, %zu total\n", passed, failed, registry().size());
    if (!failures.empty()) {
        std::printf("\nFailures:\n");
        for (const std::string& failure : failures) std::printf("  - %s\n", failure.c_str());
    }
    return failed == 0 ? 0 : 1;
}

}  // namespace neon::test

#define NEON_TEST_CONCAT_INNER(a, b) a##b
#define NEON_TEST_CONCAT(a, b) NEON_TEST_CONCAT_INNER(a, b)

#define TEST_CASE(suite, name)                                                      \
    static void NEON_TEST_CONCAT(neon_test_, __LINE__)();                           \
    static ::neon::test::Registrar NEON_TEST_CONCAT(neon_registrar_, __LINE__){     \
        suite, name, &NEON_TEST_CONCAT(neon_test_, __LINE__)};                     \
    static void NEON_TEST_CONCAT(neon_test_, __LINE__)()

#define CHECK(condition)                                                            \
    do {                                                                            \
        if (!(condition)) {                                                         \
            ::neon::test::reportFailure(__FILE__, __LINE__, "expected: " #condition); \
        }                                                                           \
    } while (false)

#define CHECK_MSG(condition, message)                                               \
    do {                                                                            \
        if (!(condition)) {                                                         \
            ::neon::test::reportFailure(__FILE__, __LINE__,                          \
                                        std::string("expected: " #condition " — ") + (message)); \
        }                                                                           \
    } while (false)

#define CHECK_EQ(actual, expected)                                                  \
    do {                                                                            \
        const auto neon_actual = (actual);                                          \
        const auto neon_expected = (expected);                                      \
        if (!(neon_actual == neon_expected)) {                                      \
            ::neon::test::reportFailure(__FILE__, __LINE__,                          \
                                        std::string(#actual " == " #expected " — got ") + \
                                            ::neon::test::describe(neon_actual) +     \
                                            ", expected " +                         \
                                            ::neon::test::describe(neon_expected));   \
        }                                                                           \
    } while (false)

#define CHECK_NEAR(actual, expected, tolerance)                                     \
    do {                                                                            \
        const double neon_a = static_cast<double>(actual);                          \
        const double neon_e = static_cast<double>(expected);                        \
        if (std::fabs(neon_a - neon_e) > (tolerance)) {                             \
            ::neon::test::reportFailure(__FILE__, __LINE__,                          \
                                        std::string(#actual " ~= " #expected " — got ") + \
                                            ::neon::test::describe(neon_a) +         \
                                            ", expected " +                         \
                                            ::neon::test::describe(neon_e));        \
        }                                                                           \
    } while (false)

#define NEON_TEST_MAIN(suiteName)                                                   \
    int main(int argc, char** argv) {                                               \
        const char* filter = nullptr;                                               \
        for (int i = 1; i < argc; ++i) {                                            \
            const std::string arg = argv[i];                                        \
            if (arg == "--list") {                                                  \
                for (const auto& test : ::neon::test::registry()) {                 \
                    if (std::string(test.suite) == suiteName) {                     \
                        std::printf("%s.%s\n", test.suite, test.name);              \
                    }                                                               \
                }                                                                   \
                return 0;                                                           \
            }                                                                       \
            filter = argv[i];                                                       \
        }                                                                           \
        return ::neon::test::runAll(filter);                                        \
    }
