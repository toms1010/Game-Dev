// Neon Vanguard — inbound message semantics.
//
// Split out from the raw decoding in Packet.hpp so the security rules live in
// one auditable place: this is the boundary where an untrusted string becomes
// a value the simulation is allowed to act on.

#pragma once

#include <cstdint>
#include <string>

#include "network/Packet.hpp"

namespace neon::security {

/// Why a sample was refused. Reported to the client as an error code and
/// counted per session, so a misbehaving client is visible in the logs.
enum class RejectReason {
    Accepted,
    StaleSequence,
    OutOfOrder,
    NonFinite,
    MovementTooFast,
    AimOutOfRange,
    RateLimited,
    NotInMatch,
};

const char* describe(RejectReason reason);

/// Limits applied to inbound intent.
struct ValidationLimits {
    /// Movement vectors are clamped to this length; 1.0 is a full stick.
    double maxMoveMagnitude = 1.05;
    /// Aim points further than this from the arena centre are clamped, so a
    /// client cannot aim off-map to fish for a hit.
    double maxAimDistance = 4000.0;
    /// Sequences at or below the last accepted one are replays.
    bool rejectStaleSequences = true;
    /** Reject rather than clamp an out-of-range aim point. */
    bool strictAim = false;
};

class ServerValidator {
public:
    void setLimits(const ValidationLimits& limits) { limits_ = limits; }
    const ValidationLimits& limits() const { return limits_; }

    /// Validates and normalises an inbound input message.
    ///
    /// On acceptance, `out` holds clamped values ready for the simulation and
    /// the session's sequence watermark is advanced. On rejection nothing is
    /// written, so a hostile client cannot poison the watermark.
    RejectReason validateInput(network::InboundMessage msg, uint64_t& lastSequence,
                               game::PlayerInput& out);

    /// Validates an ability request name.
    bool validateAbility(const std::string& name, game::AbilityKind& out) const;

    /// Sanitises a display name: strips control characters, clamps length.
    static std::string sanitiseName(const std::string& raw, size_t maxLength = 20);

    /// Validates a match mode string.
    static bool validMode(const std::string& mode);

    /// True when the client protocol version is supported.
    static bool supportedVersion(int version) { return version == 1; }

private:
    ValidationLimits limits_;
};

}  // namespace neon::security
