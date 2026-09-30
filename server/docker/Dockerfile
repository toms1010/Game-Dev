# Neon Vanguard game server.
#
# Two stages so the runtime image carries no toolchain, no headers and no
# package manager — it is the built binary plus the shared libraries it needs.

# ---------------------------------------------------------------------------
# Stage 1: build
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        ninja-build \
        libboost-dev \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY CMakeLists.txt ./
COPY include ./include
COPY src ./src
COPY tests ./tests
# nlohmann/json is vendored, so the build needs no package for it.
COPY third_party ./third_party

RUN cmake -S . -B build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DNEON_BUILD_TESTS=ON \
    && cmake --build build --parallel \
    && ctest --test-dir build --output-on-failure

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# libpq is optional: the server loads it with dlopen and runs in memory when
# it is absent, so this is the difference between persistence and no
# persistence rather than between starting and not starting. curl is here for
# health checks.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libboost1.74-dev \
        libpq5 \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Run unprivileged. The server binds 8080, which needs no privilege.
RUN useradd --system --create-home --uid 10001 neon
WORKDIR /app

COPY --from=build /src/build/neon_vanguard_server /usr/local/bin/
COPY config ./config

RUN chown -R neon:neon /app
USER neon

EXPOSE 8080

ENV NEON_CONFIG=/app/config/server.json \
    NEON_HOST=0.0.0.0 \
    NEON_PORT=8080 \
    NEON_LOG_LEVEL=info

# The container is healthy when the game loop is actually ticking, not merely
# when the port is open.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${NEON_PORT}/healthz" | grep -q '"status":"ok"' || exit 1

# exec form, so SIGTERM from `docker stop` reaches the server and it shuts
# down gracefully instead of being killed mid-tick.
ENTRYPOINT ["/usr/local/bin/neon_vanguard_server"]
