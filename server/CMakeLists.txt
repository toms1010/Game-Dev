cmake_minimum_required(VERSION 3.20)

project(neon_vanguard_server
        VERSION 0.1.0
        DESCRIPTION "Neon Vanguard authoritative game server"
        LANGUAGES CXX)

# ---------------------------------------------------------------------------
# Language standard
# ---------------------------------------------------------------------------
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
  set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS Debug Release RelWithDebInfo)
endif()

set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(THREADS_PREFER_PTHREAD_FLAG ON)

option(NEON_BUILD_TESTS "Build the test suite" ON)
option(NEON_ENABLE_ASAN "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
option(NEON_WERROR "Treat warnings as errors" OFF)

# ---------------------------------------------------------------------------
# Warnings
# ---------------------------------------------------------------------------
add_library(neon_warnings INTERFACE)
if(MSVC)
  target_compile_options(neon_warnings INTERFACE /W4 /permissive-)
  if(NEON_WERROR)
    target_compile_options(neon_warnings INTERFACE /WX)
  endif()
else()
  target_compile_options(neon_warnings INTERFACE
    -Wall -Wextra -Wpedantic
    -Wshadow -Wconversion -Wsign-conversion
    -Wnon-virtual-dtor -Wold-style-cast -Wcast-align
    -Wunused -Woverloaded-virtual -Wdouble-promotion
    -Wformat=2)
  if(NEON_WERROR)
    target_compile_options(neon_warnings INTERFACE -Werror)
  endif()
endif()

if(NEON_ENABLE_ASAN AND NOT MSVC)
  target_compile_options(neon_warnings INTERFACE -fsanitize=address,undefined -fno-omit-frame-pointer)
  target_link_options(neon_warnings INTERFACE -fsanitize=address,undefined)
endif()

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
find_package(Threads REQUIRED)

# Boost: Asio + Beast are header-only in every supported release; Boost.System
# has been header-only since 1.69. Headers only means no link-time surprises
# and no ABI coupling to the system Boost.
find_package(Boost 1.74 REQUIRED)
message(STATUS "Boost ${Boost_VERSION} headers at ${Boost_INCLUDE_DIRS}")

# libpq is deliberately NOT linked. `database/Postgres.cpp` resolves it with
# dlopen at runtime, so the server builds and runs on a machine that has no
# PostgreSQL client library at all and simply runs in-memory instead.
find_library(NEON_LIBPQ_LIBRARY NAMES pq libpq.so.5 libpq.5
             HINTS /usr/lib /usr/local/lib /usr/lib/x86_64-linux-gnu)
if(NEON_LIBPQ_LIBRARY)
  message(STATUS "libpq present at ${NEON_LIBPQ_LIBRARY} (loaded at runtime via dlopen)")
else()
  message(STATUS "libpq not found: persistence will be disabled unless the library is installed at runtime")
endif()

# nlohmann/json: vendored single header, so there is nothing to install.
set(NEON_JSON_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/third_party")
if(NOT EXISTS "${NEON_JSON_INCLUDE}/nlohmann/json.hpp")
  message(FATAL_ERROR
    "third_party/nlohmann/json.hpp is missing. Run: "
    "curl -L -o third_party/nlohmann/json.hpp "
    "https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp")
endif()
message(STATUS "nlohmann/json (vendored) at ${NEON_JSON_INCLUDE}")

# ---------------------------------------------------------------------------
# Core library
# ---------------------------------------------------------------------------
set(NEON_SOURCES
  src/core/Config.cpp
  src/core/GameLoop.cpp
  src/core/GameServer.cpp
  src/core/Server.cpp
  src/database/PlayerRepository.cpp
  src/database/Postgres.cpp
  src/game/Arena.cpp
  src/game/Collision.cpp
  src/game/Enemy.cpp
  src/game/GameState.cpp
  src/game/Match.cpp
  src/game/Movement.cpp
  src/game/Player.cpp
  src/game/Projectile.cpp
  src/game/Weapon.cpp
  src/matchmaking/Matchmaker.cpp
  src/network/Packet.cpp
  src/network/WebSocketServer.cpp
  src/security/RateLimiter.cpp
  src/security/ServerValidator.cpp
  src/utils/Logger.cpp
  src/utils/Timer.cpp
)

add_library(neon_core STATIC ${NEON_SOURCES})

target_include_directories(neon_core PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
  "${NEON_JSON_INCLUDE}"
  ${Boost_INCLUDE_DIRS}
)

target_link_libraries(neon_core
  PUBLIC
    Threads::Threads
  PRIVATE
    neon_warnings
    ${CMAKE_DL_LIBS}
)

# ---------------------------------------------------------------------------
# Executable
# ---------------------------------------------------------------------------
add_executable(neon_vanguard_server src/main.cpp)
target_link_libraries(neon_vanguard_server PRIVATE neon_core neon_warnings)

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
if(NEON_BUILD_TESTS)
  enable_testing()

  add_library(neon_testing INTERFACE)
  target_include_directories(neon_testing INTERFACE "${CMAKE_CURRENT_SOURCE_DIR}/tests")
  target_link_libraries(neon_testing INTERFACE neon_core neon_warnings)

  # One binary per area, so a failure names the area it came from and the
  # suites can be run in parallel under ctest.
  set(NEON_TEST_SUITES
    test_game
    test_network
    test_security
    test_performance
  )

  foreach(suite ${NEON_TEST_SUITES})
    add_executable(${suite} "tests/${suite}.cpp")
    target_link_libraries(${suite} PRIVATE neon_testing)
    add_test(NAME ${suite} COMMAND ${suite})
    # The performance suite measures per-step cost, so it must not share a
    # machine with the others while ctest runs them in parallel.
    if(suite STREQUAL test_performance)
      set_tests_properties(${suite} PROPERTIES RUN_SERIAL TRUE TIMEOUT 120)
    else()
      set_tests_properties(${suite} PROPERTIES TIMEOUT 60)
    endif()
  endforeach()
endif()

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
include(GNUInstallDirs)
install(TARGETS neon_vanguard_server RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(DIRECTORY config/ DESTINATION ${CMAKE_INSTALL_DATADIR}/neon-server/config
        FILES_MATCHING PATTERN "*.json")
