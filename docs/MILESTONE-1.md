# Milestone 1 report: the 3D battlefield

**Goal (from the brief):** render a polished 3D battlefield with terrain, buildings, lighting and a working camera.

**Starting point:** there was no code repository. The existing work was the v2 design prototype (the `.dc.html` design canvas) and the player guide. This milestone reuses that prototype's:

- map geography and place names
- building roster and starting values
- brand colours, fonts and HUD style

It is a new codebase; nothing working was deleted.

Milestone 0 (project setup) is folded into this report.

## What was implemented

**Project skeleton**

- A pnpm monorepo, with these parts:

  | Part | Contents |
  | --- | --- |
  | `apps/web` | React 19, Vite 8, three.js 0.186, React Three Fiber 9 |
  | `packages/game-core` | Pure TypeScript |
  | `packages/chess-core` | chess.js 1.4 |

- TypeScript strict mode, Vitest and Playwright.

**The map: "The Ashen Divide"**

- An island of 656 hex tiles, built deterministically from a seed by `game-core`.
- Same geography as the v2 prototype:
  - Sunspire in the west, Nocturne in the east.
  - A river between them, crossable only at the North Bridge, the Ford of Ash and the South Bridge.
  - Vey Watchtower on the east-bank hills and the Old Mill on the west bank.
  - The Western Wood and Ashgrove forests, plus mountains, hills, fields and scattered rocks and trees.
- Three roads link the capitals, one through each crossing. Rivers and roads are auto-tiled, and every tile matches the art exactly (tested).

**Buildings**

- All 32 buildings from the v2 roster, in faction colours, each facing its nearest road.
- Damaged buildings carry their v2 starting values:
  - North Watchtower: 220 / 500
  - Moon South Tower: 180 / 500
  - Ford Palisade: under construction at 38%
  - Moon outpost: in ruins
- Capture rings mark Vey Watchtower (Moon), the Old Mill (Sun) and the Ford of Ash (contested).

**Look**

- KayKit CC0 models, with the grass shifted greener.
- Warm sun with shadows, a sky fill light and ACES tone mapping.
- A stylised sea with an animated surf line that follows the real coastline.
- Swaying trees, turning windmills and watermill, and sweeping catapult turrets.

**Camera**

- Smooth eased RTS camera:
  - Pan by grab-drag, WASD or arrow keys, minimap click/drag, or optional edge panning.
  - Zoom toward the pointer by wheel, pinch or +/−.
  - Rotate by middle-drag, Shift-drag, two-finger twist, Q/E or on-screen buttons.
- Pitch rises as you zoom out, for a strategic overview, and lowers as you zoom in, for detail.
- The camera stays within the map. Portrait screens get a wider field of view.
- Shortcuts:

  | Key | Action |
  | --- | --- |
  | H | Sunspire |
  | O | Overview |
  | N | Face north |
  | F | Focus the selection |
  | Double-click | Focus the selection |

- An intro fly-in from the overview down to Sunspire.

**Selection and inspection**

- Hover highlight and click to select, with picking done in maths: buildings as cylinders, ground as hexes. No GPU picking.
- A building panel shows owner, type, location, structure and construction progress.
- A tile panel shows terrain, location and the real movement cost that pathfinding will use.

**HUD**

- Resource bar, toolbar, minimap with live view footprint and compass, field log, controls help, stats panel, and a quality switch (Low / Medium / High).
- Labels for places and capture points, plus health bars, positioned each frame without React re-renders.

**Fallbacks**

- If `kit.glb` fails to load, the same map draws from simple shapes, with a message in the field log. Camera, minimap and inspection keep working.

## What is functional

Everything listed above works with real input, on desktop and touch. The only data in play is the scenario's starting state from `game-core`.

## What remains mocked or incomplete

| Item | Status |
| --- | --- |
| Resources (820 gold, 640 food, 510 wood, 230 iron) | Static starting values, labelled "not yet simulated". Economy arrives in milestone 3. |
| Structure, ownership, construction % | Static scenario values. Nothing ticks, so nothing changes. |
| Train / Upgrade buttons | Shown locked, tagged M3. |
| War Table | Button shown locked, tagged M5. |
| Field log | Logs your real actions this session (selection, camera jumps, quality). No battle events exist yet. |
| Units, pathfinding, combat, AI | Not started (milestones 2–3). Movement costs are defined and tested. |
| Castle walls | Wall models are packed but not placed. |
| Stables model | The tavern stands in; no CC0 stables model exists in the packs (see ASSETS.md). |
| Menus, sign-in, deployment screens from the v2 design | Not ported yet (milestone 4). |
| Multiplayer | Not started (milestone 6). |

