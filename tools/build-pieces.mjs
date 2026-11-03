/**
 * Packs the Chess Kingdom pieces into apps/web/public/assets/pieces.glb.
 * Each chess role is a character with its own weapon and moves:
 *   footman   (pawn)    Knight: helmet, 1H sword, round shield, cape
 *   raider    (knight)  Barbarian: hat, cape, great axe; leaps
 *   ranger    (bishop)  hooded Rogue: cape, heavy crossbow
 *   sorceress (queen)   Mage: hat, cape, staff
 *   king      (king)    Knight: cape, great sword (the crown is added in the game)
 * Rooks are siege towers built from the hex kit, not characters.
 *
 *   node tools/build-pieces.mjs [path-to-adventurers-pack]
 *   PLAIN=1 KIT_OUT=.../pieces.json node tools/build-pieces.mjs   (self-contained JSON, no meshopt)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packCharacters, ADVENTURERS } from './lib-characters.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.KIT_OUT ?? path.join(here, '../apps/web/public/assets/pieces.glb');
const body = (p, head = 'Head') => [`${p}_ArmLeft`, `${p}_ArmRight`, `${p}_Body`, `${p}_${head}`, `${p}_LegLeft`, `${p}_LegRight`];
const MODELS = {
  footman: { file: 'Knight.glb', keep: [...body('Knight'), 'Knight_Helmet', '1H_Sword', 'Round_Shield', 'Knight_Cape'] },
  raider: { file: 'Barbarian.glb', keep: [...body('Barbarian'), 'Barbarian_Hat', 'Barbarian_Cape', '2H_Axe'] },
  ranger: { file: 'Rogue_Hooded.glb', keep: [...body('Rogue', 'Head_Hooded'), 'Rogue_Cape', '2H_Crossbow'] },
  sorceress: { file: 'Mage.glb', keep: [...body('Mage'), 'Mage_Hat', 'Mage_Cape', '2H_Staff'] },
  king: { file: 'Knight.glb', keep: [...body('Knight'), 'Knight_Cape', '2H_Sword'] },
};
const COMMON = ['Idle', 'Walking_A', 'Running_A', 'Hit_A', 'Death_A', 'Cheer', 'Block'];
const CLIPS = {
  footman: [...COMMON, '1H_Melee_Attack_Stab'],
  raider: [...COMMON, '2H_Melee_Attack_Chop', 'Jump_Full_Long'],
  ranger: [...COMMON, '2H_Ranged_Shoot'],
  sorceress: [...COMMON, 'Spellcast_Shoot'],
  king: [...COMMON, '2H_Melee_Attack_Slice', 'Walking_B'],
};
// No __lod copies: the board is never viewed from strategic distance, and the file stays small.
await packCharacters(MODELS, CLIPS, OUT, process.argv[2] ?? ADVENTURERS, { lod: false });
