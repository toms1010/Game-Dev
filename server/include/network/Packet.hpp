// Neon Vanguard — wire encoding.
//
// Mirrors `src/network/protocol.ts` exactly. Every message in both directions
// goes through here, which keeps the schema in one place and makes a future
// binary transport a drop-in replacement: the JSON is already a thin wrapper
// around flat numeric arrays that map one-to-one onto a packed layout.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "game/Arena.hpp"
#include "game/Enemy.hpp"
#include "game/GameState.hpp"
#include "game/Player.hpp"

namespace neon::network {

using json = nlohmann::json;
using namespace neon::game;  // NOLINT: the wire types are game types

/// Bumped whenever the schema changes incompatibly.
inline constexpr int kProtocolVersion = 1;

// --- message type tags (single letters keep frames small) ---
inline constexpr const char* kConnect = "CONNECT";
inline constexpr const char* kAuth = "AUTH";
inline constexpr const char* kJoin = "JOIN";
inline constexpr const char* kLeave = "LEAVE";
inline constexpr const char* kInput = "INPUT";
inline constexpr const char* kAbility = "ABILITY";
inline constexpr const char* kPing = "PING";
inline constexpr const char* kResync = "RESYNC";

inline constexpr const char* kWelcome = "WELCOME";
inline constexpr const char* kAuthOk = "AUTH_OK";
inline constexpr const char* kJoined = "JOINED";
inline constexpr const char* kSnap = "SNAP";
inline constexpr const char* kEvent = "EV";
inline constexpr const char* kPong = "PONG";
inline constexpr const char* kError = "ERR";

/// Quantisation, matching the client.
double quantise1(double v);
double quantise2(double v);
double quantise3(double v);

/// Server error codes, so the client can branch without string matching.
enum ErrorCode : int {
    kErrBadJson = 1000,
    kErrUnknownType = 1001,
    kErrVersionMismatch = 1002,
    kErrNameRejected = 1003,
    kErrNotAuthenticated = 1004,
    kErrMatchFull = 1005,
    kErrRateLimited = 1006,
    kErrInvalidInput = 1007,
    kErrServerFull = 1008,
};

/// A decoded inbound message. Only intent-bearing fields are retained.
struct InboundMessage {
    enum class Kind { Unknown, Connect, Auth, Join, Leave, Input, Ability, Ping, Resync };

    Kind kind = Kind::Unknown;

    // CONNECT
    int version = 0;
    std::string client;
    std::string device;

    // AUTH / JOIN
    std::string name;
    std::string token;
    std::string mode;

    // INPUT
    uint64_t sequence = 0;
    uint64_t clientTick = 0;
    double moveX = 0.0;
    double moveY = 0.0;
    double aimX = 0.0;
    double aimY = 0.0;
    bool firing = false;

    // ABILITY
    std::string ability;

    // PING / RESYNC
    uint64_t pingId = 0;
    uint64_t since = 0;
};

/// Parses a frame. Never throws; malformed input yields Kind::Unknown.
InboundMessage parseMessage(const std::string& raw);

/// `[id, x, y, vx, vy, angle, hp, maxHp, flags]`
std::vector<double> encodePlayer(const Player& player, double nowSeconds);
/// `[id, kindId, x, y, r, hp, angle]`
std::vector<double> encodeEnemy(const Enemy& enemy);

json makeWelcome(uint32_t playerId, uint64_t tick, int tickRate, const Arena& arena);
json makeAuthOk(uint32_t playerId, const std::string& name);
json makeJoined(uint32_t matchId, const std::string& mode,
                const std::vector<std::pair<uint32_t, std::string>>& roster);
json makeSnapshot(uint64_t tick, uint64_t ack, const GameState& state, double nowSeconds);
json makeEvent(const std::string& kind, uint32_t id, double value);
json makePong(uint64_t pingId, uint64_t clientTick, uint64_t serverTick);
json makeError(int code, const std::string& message);

/// Serialises for the wire. `dump()` is allocation-heavy, so the game loop
/// reuses one json object and calls `dump()` once per broadcast batch.
std::string serialise(const json& message);

}  // namespace neon::network
