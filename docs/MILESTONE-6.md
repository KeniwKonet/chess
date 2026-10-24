# Milestone 6 report: authoritative multiplayer

**Goal (from the brief):** prepare authoritative multiplayer. The server owns the simulation; clients send intents only.

## What was implemented

**The protocol (`packages/match/src/protocol.ts`)**

- Plain JSON over WebSocket, version-checked:

  | Direction | Message | Purpose |
  | --- | --- | --- |
  | Client → server | `hello` | Join, optionally asking for a seat |
  | Client → server | `cmd` | A move, attack or stop order |
  | Client → server | `chess` | A War Table move |
  | Client → server | `ping` | Latency check |
  | Server → client | `welcome` | Your side, the room and the difficulty |
  | Server → client | `snap` | The state you're allowed to see, every tick |
  | Server → client | `ack` | Accepted or refused, with a reason |
  | Server → client | `pong` | Reply to `ping` |
  | Server → client | `full` | Both seats are taken |

- **Snapshots are filtered by fog of war.** Each player receives:
  - their own soldiers
  - only the enemy soldiers they can currently see
  - their fog grid, buildings, capture points and the War Table (position, move list, thinking time)
  - every 10 ticks, the `stateHash` of the full state

  A hacked client still can't reveal hidden soldiers, because the server never sends them.
- **`applySnapshot`** mirrors a snapshot into an ordinary local `Sim`, so the renderer, HUD and minimap work online unchanged.

**The server (`apps/server`, Node with `ws`)**

- **Rooms are created by name on first join:**
  - `?room=ashen&mode=ai&difficulty=warlord`: you are the Sun, against the server's Moon AI
  - `?room=duel&mode=pvp`: two humans, Sun and Moon
  - Empty rooms are closed.
- **The server is the only thing that advances the simulation,** at 10 Hz. Each tick it sends every seat its own snapshot.
- **Never trusting the client:**
  - The side on every order comes from the player's seat, not from the message. Orders for the other side's soldiers are ignored, even if the message claims to be that side.
  - Orders are shape-checked: finite coordinates, at most 64 integer ids, a valid target.
  - `effect` commands, which only the War Table may issue, are refused from clients.
  - War Table moves go through the same turn and legality checks as offline.
  - Rate limit: 20 messages per second; extra ones are refused with "Too many orders".
  - Messages are capped at 4 KB. Unparseable messages are dropped.
- **Replay log.** Every accepted message is logged with its tick. Replaying the log on a fresh room reproduces the exact same state hash, which is the basis for reconnects, replays and desync detection.

**The client (`apps/web/src/net/remote.ts`)**

- Open the game with `?server=ws://host:8787/?room=…` and the title button becomes "Join the online battle".
- **`RemoteMatch` has the same interface as the local `Match`.**
  - Orders and War Table moves are sent to the server, not applied locally.
  - Snapshots update a mirror sim; rendering interpolates between them.
  - A local copy of the War Table replays the server's move list, so piece identities, legal targets and hover descriptions work exactly as offline.
- The field log is rebuilt on the client: orders and refusals from acks; captures, destroyed buildings, deaths and War Table moves from changes between snapshots.
- Disconnects and full rooms are reported in the field log.

## What is functional

- **Single player against the server's AI works end to end in the browser.** It was traced message by message:
  - a right-click sent `cmd move` with the selected ids
  - the server acknowledged it
  - the soldiers marched in the next snapshots
- **Browser test against a real server process** (`apps/web/e2e/online.spec.ts`), which starts `apps/server` on its own port:
  - join from the title screen
  - right-click to march 8 infantry, and see "8 Infantry marching" and the soldiers moving
  - play d2–d4 on the War Table, and see the Advance effect logged once the server's board shows it
  - the server's Moon AI replies
  - no page errors
- **Two-player rooms** (`mode=pvp`) work in the automated tests with two real WebSocket clients. They haven't been played by two people on two machines.

## What remains mocked or incomplete

| Item | Status |
| --- | --- |
| Hosting | The server isn't deployed anywhere; it runs locally (`npx tsx apps/server/src/main.ts`). The hosted preview is single-player only. |
| Accounts and matchmaking | None. Anyone who knows a room name can join it; there are no passwords. |
| Reconnect | Not built. A dropped player's seat frees up, and the battle continues without them. The replay log makes it possible. |
| Online field log | The server sends state, not events, so the client rebuilds the log: orders from acks, and captures, ruins, deaths and War Table moves from snapshot changes. Arrivals and reinforcement lines are not reported online yet. |
| Bandwidth | Full snapshots, not deltas: about 6.9 KB per tick on average (12 KB at peak), so about 70 KB/s per player uncompressed. Fine on broadband; too much for mobile data. |
| Client prediction | None. Orders take one round trip before soldiers react. On a local network this is invisible; at 150 ms ping it is noticeable. |
| Lockstep option | Not used. The sim is deterministic (hash-tested), so lockstep is possible later if bandwidth matters more than cheat resistance. |

## Tests executed

**Server (`apps/server/test/server.test.ts`, 5 tests):**

- **Seating, ownership and fog.** Two real WebSocket clients join a pvp room. Each snapshot contains only that player's visible soldiers. The Moon's forged order for the Sun's soldiers, even claiming to be Sun, moves nobody; the Sun's own order moves exactly the 4 soldiers it named.
- **Refusals.** Effect injection and NaN coordinates are refused. Of 25 messages sent in one second (after 2 earlier ones), exactly 7 are refused; a new second gives a fresh allowance.
- **The War Table on the server.** An out-of-turn move is refused, a legal move is accepted, and a second move in a row is refused. The snapshot shows the effect.
- **Mirror accuracy.** A client mirror built from a snapshot matches the server's own soldiers to under 0.002 units, with identical fog, and contains only enemies the server says are visible.
- **Desync check.** A Warlord battle of 900 ticks, with orders and War Table moves, replayed from the log, gives the same `stateHash`.

**Bugs found and fixed:**

- A server test passed by accident (the soldiers had already arrived). It now checks the march order instead.
- The rate-limit test mixed in real time. It now uses explicit timestamps.

## Performance

- **Server cost:** 0.48 ms per tick per room, including building and serialising the snapshot. At 10 Hz, one core could host on the order of 100 rooms, before network overhead.
- **Snapshots:** 6.9 KB on average, 12 KB at peak. Next levers:
  - per-message deflate, likely to cut this 3–5×
  - delta snapshots
  - sending the fog grid only when it changes (it's about 650 bytes per tick now)

## Recommended next step

1. **Deploy the server**, behind TLS (`wss://`), and point a hosted build at it.
2. **Add reconnects:** use the replay log to restore a dropped player into their seat.
3. **Cut bandwidth:** deflate first (one option in `ws`), then delta snapshots.
4. **Then the deeper game:** the economy (gathering, training, building), cavalry for the knights, and balance tuning through playtests.
