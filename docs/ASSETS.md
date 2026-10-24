# Assets

## Sources and licences

| Pack | Author | Licence | Used for |
| --- | --- | --- | --- |
| KayKit Medieval Hexagon Pack 1.0 | Kay Lousberg | CC0 1.0 | Terrain tiles, rivers, roads, buildings, nature, props |
| KayKit Adventurers Character Pack 1.0 | Kay Lousberg | CC0 1.0 | Soldiers: Knight (infantry), Rogue (archers) |

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

### Soldiers

1. `python3 tools/make-unit-textures.py`: recolours the team swatches to Sun gold and Moon blue: the Knight's red cape, shield and emblem, and the Rogue's green tunic and cape. Skin, hair, leather and metal are untouched. It writes four 512 px PNGs to `apps/web/public/assets/units/`.
2. `node tools/build-units.mjs`: packs the two characters into `apps/web/public/assets/units.glb` (725 KB):
   - only the parts used: Knight body, helmet, 1H sword, round shield and cape; Rogue body, 1H crossbow and cape
   - only the clips used (7 each, plus 1H_Ranged_Aiming for the Rogue), resampled
   - a simplified `__lod` copy of every part (about 40% of the triangles), made with meshoptimizer
   - textures stripped, because the game loads the recoloured PNGs
   - `PLAIN=1 KIT_OUT=…/units.json` gives a self-contained JSON version for the hosted preview
3. At load, `apps/web/src/units/unitKit.ts` bakes every frame of those clips into a bone-matrix texture for instanced rendering. `apps/web/test/bake.test.ts` checks the result against three.js's own skinning.

## Animation: what the assets really have

- **Buildings have no animation clips.** Windmill fans, watermill wheels and catapult turrets are separate nodes in the models. The game turns them in code, which is procedural motion rather than an authored animation.
- **Trees sway** through a small vertex shader. This is also procedural.
- **The character models ship 76 real clips each**, checked in the files.
  - The game uses Idle, Walking_A and Running_A now.
  - It has also baked 1H_Melee_Attack_Chop (infantry), 1H_Ranged_Shoot (archers), Hit_A, Death_A and Cheer, used by combat since milestone 3 (attack, hit and death are driven by the simulation; Cheer plays for the winners).
  - There are no horse models or riding clips, so cavalry needs another source (see below).
- **Walk and run playback speed is scaled to each soldier's real speed.** Nothing else about the clips is changed.
- **The archer model carries a crossbow;** the pack has no bow. The ranged clips are crossbow animations.

## Gaps and stand-ins

| Need | Status |
| --- | --- |
| Stables | No stables model in the CC0 pack. The tavern model stands in, and the selection panel still says "Stables". Replace when a stables model is sourced. |
| Siege workshop | Uses the catapult tower, which reads well as a siege workshop. |
| Horses and cavalry | Not in either pack. Options: Quaternius animal packs (CC0), or KayKit paid extras. Still needed: knights on the War Table command no one until cavalry exists. |
| Siege engines as units | Only `projectile_catapult` and the catapult tower exist. A wheeled trebuchet or ram must be sourced; not yet in the game. |
| Walls | `wall_*` pieces are packed but not yet placed. Castle walls arrive with construction, which is not built yet (the economy is not simulated). |
