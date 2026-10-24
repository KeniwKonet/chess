# Chess Realms

A stylised isometric 3D real-time war game in the browser. Two kingdoms, Sun and Moon, fight over a living battlefield. A chessboard, the War Table, commands the same war: every chess move has an effect on the battle, and checkmate wins it.

This repository is at **milestone 6**. You can play a whole battle against the Moon AI, on the battlefield and on the War Table at once, in single player or against an authoritative server:

- a 3D battlefield with animated soldiers that march, fight and die
- capture points, towers, castles, reinforcements and fog of war
- a Moon commander that musters, attacks, defends and retreats
- a War Table bound to the army by documented rules
- menus and a battle report
- an authoritative WebSocket server

**Reports**, each saying exactly what works and what does not: [1 battlefield](docs/MILESTONE-1.md), [2 units](docs/MILESTONE-2.md), [3 combat and AI](docs/MILESTONE-3.md), [4 menus and match flow](docs/MILESTONE-4.md), [5 War Table](docs/MILESTONE-5.md), [6 multiplayer](docs/MILESTONE-6.md).

**Rules:** [how the War Table commands the battlefield](docs/RULES.md).

## Run it

```bash
pnpm install
pnpm dev          # http://localhost:5173 (single player)
pnpm test         # unit tests (Vitest)
pnpm build        # production build in apps/web/dist
npx playwright test   # browser tests (builds and serves the app first)
```

You need Node 20 or later and pnpm 10.

### Online (authoritative server)

```bash
npx tsx apps/server/src/main.ts      # ws://localhost:8787 (PORT=… to change)
```

Then open the game with a `server` parameter (the inner `?` and `&` are URL-encoded):

```
http://localhost:5173/?server=ws://localhost:8787/%3Froom%3Dashen%26mode%3Dai%26difficulty%3Dcaptain
http://localhost:5173/?server=ws://localhost:8787/%3Froom%3Dduel%26mode%3Dpvp     # two players, two browsers
```

## Layout

```
apps/web/            React + Vite client
  src/world/         3D scene: terrain chunks, buildings, sea, markers, fog of war shader
  src/camera/        RTS camera maths (rts.ts, pure + tested) and input (CameraRig.tsx)
  src/hud/           HUD, menus (title, pause, settings, battle report) and the War Table board
  src/assets/        Model kit loader, chunk merging, LOD
  src/units/         Soldiers: animation baking, instanced rendering, tokens, health bars, arrows
  src/sim/runner.ts  Runs a Match at 10 Hz in the browser (or mirrors the server); input becomes commands
  src/net/           Online client: snapshots into a mirror sim, orders to the server
  e2e/               Playwright tests (offline and online)
apps/server/         Authoritative WebSocket server: rooms, seats, validation, rate limits, replay log
packages/game-core/  Pure TypeScript: hex grid, map, simulation (movement, combat, capture, fog,
                     reinforcements, victory), state hash, Moon commander and patrol AI
packages/chess-core/ Standard chess via chess.js, plus the separate bonds layer (piece → regiment)
packages/match/      One battle: sim + AI + War Table (bond rules, chess AI) + network protocol
tools/               Asset packing, map printout, perf matrix, screenshots
docs/                Milestone reports, rules, asset licences
```

## Principles

- **The simulation lives outside React.** `game-core` and `match` are plain TypeScript that runs the same on the server, in the browser and in tests. It is deterministic, and the tests check that with state hashes.
- **Standard chess stays standard.** `chess-core` only wraps chess.js. The battlefield effects of chess moves are a separate, documented layer ([RULES.md](docs/RULES.md)) that never changes legality.
- **The server owns the truth online.** Clients send intents; the server stamps them with the sender's side, validates them, and sends each player only what their soldiers can see.
- **Nothing pretends.** Readouts that are not simulated yet (resources) say so, and each report lists what is mocked.

## Assets

Models are from the KayKit Medieval Hexagon Pack and Adventurers Character Pack by Kay Lousberg, both CC0. See [docs/ASSETS.md](docs/ASSETS.md).
