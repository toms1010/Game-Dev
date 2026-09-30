#include "network/Packet.hpp"

#include <cmath>
#include <cstring>

#include "utils/Logger.hpp"

namespace neon::network {

double quantise1(double v) { return std::round(v * 10.0) / 10.0; }
double quantise2(double v) { return std::round(v * 100.0) / 100.0; }
double quantise3(double v) { return std::round(v * 1000.0) / 1000.0; }

namespace {

InboundMessage::Kind kindFromTag(const std::string& tag) {
    if (tag == kConnect) return InboundMessage::Kind::Connect;
    if (tag == kAuth) return InboundMessage::Kind::Auth;
    if (tag == kJoin) return InboundMessage::Kind::Join;
    if (tag == kLeave) return InboundMessage::Kind::Leave;
    if (tag == kInput) return InboundMessage::Kind::Input;
    if (tag == kAbility) return InboundMessage::Kind::Ability;
    if (tag == kPing) return InboundMessage::Kind::Ping;
    if (tag == kResync) return InboundMessage::Kind::Resync;
    return InboundMessage::Kind::Unknown;
}

std::string stringField(const json& j, const char* key, size_t maxLength = 256) {
    if (!j.contains(key) || !j[key].is_string()) return {};
    std::string value = j[key].get<std::string>();
    if (value.size() > maxLength) value.resize(maxLength);
    return value;
}

double numberField(const json& j, const char* key, double fallback = 0.0) {
    if (!j.contains(key) || !j[key].is_number()) return fallback;
    return j[key].get<double>();
}

uint64_t intField(const json& j, const char* key, uint64_t fallback = 0) {
    if (!j.contains(key) || !j[key].is_number()) return fallback;
    const double raw = j[key].get<double>();
    if (raw < 0.0 || !std::isfinite(raw)) return fallback;
    return static_cast<uint64_t>(raw);
}

}  // namespace

InboundMessage parseMessage(const std::string& raw) {
    InboundMessage message;

    json j;
    try {
        j = json::parse(raw);
    } catch (const std::exception& e) {
        NEON_DEBUG("packet: unparseable frame: ", e.what());
        return message;
    }
    if (!j.is_object() || !j.contains("t") || !j["t"].is_string()) return message;

    const std::string tag = j["t"].get<std::string>();
    message.kind = kindFromTag(tag);
    if (message.kind == InboundMessage::Kind::Unknown) return message;

    switch (message.kind) {
        case InboundMessage::Kind::Connect:
            message.version = static_cast<int>(intField(j, "v", 0));
            message.client = stringField(j, "client", 16);
            message.device = stringField(j, "device", 128);
            break;
        case InboundMessage::Kind::Auth:
            message.name = stringField(j, "name", 64);
            message.token = stringField(j, "token", 64);
            break;
        case InboundMessage::Kind::Join:
            message.mode = stringField(j, "mode", 16);
            break;
        case InboundMessage::Kind::Input:
            message.sequence = intField(j, "s", 0);
            message.clientTick = intField(j, "c", 0);
            message.moveX = numberField(j, "mx");
            message.moveY = numberField(j, "my");
            message.aimX = numberField(j, "ax");
            message.aimY = numberField(j, "ay");
            message.firing = j.contains("f") && j["f"].is_number() && j["f"].get<double>() != 0.0;
            break;
        case InboundMessage::Kind::Ability:
            message.sequence = intField(j, "s", 0);
            message.ability = stringField(j, "k", 16);
            break;
        case InboundMessage::Kind::Ping:
            message.pingId = intField(j, "i", 0);
            message.clientTick = intField(j, "c", 0);
            break;
        case InboundMessage::Kind::Resync:
            message.since = intField(j, "since", 0);
            break;
        case InboundMessage::Kind::Leave:
        case InboundMessage::Kind::Unknown:
            break;
    }
    return message;
}

std::vector<double> encodePlayer(const Player& player, double nowSeconds) {
    return {
        static_cast<double>(player.id()),
        quantise1(player.position().x),
        quantise1(player.position().y),
        quantise1(player.velocity().x),
        quantise1(player.velocity().y),
        quantise3(player.angle()),
        std::round(player.hp()),
        std::round(player.maxHp()),
        static_cast<double>(player.flags(nowSeconds)),
    };
}

std::vector<double> encodeEnemy(const Enemy& enemy) {
    return {
        static_cast<double>(enemy.id),
        static_cast<double>(static_cast<int>(enemy.kind)),
        quantise1(enemy.position.x),
        quantise1(enemy.position.y),
        quantise1(enemy.radius),
        std::round(enemy.hp),
        quantise3(enemy.angle),
    };
}

json makeWelcome(uint32_t playerId, uint64_t tick, int tickRate, const Arena& arena) {
    return json{{"t", kWelcome},
                {"id", playerId},
                {"tick", tick},
                {"rate", tickRate},
                {"aw", quantise1(arena.width())},
                {"ah", quantise1(arena.height())}};
}

json makeAuthOk(uint32_t playerId, const std::string& name) {
    return json{{"t", kAuthOk}, {"id", playerId}, {"name", name}};
}

json makeJoined(uint32_t matchId, const std::string& mode,
                const std::vector<std::pair<uint32_t, std::string>>& roster) {
    json players = json::array();
    for (const auto& [id, name] : roster) {
        players.push_back(json{{"id", id}, {"name", name}});
    }
    return json{{"t", kJoined}, {"match", std::to_string(matchId)}, {"roster", std::move(players)},
                {"mode", mode}};
}

json makeSnapshot(uint64_t tick, uint64_t ack, const GameState& state, double nowSeconds) {
    json players = json::array();
    for (const auto& holder : state.players()) {
        players.push_back(encodePlayer(*holder, nowSeconds));
    }
    json enemies = json::array();
    for (const Enemy& e : state.enemyField().items()) {
        if (e.dead) continue;
        enemies.push_back(encodeEnemy(e));
    }
    return json{{"t", kSnap},   {"k", tick},   {"a", ack},
                {"p", std::move(players)}, {"e", std::move(enemies)}};
}

json makeEvent(const std::string& kind, uint32_t id, double value) {
    return json{{"t", kEvent}, {"e", kind}, {"id", id}, {"v", quantise1(value)}};
}

json makePong(uint64_t pingId, uint64_t clientTick, uint64_t serverTick) {
    return json{{"t", kPong}, {"i", pingId}, {"c", clientTick}, {"k", serverTick}};
}

json makeError(int code, const std::string& message) {
    return json{{"t", kError}, {"code", code}, {"m", message}};
}

std::string serialise(const json& message) { return message.dump(); }

}  // namespace neon::network
