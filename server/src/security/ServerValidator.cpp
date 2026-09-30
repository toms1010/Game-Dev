#include "security/ServerValidator.hpp"

#include <cmath>
#include <cstdio>

#include "game/Vec.hpp"

namespace neon::security {

const char* describe(RejectReason reason) {
    switch (reason) {
        case RejectReason::Accepted: return "accepted";
        case RejectReason::StaleSequence: return "stale input sequence (replay or reorder)";
        case RejectReason::OutOfOrder: return "input sequence went backwards";
        case RejectReason::NonFinite: return "input contained NaN or infinity";
        case RejectReason::MovementTooFast: return "movement vector exceeded the limit";
        case RejectReason::AimOutOfRange: return "aim point was outside the arena";
        case RejectReason::RateLimited: return "input rate exceeded the limit";
        case RejectReason::NotInMatch: return "session is not in a match";
    }
    return "unknown";
}

RejectReason ServerValidator::validateInput(network::InboundMessage msg, uint64_t& lastSequence,
                                            game::PlayerInput& out) {
    // A NaN or infinite value is never a legitimate sample. Rejecting here,
    // before anything touches the integrator, is what stops a single hostile
    // frame from poisoning a position for good.
    if (!std::isfinite(msg.moveX) || !std::isfinite(msg.moveY) || !std::isfinite(msg.aimX) ||
        !std::isfinite(msg.aimY)) {
        return RejectReason::NonFinite;
    }

    if (msg.sequence == 0) return RejectReason::StaleSequence;
    if (limits_.rejectStaleSequences && msg.sequence <= lastSequence) {
        // Equal or lower than the watermark: a duplicate or a reordered frame.
        return msg.sequence < lastSequence ? RejectReason::OutOfOrder : RejectReason::StaleSequence;
    }

    const double moveMag = std::sqrt(msg.moveX * msg.moveX + msg.moveY * msg.moveY);
    if (moveMag > limits_.maxMoveMagnitude) return RejectReason::MovementTooFast;

    const double aimDist = std::sqrt(msg.aimX * msg.aimX + msg.aimY * msg.aimY);
    if (aimDist > limits_.maxAimDistance) {
        if (limits_.strictAim) return RejectReason::AimOutOfRange;
        // Clamp rather than reject: a stale aim is not worth dropping input for.
        const double scale = limits_.maxAimDistance / aimDist;
        msg.aimX *= scale;
        msg.aimY *= scale;
    }

    out.sequence = msg.sequence;
    out.move = {msg.moveX, msg.moveY};
    out.aim = {msg.aimX, msg.aimY};
    out.firing = msg.firing;
    out.valid = true;
    lastSequence = msg.sequence;
    return RejectReason::Accepted;
}

bool ServerValidator::validateAbility(const std::string& name, game::AbilityKind& out) const {
    if (name == "dash") {
        out = game::AbilityKind::Dash;
        return true;
    }
    if (name == "bomb") {
        out = game::AbilityKind::Bomb;
        return true;
    }
    return false;
}

std::string ServerValidator::sanitiseName(const std::string& raw, size_t maxLength) {
    std::string out;
    out.reserve(std::min(raw.size(), maxLength));

    // These are all three-byte sequences (U+200B..U+200F, U+202A..U+202E) or
    // the three-byte BOM (U+FEFF). Comparing raw bytes against the code point
    // would never match, because a multi-byte character is never equal to a
    // single byte value.
    const auto isBidiOrZeroWidth = [](unsigned char lead, unsigned char mid,
                                      unsigned char tail) -> bool {
        if (lead != 0xe2 || mid != 0x80) return false;
        // ZWSP, ZWNJ, ZWJ, LRM, RLM, LRE, RLE, PDF, LRO, RLO
        return (tail >= 0x8b && tail <= 0x8f) || (tail >= 0xaa && tail <= 0xae);
    };

    // State of an in-progress escape sequence:
    //   0 = none, 1 = just saw ESC, 2 = inside the body of "ESC [ ... final".
    int csi = 0;
    std::size_t index = 0;
    const std::size_t size = raw.size();
    while (index < size) {
        const unsigned char c = static_cast<unsigned char>(raw[index]);
        // Multi-byte characters that must be dropped whole.
        if (index + 2 < size && isBidiOrZeroWidth(c, static_cast<unsigned char>(raw[index + 1]),
                                                  static_cast<unsigned char>(raw[index + 2]))) {
            index += 3;
            continue;
        }
        if (index + 2 < size && c == 0xef && static_cast<unsigned char>(raw[index + 1]) == 0xbb &&
            static_cast<unsigned char>(raw[index + 2]) == 0xbf) {
            index += 3;  // BOM
            continue;
        }
        ++index;

        // Strip control characters, including the escape sequences that would
        // otherwise let a name repaint a terminal or forge a log line.
        if (c == 0x1b) {
            // ESC begins a control sequence. The bracketed body that follows
            // ("[31m") is the part that actually renders, so it goes too.
            csi = 1;
            continue;
        }
        if (csi == 1) {
            csi = 2;  // the introducer, e.g. '['
            continue;
        }
        if (csi == 2) {
            // A CSI sequence ends at the first final byte in 0x40-0x7e.
            if (c >= 0x40 && c <= 0x7e) csi = 0;
            continue;
        }
        if (c < 0x20 || c == 0x7f) continue;
        out.push_back(static_cast<char>(c));
        if (out.size() >= maxLength) break;
    }

    // Collapse runs of whitespace and trim.
    std::string collapsed;
    collapsed.reserve(out.size());
    bool previousSpace = true;  // trims the leading run
    for (char c : out) {
        const bool isSpace = (c == ' ' || c == '\t');
        if (isSpace) {
            if (!previousSpace) collapsed.push_back(' ');
            previousSpace = true;
        } else {
            collapsed.push_back(c);
            previousSpace = false;
        }
    }
    while (!collapsed.empty() && collapsed.back() == ' ') collapsed.pop_back();
    return collapsed;
}

bool ServerValidator::validMode(const std::string& mode) {
    return mode == "arena" || mode == "coop";
}

}  // namespace neon::security