## Tests executed

**Unit tests: `pnpm test` (Vitest), 30 passed, 0 failed**

| Area | What the tests cover |
| --- | --- |
| Hex grid (4) | world ↔ hex round trips over the whole map; neighbour distance and angle; points inside a tile map to it; lines are connected and unique |
| Auto-tiling (4) | every 2-connection shape matched exactly; road dead ends; mask rotation; coverage of 3+ connection shapes |
| Map (8) | deterministic per seed; two castles far apart; every building on its own land tile; river crossed only at 2 bridges and 1 ford, all on straight tiles; capitals connected by land only through the crossings (removing them cuts the banks apart); every river and road tile an exact art match; every road edge leads somewhere; v2 place names kept |
| Camera (8) | pitch rises with zoom; eye position and distance; screen-relative pan at any rotation; zoom toward the cursor and its limits; clamping to the map; frame-rate-independent easing; shortest-way rotation; ray–ground intersection |
| Standard chess (6) | 20 opening moves; illegal moves rejected without side effects; checkmate; castling, en passant, promotion; stalemate and insufficient material; threefold repetition |

**Browser tests: `npx playwright test` (Chromium, software WebGL), 6 passed, 0 failed**

| Test | What it checks |
| --- | --- |
| Loads | Loads with HUD, minimap and log, no script errors, world drawn |
| Building selection | Clicking a building selects it (panel shows Barracks, 700/700, log entry); Esc clears |
| Tile inspection | Clicking the Ford of Ash shows "Ford" with movement cost 2.5 |
| Camera input | Drag pans the right way; wheel zooms in; held Q rotates; O and H jump |
| Minimap | Clicking the minimap moves the camera there |
| Quality | Low drops the shadow pass and reduces draw calls |

**A bug the tests caught:** keyboard rotation only advanced on rendered frames, so slow devices lost quick key presses. Held keys are now integrated by wall-clock time.

## Performance

Measured with `tools/perf-matrix.mjs` at 1440×900 in software WebGL. Draw calls and triangles do not depend on the GPU, so they are exact. Frame rate could not be measured here: there is no GPU in this environment.

| Quality | View | Draw calls | Triangles | Budget (from plan) |
| --- | --- | --- | --- | --- |
| High (desktop) | Full map | 86 | 373k | under 150 / under 400k: **inside** |
| High | Close, Sunspire | 40 | 226k | inside |
| Medium (mobile default) | Full map, max zoom-out | 59 | 179k | under 80 / under 150k: **calls inside, triangles 20% over** |
| Medium | Close, Sunspire | 13 | 72k | inside |
| Low | Same as Medium, plus no shadows, no anti-aliasing, pixel ratio 1 | | | |

Other budget items:

| Item | Measured | Budget |
| --- | --- | --- |
| Shadow map | 2048 (High), 1024 drawn once (Medium) | 2048 / 1024: inside |
| Texture | One 512 px atlas | Inside |
| Download | About 3 MB total: JS 1.26 MB (350 KB gzipped) + kit 1.6 MB | Under 10 MB: inside |
| JS heap | 27–41 MB | No budget set |

**How the numbers came down.** The first build drew 142 calls and 427k triangles on High, and 90 calls and 250k triangles on Medium. Three changes fixed that:

- Static scenery is merged into 16-unit map chunks: ground, solids and foliage. Off-screen chunks are culled.
- Medium and Low use simplified models and lighter tree clusters.
- Hidden tile faces are dropped.

**Concerns**

- Medium is still over its triangle budget, but only when fully zoomed out. Trees are about 55% of what remains. If real phones struggle, the next step is billboard forests at far zoom on Medium.
- Not yet measured on real devices. Fps on a mid-range Android phone and an older iPhone must be checked before milestone 2 adds animated soldiers. Skinned characters are about 6–7k triangles each, so 20 visible soldiers would add about 130k.
- Software WebGL runs at about 1 fps, so the browser tests use polling and generous timeouts. Run them on a machine with a GPU in CI.

## Recommended next step

**Milestone 2: units, selection and pathfinding.**

1. Add infantry and archers from the Adventurers pack:
   - Knight model as infantry, Rogue as archers, tinted by faction.
   - Use the real Idle, Walking and Running clips, with one shared skeleton animation per type.
2. Add the fixed 10 Hz tick to `game-core`.
3. Write hex A* over the movement costs that already exist, with smooth steering between hex centres. A navmesh is no longer needed: the world is a hex grid.
4. Add box-select (left-drag) and right-click move.
5. Before step 1, check fps on one real phone.
