// Neon Vanguard — per-connection session state.
//
// Deliberately free of socket types: this is the state machine and the
// bookkeeping, so it can be unit tested without a network, and the transport
// (WebSocketServer) stays a thin adapter that owns the Beast objects.

#pragma once

#include <cstdint>
#include <string>

namespace neon::network {

enum class SessionState {
    /// Socket open, handshake not yet seen.
    Connected,
    /// CONNECT accepted, awaiting AUTH.
    Handshaking,
    /// AUTH accepted, not in a match.
    Authenticated,
    /// In a match; inputs are accepted.
    InMatch,
    /// Closed; retained briefly so late frames are ignored rather than
    /// treated as a new connection.
    Closed,
};

const char* sessionStateName(SessionState state);

struct Session {
    uint32_t id = 0;
    SessionState state = SessionState::Connected;

    uint32_t playerId = 0;
    uint32_t matchId = 0;
    std::string name;
    std::string client;
    std::string device;
    std::string authToken;

    /// Highest accepted input sequence. Replay protection.
    uint64_t lastInputSeq = 0;
    /// Ticks since the last accepted message; drives idle disconnects.
    double lastSeenSeconds = 0.0;
    double connectedAtSeconds = 0.0;

    /// Counters for the health endpoint and for spotting a hostile client.
    uint64_t messagesIn = 0;
    uint64_t bytesIn = 0;
    uint64_t inputsIn = 0;
    uint64_t rejected = 0;
    uint64_t snapshotsOut = 0;

    bool authenticated() const { return state == SessionState::Authenticated || state == SessionState::InMatch; }
    bool inMatch() const { return state == SessionState::InMatch; }
    void close() { state = SessionState::Closed; }

    /// True when the client has said nothing for longer than `timeout`.
    bool idleFor(double nowSeconds, double timeout) const {
        return nowSeconds - lastSeenSeconds > timeout;
    }
};

}  // namespace neon::network
