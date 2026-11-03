/**
 * Packs the two battle soldiers into apps/web/public/assets/units.glb:
 *   Knight -> infantry (body, helmet, 1H sword, round shield, cape)
 *   Rogue  -> archers  (body, 1H crossbow, cape)
 *
 *   node tools/build-units.mjs [path-to-adventurers-pack]
 *   PLAIN=1 KIT_OUT=.../units.json node tools/build-units.mjs   (self-contained JSON, no meshopt)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packCharacters, ADVENTURERS } from './lib-characters.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.KIT_OUT ?? path.join(here, '../apps/web/public/assets/units.glb');
const MODELS = {
  knight: { file: 'Knight.glb', keep: ['Knight_ArmLeft', 'Knight_ArmRight', 'Knight_Body', 'Knight_Head', 'Knight_LegLeft', 'Knight_LegRight', 'Knight_Helmet', '1H_Sword', 'Round_Shield', 'Knight_Cape'] },
  rogue: { file: 'Rogue.glb', keep: ['Rogue_ArmLeft', 'Rogue_ArmRight', 'Rogue_Body', 'Rogue_Head', 'Rogue_LegLeft', 'Rogue_LegRight', '1H_Crossbow', 'Rogue_Cape'] },
};
const COMMON = ['Idle', 'Walking_A', 'Running_A', 'Hit_A', 'Death_A', 'Cheer'];
const CLIPS = { knight: [...COMMON, '1H_Melee_Attack_Chop'], rogue: [...COMMON, '1H_Ranged_Shoot', '1H_Ranged_Aiming'] };
await packCharacters(MODELS, CLIPS, OUT, process.argv[2] ?? ADVENTURERS);
