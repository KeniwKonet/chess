# Milestone 2 report: units, selection, orders and pathfinding

**Goal (from the brief):** add selectable units, movement commands and pathfinding.

## What was implemented

**Simulation (`packages/game-core/src/sim`)**

- A fixed 10 Hz tick over plain data. It runs outside React and is deterministic: the same commands always give the same result (tested).
- Units change only through commands: `move` and `stop`. These are validated on the next tick, so you cannot order the other side's units. An authoritative server will use the same contract in milestone 6.
- **Pathfinding** uses distance fields over the hex map, not a navmesh. One reverse Dijkstra search from the goal hex serves every soldier sent there.
  - The map is about 650 cells, so a field is cheap.
  - Fields are cached (most recent 32), and at most 8 are built per tick, which is the budget from the plan.
  - Soldiers look up to 4 cells ahead and walk straight where the ground allows, so they don't zig-zag across hexes.
  - Each step checks the soldier's real position, so nobody clips a river or building corner.
  - Movement costs from milestone 1 apply: roads are faster; forest, hills and the ford are slower; rivers (except at crossings), mountains and buildings are impassable.
- **Formations.** A group forms ranks facing the direction of travel, infantry in front and archers behind. Slots that land on blocked ground move to the nearest open spot.
- **Personal space.** Soldiers push apart, and idle soldiers give way to marching ones. Nobody is ever pushed onto blocked ground.
- **Stuck handling.** A soldier that stops making progress for 6 seconds counts as arrived if it's within 1.4 units of its slot (crowding at a bridge or destination). Otherwise it reports "unreachable" instead of wandering.
- **Moon AI** (`packages/game-core/src/ai/patrol.ts`): a three-man patrol walks between the Vey hills and Ashgrove, pausing at each end. It issues ordinary move commands, exactly as a player does. AI that fights arrives with combat.
- **Starting armies:**

  | Side | Infantry | Archers | Other |
  | --- | --- | --- | --- |
  | Sun | 8 | 6 | — |
  | Moon | 8 | 6 | 3-man patrol |

**Soldiers on screen (`apps/web/src/units`)**

- **Models:** KayKit Knight as infantry (helmet, sword, round shield, cape) and KayKit Rogue as archers (crossbow, cape), recoloured to Sun gold and Moon blue.
- **Real animation clips from the files,** chosen per soldier: Idle, Walking_A, Running_A. Playback speed follows actual movement, so feet don't slide. The attack, hit, death and cheer clips are already baked for milestone 3.
- **One draw call per unit type, side and detail level.** At load, each soldier is flattened into one geometry, and every frame of every clip is sampled once into a texture of bone matrices. A whole company is then a single instanced draw.
- **Bake test.** The bake is checked against three.js's own skinning for every clip at both detail levels. The error is under 1 mm.
- **Detail levels:**
  - full (infantry 5.3k / archers 4.9k triangles) close to the camera
  - simplified (2.2k / 1.8k) further out, generated at build time
  - chess-piece tokens at strategic zoom: pawns for infantry, bishops for archers, matching the War Table
- **Culling and markers:** soldiers outside the view aren't drawn. Each soldier has a soft blob shadow, a faction selection ring and a white hover ring. Move orders leave a marker that shrinks into the target, green for open ground and amber if the spot snapped to the nearest open ground.

**Controls**

| Input | Action |
| --- | --- |
| Click a soldier | Select it. Shift-click adds or removes |
| Left-drag | Box-select your soldiers (Shift adds) |
| Double-click a soldier | Select everyone of that type in view |
| Right-click | Order a move |
| Right-drag | Pan (changed from left-drag in milestone 1, as planned) |
| Middle-drag or Alt-drag | Rotate |
| X | Stop |
| Ctrl+A | Select all |
| Ctrl+1–9, then 1–9 | Set and recall control groups; press twice to jump the camera |
| F | Focus the selection |

On touch:

- One finger pans.
- A tap selects, or sends the selected soldiers to that spot.
- The army bar selects whole companies.

**HUD**

- **Army bar:** infantry, archers, all.
- **Single-soldier panel:** health, state ("Marching toward the North Bridge", "Holding position", "Finding a path"), the terrain underfoot and the current speed on it, plus Focus and Stop. Attack is shown locked, tagged M3.
- **Group panel:** a roster with one chip per soldier (click to select just that one), marching and holding counts, and Focus and Stop.
- Enemy soldiers can be inspected but not commanded, and the panel says so.
- The minimap shows soldier dots.
- The field log reports real events: orders, arrivals, halts, unreachable destinations and Moon patrol moves.

## What is functional

Everything above works with real input on desktop and touch, driven by the simulation. The browser tests drive the actual build.

## What remains mocked or incomplete

