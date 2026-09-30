// Neon Vanguard — PostgreSQL backend, loaded at runtime.
//
// libpq is loaded with `dlopen` rather than linked at build time. That keeps
// the build dependency-free (a machine without libpq still compiles and runs
// the server) and lets a deployment ship one binary that degrades to
// in-memory play when the database is unreachable — which is exactly the
// offline-mode requirement.
//
// Only the handful of libpq entry points the repositories need are declared
// here; no libpq headers are required to build.

#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "database/Database.hpp"

namespace neon::database {

/// The subset of the libpq C API this project uses.
struct LibPqApi {
    using PGconn = void;
    using PGresult = void;

    PGconn* (*connectdb)(const char*) = nullptr;
    void (*finish)(PGconn*) = nullptr;
    int (*status)(const PGconn*) = nullptr;
    PGresult* (*exec)(PGconn*, const char*) = nullptr;
    PGresult* (*execParams)(PGconn*, const char*, int, const void*, const char* const*,
                            const int*, const int*, int) = nullptr;
    int (*resultStatus)(const PGresult*) = nullptr;
    char* (*resultErrorMessage)(const PGresult*) = nullptr;
    void (*clear)(PGresult*) = nullptr;
    int (*ntuples)(const PGresult*) = nullptr;
    int (*nfields)(const PGresult*) = nullptr;
    char* (*getvalue)(const PGresult*, int, int) = nullptr;
    int (*getisnull)(const PGresult*, int, int) = nullptr;
    int (*cmdTuples)(PGresult*) = nullptr;

    bool loaded = false;
    std::string error;
};

/// libpq result status codes we care about.
enum PgStatus { PGRES_OK = 0, PGRES_TUPLES_OK = 2, PGRES_COMMAND_OK = 1 };

enum PgConnStatus { CONNECTION_OK = 0 };

/// Resolves libpq from a list of candidate sonames. Exposed for testing.
bool loadLibPq(const std::vector<std::string>& candidates, LibPqApi& out);
/// The default search list for this platform.
std::vector<std::string> defaultLibPqCandidates();

class PostgresDatabase : public Database {
public:
    PostgresDatabase(std::string connectionString, bool autoMigrate);
    ~PostgresDatabase() override;

    bool connect(std::string& error) override;
    void disconnect() override;
    bool connected() const override { return connected_; }

    bool upsertPlayer(const PlayerRecord& player, std::string& error) override;
    bool findPlayer(uint32_t id, PlayerRecord& out, std::string& error) override;
    bool findPlayerByName(const std::string& name, PlayerRecord& out, std::string& error) override;

    bool saveMatch(const MatchRecord& match, const std::vector<MatchPlayerRecord>& players,
                   std::string& error) override;
    bool recentMatches(std::size_t limit, std::vector<MatchRecord>& out, std::string& error) override;
    bool leaderboard(std::size_t limit, std::vector<LeaderboardEntry>& out, std::string& error) override;

    bool ping(std::string& error) override;

    /// Applies the DDL in schema.sql. Idempotent.
    bool migrate(std::string& error);

    /// True when the shared library was found and its symbols resolved.
    static bool libraryAvailable();

protected:
    bool writePlayer(const PlayerRecord& player, std::string& error) override;
    bool writeMatch(const MatchRecord& match, const std::vector<MatchPlayerRecord>& players,
                    std::string& error) override;

private:
    /**
     * RAII for a result set, so every early return still frees it.
     * Movable but not copyable: exactly one owner frees the PGresult.
     */
    class Result {
    public:
        Result(const LibPqApi& api, void* res) : api_(&api), res_(res) {}
        ~Result() { reset(); }
        Result(Result&& other) noexcept : api_(other.api_), res_(other.res_) { other.res_ = nullptr; }
        Result& operator=(Result&& other) noexcept {
            if (this != &other) {
                reset();
                api_ = other.api_;
                res_ = other.res_;
                other.res_ = nullptr;
            }
            return *this;
        }
        Result(const Result&) = delete;
        Result& operator=(const Result&) = delete;

        void* get() const { return res_; }
        explicit operator bool() const { return res_ != nullptr; }
        int rows() const { return res_ && api_ ? api_->ntuples(res_) : 0; }
        int fields() const { return res_ && api_ ? api_->nfields(res_) : 0; }
        std::string value(int row, int col) const;
        bool isNull(int row, int col) const;
        int64_t asInt(int row, int col) const;
        double asDouble(int row, int col) const;

    private:
        void reset() {
            if (res_ != nullptr && api_ != nullptr && api_->clear != nullptr) api_->clear(res_);
            res_ = nullptr;
        }
        const LibPqApi* api_ = nullptr;
        void* res_ = nullptr;
    };

    bool exec(const std::string& sql, Result& out, std::string& error);
    bool execParams(const std::string& sql, const std::vector<std::string>& params, Result& out,
                    std::string& error);
    bool readPlayer(const Result& res, PlayerRecord& out) const;

    std::string connectionString_;
    bool autoMigrate_ = true;
    void* conn_ = nullptr;
    bool connected_ = false;
};

/// A no-op backend used when no connection string is configured.
class NullDatabase : public Database {
public:
    bool connect(std::string&) override { return true; }
    void disconnect() override {}
    bool connected() const override { return false; }
    bool upsertPlayer(const PlayerRecord&, std::string&) override { return true; }
    bool findPlayer(uint32_t, PlayerRecord&, std::string&) override { return false; }
    bool findPlayerByName(const std::string&, PlayerRecord&, std::string&) override { return false; }
    bool saveMatch(const MatchRecord&, const std::vector<MatchPlayerRecord>&, std::string&) override {
        return true;
    }
    bool recentMatches(std::size_t, std::vector<MatchRecord>&, std::string&) override { return false; }
    bool leaderboard(std::size_t, std::vector<LeaderboardEntry>&, std::string&) override { return false; }
    bool ping(std::string&) override { return true; }

protected:
    bool writePlayer(const PlayerRecord&, std::string&) override { return true; }
    bool writeMatch(const MatchRecord&, const std::vector<MatchPlayerRecord>&, std::string&) override {
        return true;
    }
};

}  // namespace neon::database
