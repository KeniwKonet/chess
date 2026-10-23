# Assets

## Sources and licences

| Pack | Author | Licence | Used for |
| --- | --- | --- | --- |
| KayKit Medieval Hexagon Pack 1.0 | Kay Lousberg | CC0 1.0 | Terrain tiles, rivers, roads, buildings, nature, props |
| KayKit Adventurers Character Pack 1.0 | Kay Lousberg | CC0 1.0 | Soldiers (milestone 2, not yet in the build) |

The licence files are copied in [licenses/](licenses/). CC0 needs no attribution, but we credit the author anyway.

The packs were taken from the author's public GitHub mirrors, `KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0` and `KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0`.

## Pipeline

1. `python3 tools/make-atlas.py`: shrinks the 1024 px atlas to 512 px and shifts the grass swatch from yellow-olive to a fresher green. Nothing else in the atlas changes.
2. `node tools/build-assets.mjs`: packs the 100 or so models the game uses into `apps/web/public/assets/kit.glb`:
   - one shared 512 px texture
   - welded and de-duplicated geometry, compressed with meshopt
   - each model a named node, with moving parts kept as separate child nodes
   - simplified `__lite` variants of the heaviest models, for medium and low quality

   It also writes `apps/web/src/assets/kit-manifest.json`, which records triangle counts per model.
3. `python3 tools/edges.py`: measures which edges each river and road tile connects, by sampling the texture colour at each edge midpoint. The auto-tiler's pattern table (`packages/game-core/src/autotile.ts`) comes from this measurement, not from guessing at file names.

Result: `kit.glb` is 1.6 MB with 117 models and one texture.

For hosts that only serve common web file types, build a self-contained JSON kit instead:

```bash
PLAIN=1 KIT_OUT=apps/web/public/assets/kit.json node tools/build-assets.mjs
VITE_KIT_FILE=kit.json pnpm build
```

This version uses standard mesh quantisation instead of meshopt, so no WebAssembly decoder is needed. It comes to 4.2 MB with the buffers embedded. The hosted milestone 1 preview uses it.

## Animation: what the assets really have

- **Buildings have no animation clips.** Windmill fans, watermill wheels and catapult turrets are separate nodes in the models. The game turns them in code, which is procedural motion rather than an authored animation.
- **Trees sway** through a small vertex shader. This is also procedural.
- **The character models (milestone 2) ship 76 real clips each**, checked in the files. They include Idle, Walking_A/B/C, Running_A/B, 1H/2H melee attacks, 1H/2H ranged aim, reload and shoot, Block, Hit_A/B, Death_A/B, Cheer and Spellcast. There are no horse models or riding clips, so cavalry needs another source (see below).

## Gaps and stand-ins

| Need | Status |
| --- | --- |
| Stables | No stables model in the CC0 pack. The tavern model stands in, and the selection panel still says "Stables". Replace when a stables model is sourced. |
| Siege workshop | Uses the catapult tower, which reads well as a siege workshop. |
| Horses and cavalry | Not in either pack. Options: Quaternius animal packs (CC0), or KayKit paid extras. Needed by milestone 3. |
| Siege engines as units | Only `projectile_catapult` and the catapult tower exist. A wheeled trebuchet or ram must be sourced (milestone 3). |
| Walls | `wall_*` pieces are packed but not yet placed. Castle walls arrive with construction (milestone 3). |