| Item | Status |
| --- | --- |
| Combat, damage, death | Not started (milestone 3). Health is fixed at full; Attack is locked, tagged M3. |
| Enemy AI | Only the patrol. No attacking, defending or retreating yet (milestone 3). |
| Fog of war | Not implemented; Moon soldiers are visible everywhere. |
| Economy, training, building | Unchanged from milestone 1: starting values, not simulated. |
| Other unit types | Cavalry, scouts, engineers, siege and commanders are not in yet. Cavalry needs horse models, which the CC0 packs don't have (see ASSETS.md). |
| Archers' weapon | The archer model carries a crossbow (the pack has no bow). They are still called archers, as in the rules. |
| Unit collisions with each other | Soft push-apart, not true collision; soldiers can briefly overlap in crowds. |
| War Table, menus, multiplayer | Milestones 4–6. |

## Tests executed

**Unit tests: `pnpm test`, 47 passed, 0 failed (up from 30)**

| Area | What the tests cover |
| --- | --- |
| Distance fields | They skip blocked cells; they descend strictly to the goal; they cross the river only at a bridge or the ford |
| Simulation | A group reaches its destination with exactly one arrival report; archers cross the river through a crossing and never stand on blocked ground for 900 ticks; same commands give the same result; the other side's orders are rejected; at most 8 fields are built per tick with 30 simultaneous orders; roads are more than twice as fast as forest, at the exact expected speed; Stop halts; settled soldiers keep at least 0.4 apart; an order into open sea snaps to shore and arrives |
| Stress | 3,000 ticks of seeded random orders across the whole map, with no invalid positions and nobody on blocked ground |
| Moon patrol AI | Walks both ends of its route using ordinary orders |
| Animation bake (2) | Matches three.js skinning to under 1 mm for every clip at both detail levels; every game clip is present |
| Placement | Posed soldiers stand on their position at the intended height, at any heading |

The 30 milestone 1 tests still pass.

**Browser tests: `npx playwright test`, 10 passed, 0 failed (up from 6)**

| Test | What it checks |
| --- | --- |
| Army bar order | Select a company from the army bar, right-click: they march, then arrive |
| Box select and stop | Left-drag box-select picks only Sun soldiers; X halts them, and "halted" appears in the log |
| Single soldier | Clicking a soldier selects exactly that one |
| Touch | On a phone-sized screen with real touch input, tapping a company then the map sets all 6 archers marching |
| Updated | The camera test now pans with right-drag |
| Unchanged | The other 5 from milestone 1 still pass |

**Bugs the tests caught and fixed**

- **Bridges.** Soldiers got stuck at bridge corners: the look-ahead checked lines between cell centres, not from the soldier's actual position.
- **Weapons.** Weapons drifted from hands, because each body part has its own skin with different inverse-bind matrices.
- **Packed file.** The packed units file was 3.7 MB, because deleted animation clips left their keyframes behind. It is now 725 KB.
- **Missing UVs.** UVs were stripped by the pack's prune step, because textures were removed. Soldiers rendered as a single flat colour.
- **Offset soldiers.** Soldiers stood off their rings: the anchor came from bind space instead of a posed frame, and the simulation step ran in a different order from the rings.

## Performance

Measured with `tools/perf-matrix.mjs` at 1440×900 in software WebGL. Draw calls and triangles are exact; frame rate cannot be measured without a GPU. There are 31 soldiers on the field.

| Quality | View | Draw calls | Triangles | Budget (plan) |
| --- | --- | --- | --- | --- |
| High | Full map (tokens) | 91 | 393k | under 150 / under 400k: inside |
| High | Close on Sun army | 48 | 319k | inside |
| High | Mid zoom, both armies | 76 | 418k | 5% over on triangles |
| Medium | Close on Sunspire | 16 | 100k | under 80 / under 150k: inside |
| Medium | Close on Sun army | 21 | 159k | 6% over |
| Medium | Mid zoom, both armies | 49 | 229k | 53% over |
| Medium | Full map | 62 | 190k | 26% over (as in milestone 1) |

**What helped:**

- per-soldier view culling and simplified soldiers further out, which cut Medium close-ups from 232k to 100k triangles and mid zoom from 326k to 229k
- tokens at strategic zoom, so soldiers cost almost nothing there
- the per-frame cost of animation is one small buffer update; skinning happens on the GPU from the baked texture

**Downloads:**

| Build | Kit | Units | JavaScript |
| --- | --- | --- | --- |
| Repo (meshopt) | 1.6 MB | 0.7 MB | 1.3 MB |
| Hosted preview (self-contained JSON) | 4.2 MB | 1.2 MB | 1.3 MB |

**Concerns**

- At mid and far zoom on Medium, the scenery is still the biggest cost (about 170k triangles), not the soldiers.
  - If a real phone drops below 30 fps, the next lever is a far-detail version of the forests.
  - Fewer, larger tree clumps per tile would cut most of the remaining excess.
- The bone texture is 1,656 × 214 floats. That is fine on WebGL2 phones, but it should be checked on an older iPhone along with the frame rate.
- **Still not measured on a real device.** Please open the preview on a phone with Stats on and send the fps at overview and close zoom.

## Recommended next step

**Milestone 3: combat, health and enemy AI.**

- Melee and ranged attacks using the attack, hit and death clips that are already baked.
- Damage and death; attack-move and target orders.
- A Moon AI that defends, attacks and retreats.
- Capture points that actually capture.
- Fog of war (the v2 design already defines its rules).
