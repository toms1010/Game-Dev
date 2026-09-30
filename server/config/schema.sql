-- Neon Vanguard persistence schema.
--
-- Applied automatically on boot when `database.auto_migrate` is true, and
-- idempotent, so it is safe to re-run. Kept in sync with the DDL compiled into
-- `src/database/Postgres.cpp` (`kSchemaSql`); this file is the readable copy
-- for review and for applying the schema by hand.
--
-- Design notes
-- ------------
-- * Only events worth keeping are written: account creation, match start and
--   completion, lifetime statistics, ranking changes. Nothing is written per
--   frame or per tick — the game thread never touches this database at all,
--   it hands results to a background writer.
-- * `players` is keyed by name because that is the identity a client
--   reconnects with. `bigserial` ids are internal and never sent to a client.

CREATE TABLE IF NOT EXISTS players (
    id             SERIAL PRIMARY KEY,
    name           VARCHAR(32) NOT NULL UNIQUE,
    auth_token     VARCHAR(64) NOT NULL DEFAULT '',
    total_score    BIGINT  NOT NULL DEFAULT 0,
    total_kills    BIGINT  NOT NULL DEFAULT 0,
    total_deaths   BIGINT  NOT NULL DEFAULT 0,
    total_waves    BIGINT  NOT NULL DEFAULT 0,
    best_score     BIGINT  NOT NULL DEFAULT 0,
    credits        BIGINT  NOT NULL DEFAULT 0,
    games_played   BIGINT  NOT NULL DEFAULT 0,
    last_seen      DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Leaderboard reads are "top N by best score", so index exactly that.
-- DESC matters: the default btree would need a backward scan otherwise.
CREATE INDEX IF NOT EXISTS players_best_score_idx ON players (best_score DESC);

CREATE TABLE IF NOT EXISTS matches (
    id            SERIAL PRIMARY KEY,
    -- The in-memory match id, which restarts at 1 on every process boot.
    -- Kept separate from the primary key so history survives a restart.
    match_uid     INTEGER NOT NULL,
    mode          VARCHAR(16) NOT NULL,
    started_at    DOUBLE PRECISION NOT NULL,
    duration      DOUBLE PRECISION NOT NULL,
    wave          INTEGER NOT NULL,
    player_count  INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS matches_created_idx ON matches (created_at DESC);

CREATE TABLE IF NOT EXISTS match_players (
    match_id      INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    player_name   VARCHAR(32) NOT NULL,
    score         BIGINT NOT NULL DEFAULT 0,
    kills         INTEGER NOT NULL DEFAULT 0,
    deaths        INTEGER NOT NULL DEFAULT 0,
    waves_cleared INTEGER NOT NULL DEFAULT 0,
    survived      BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (match_id, player_id)
);

CREATE INDEX IF NOT EXISTS match_players_player_idx ON match_players (player_id);
