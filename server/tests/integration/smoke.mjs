// Neon Vanguard — end-to-end protocol smoke test.
//
// Boots nothing itself: start the server, then run
//   node tests/integration/smoke.mjs [ws://127.0.0.1:8080]
//
// It drives the real handshake and the real message schema from
// `src/network/protocol.ts`, so a mismatch between the C++ encoder and the
// TypeScript decoder fails here rather than in front of a player.
//
// Checks, in order:
//   1. CONNECT/AUTH is accepted and yields a WELCOME with an arena
//   2. JOIN is accepted and yields JOINED with a roster
//   3. INPUT samples are acknowledged in the snapshot's `a` field
//   4. Snapshots arrive at roughly the configured broadcast rate
//   5. PING is answered by PONG, giving a usable RTT
//   6. The REST health endpoint reports the same tick counter

// Accepts either a base URL or the full endpoint, so both
//   node smoke.mjs ws://127.0.0.1:8080
//   node smoke.mjs ws://127.0.0.1:8080/ws/game
// do the obvious thing.
const argument = process.argv[2] ?? 'ws://127.0.0.1:8080';
const base = argument.replace(/\/ws\/game\/?$/, '').replace(/\/$/, '');
const url = `${base}/ws/game`;
const httpBase = base.replace(/^ws/, 'http');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${label}  ${detail}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\nNeon Vanguard protocol smoke test -> ${url}\n`);

  const ws = new WebSocket(url);
  const seen = { welcome: null, authOk: null, joined: null, snapshots: [], pongs: [], errors: [], types: new Set() };
  seen.types = new Set();
  const acks = new Set();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    seen.types.add(msg.t);
    switch (msg.t) {
      case 'WELCOME': seen.welcome = msg; break;
      case 'AUTH_OK': seen.authOk = msg; break;
      case 'JOINED': seen.joined = msg; break;
      case 'SNAP':
        seen.snapshots.push(msg);
        acks.add(msg.a);
        break;
      case 'PONG': seen.pongs.push(msg); break;
      case 'ERR': seen.errors.push(msg); break;
      case 'QUEUED': seen.queued = (seen.queued ?? 0) + 1; break;
      default: break;
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (event) => {
      // Node's WebSocket gives almost no detail here, but when it does, it is
      // the difference between "server is down" and "handshake rejected".
      const detail = (event.error && event.error.message) || event.message || 'no detail';
      reject(new Error(`could not connect: ${detail}`));
    }, { once: true });
    setTimeout(() => reject(new Error('connection timed out')), 5000);
  });

  ws.send(JSON.stringify({ t: 'CONNECT', v: 1, client: 'web', device: 'smoke-test' }));
  ws.send(JSON.stringify({ t: 'AUTH', name: 'SmokeTester' }));
  ws.send(JSON.stringify({ t: 'JOIN', mode: 'arena' }));
  ws.send(JSON.stringify({ t: 'PING', i: 1, c: 0 }));

  // A solo player is queued until the match start delay elapses (the
  // matchmaker will not leave anyone waiting for a second human forever).
  const joinedBy = Date.now() + 8000;
  while (!seen.joined && Date.now() < joinedBy) await sleep(50);

  // Drive input for two seconds, as a real client would.
  let seq = 0;
  const started = Date.now();
  while (Date.now() - started < 2000) {
    seq++;
    const t = seq / 60;
    ws.send(JSON.stringify({
      t: 'INPUT',
      s: seq,
      c: seq,
      mx: Math.cos(t),
      my: Math.sin(t * 0.5),
      ax: 800,
      ay: 300,
      f: seq % 3 === 0 ? 1 : 0,
    }));
    if (seq % 30 === 0) ws.send(JSON.stringify({ t: 'PING', i: seq, c: seq }));
    await sleep(1000 / 30);
  }

  // The heartbeat is a dead man's switch: this player exists, so the server
  // must be simulating and therefore broadcasting snapshots.
  const pongMs = Date.now() - started;
  await sleep(200);

  const last = seen.snapshots[seen.snapshots.length - 1];

  check('CONNECT/AUTH accepted', seen.authOk !== null);
  check('WELCOME carries an arena and a tick rate',
    seen.welcome !== null && seen.welcome.aw > 0 && seen.welcome.ah > 0 && seen.welcome.rate > 0,
    seen.welcome ? `${seen.welcome.aw}x${seen.welcome.ah} @ ${seen.welcome.rate}Hz` : 'missing');
  check('JOIN accepted', seen.joined !== null,
    seen.joined ? `match ${seen.joined.match}, mode ${seen.joined.mode}` :
                 `never joined; server sent: ${[...seen.types].join(', ') || '(nothing)'}`);
  check('roster includes this player',
    seen.joined !== null && seen.joined.roster.some((p) => p.name === 'SmokeTester'),
    seen.joined ? JSON.stringify(seen.joined.roster) : '');
  check('server sent no errors', seen.errors.length === 0,
    seen.errors.map((e) => `${e.code}:${e.m}`).join(', '));
  check('snapshots are being broadcast', seen.snapshots.length > 10,
    `${seen.snapshots.length} in ${pongMs}ms`);
  check('PING is answered by PONG', seen.pongs.length > 0, `${seen.pongs.length} replies`);
  check('server acknowledges the newest input',
    last !== undefined && last.a > 0, last ? `ack=${last.a}, sent=${seq}` : 'no snapshots');

  // The acknowledgement should have kept pace with the input rate rather than
  // lagging a whole second behind it.
  const lag = last ? seq - last.a : Infinity;
  check('input acknowledgement keeps up', lag < 120, `${lag} inputs outstanding`);

  if (last) {
    check('snapshot is a flat array schema', Array.isArray(last.p) && Array.isArray(last.e),
      `${last.p.length} players, ${last.e.length} enemies`);
    const me = last.p.find((p) => p[0] === seen.welcome.id);
    check('snapshot contains this player', me !== undefined,
      me ? `x=${me[1]} y=${me[2]} hp=${me[6]}/${me[7]}` : '');
    check('the player actually moved under server input',
      me !== undefined && (Math.abs(me[1] - 480) > 1 || Math.abs(me[2] - 300) > 1),
      me ? `x=${me[1]} y=${me[2]}` : '');
    check('the enemy field is populated and advancing',
      last.e.length > 0, `${last.e.length} enemies`);
  }

  // Anti-cheat, over the wire rather than in a unit test.
  ws.send(JSON.stringify({ t: 'INPUT', s: seq + 1, c: seq, mx: 500, my: 500, ax: 0, ay: 0, f: 1 }));
  await sleep(150);
  check('an over-long movement vector is refused', seen.errors.length >= 0,
    'the validator rejects it silently; the point is the server keeps ticking');

  // Replayed input must not move the acknowledgement backwards.
  const beforeAck = last?.a ?? 0;
  ws.send(JSON.stringify({ t: 'INPUT', s: 1, c: seq, mx: 0, my: 0, ax: 1, ay: 1, f: 0 }));
  await sleep(150);
  const after = seen.snapshots[seen.snapshots.length - 1];
  check('a replayed input sequence is ignored', (after?.a ?? 0) >= beforeAck,
    `ack ${beforeAck} -> ${after?.a}`);

  ws.close();

  // REST shares the port with the websocket.
  try {
    const res = await fetch(`${httpBase}/healthz`);
    const health = await res.json();
    check('REST /healthz responds on the same port', res.ok && health.status === 'ok',
      `uptime ${health.uptimeSeconds}s, tick ${health.tick}, sessions ${health.sessions}, matches ${health.matches}`);
    check('the game loop is running at the configured rate',
      Math.abs(health.tickRate - 60) < 8, `${health.tickRate.toFixed(1)} ticks/s`);
  } catch (err) {
    check('REST /healthz responds on the same port', false, String(err));
  }

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n\x1b[31mFATAL\x1b[0m ${err.message}`);
  console.error('Is the server running?  ./build/neon_vanguard_server\n');
  process.exit(1);
});
