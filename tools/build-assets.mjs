/**
 * Packs the KayKit models the game uses into one meshopt-compressed GLB with a
 * single shared 512px atlas. Each model becomes a top-level node named by its
 * file name (e.g. "building_castle_blue"), with its own child hierarchy kept
 * so moving parts (windmill fans, watermill wheels, catapult arms) stay
 * separate nodes.
 *
 *   node tools/build-assets.mjs [path-to-kaykit-medieval-hexagon-pack]
 *
 * Source: KayKit Medieval Hexagon Pack 1.0 by Kay Lousberg, CC0.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, mergeDocuments, unpartition, meshopt, weld, simplify } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] ?? '/home/claude/vendor/hex/addons/kaykit_medieval_hexagon_pack/Assets/gltf';
const OUT = path.join(here, '../apps/web/public/assets/kit.glb');
const MANIFEST = path.join(here, '../apps/web/src/assets/kit-manifest.json');

const colours = ['blue', 'yellow'];
const coloured = ['castle', 'barracks', 'archeryrange', 'tavern', 'windmill', 'mine', 'lumbermill', 'blacksmith',
  'tower_catapult', 'tower_A', 'tower_B', 'watermill', 'home_A', 'home_B', 'market'].flatMap((b) => colours.map((c) => `building_${b}_${c}`));
const names = [
  'hex_grass', 'hex_water',
  ...'ABCDEFGHIJKL'.split('').map((v) => `hex_river_${v}`), 'hex_river_crossing_A', 'hex_river_crossing_B',
  ...'ABCDEFGHIJKLM'.split('').map((v) => `hex_road_${v}`),
  ...coloured,
  'building_grain', 'building_bridge_A', 'building_scaffolding', 'building_stage_B', 'building_destroyed',
  'trees_A_large', 'trees_B_large', 'trees_A_medium', 'trees_B_medium', 'tree_single_A', 'tree_single_B',
  'mountain_A_grass_trees', 'mountain_B_grass_trees', 'mountain_C_grass', 'mountain_A_grass', 'mountain_B',
  'hills_A_trees', 'hills_B_trees', 'hills_C', 'hills_A', 'hills_B',
  'rock_single_A', 'rock_single_B', 'rock_single_C', 'rock_single_D', 'rock_single_E',
  'barrel', 'crate_A_big', 'flag_blue', 'flag_yellow', 'cloud_big', 'cloud_small',
  'wall_straight', 'wall_corner_A_outside', 'wall_corner_A_inside', 'tent', 'weaponrack', 'sack', 'wheelbarrow',
];

const index = new Map();
for (const f of fs.readdirSync(SRC, { recursive: true })) {
  if (String(f).endsWith('.gltf')) index.set(path.basename(String(f), '.gltf'), path.join(SRC, String(f)));
}

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(index.get(names[0]));
doc.getRoot().listScenes()[0].listChildren()[0].setName(names[0]);
const scene = doc.getRoot().listScenes()[0];

const manifest = {};
for (const name of names.slice(1)) {
  const file = index.get(name);
  if (!file) throw new Error(`Missing model ${name}`);
  const src = await io.read(file);
  const map = mergeDocuments(doc, src);
  const srcScene = src.getRoot().listScenes()[0];
  const merged = map.get(srcScene);
  const wrapper = doc.createNode(name);
  for (const child of merged.listChildren()) {
    merged.removeChild(child);
    wrapper.addChild(child);
  }
  scene.addChild(wrapper);
  merged.dispose();
}
// Simplified "__lite" variants of the heaviest models for medium/low quality (mobile).
const LITE = [
  'trees_A_large', 'trees_B_large', 'trees_A_medium', 'trees_B_medium', 'tree_single_B',
  'mountain_A_grass_trees', 'mountain_B_grass_trees', 'hills_A_trees', 'hills_B_trees',
  'building_castle_blue', 'building_castle_yellow', 'building_barracks_blue', 'building_barracks_yellow',
  'building_archeryrange_blue', 'building_archeryrange_yellow', 'building_tower_A_blue', 'building_tower_A_yellow',
  'building_lumbermill_blue', 'building_lumbermill_yellow',
];
await MeshoptSimplifier.ready;
for (const name of LITE) {
  const src = await io.read(index.get(name));
  const ratio = name.startsWith('building') ? 0.55 : 0.4;
  await src.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.012 }));
  const map = mergeDocuments(doc, src);
  const merged = map.get(src.getRoot().listScenes()[0]);
  const wrapper = doc.createNode(`${name}__lite`);
  for (const child of merged.listChildren()) {
    merged.removeChild(child);
    wrapper.addChild(child);
  }
  scene.addChild(wrapper);
  merged.dispose();
}
// Wrap the first model the same way as the rest.
{
  const first = scene.listChildren().find((n) => n.getName() === names[0]);
  const wrapper = doc.createNode(names[0]);
  scene.removeChild(first);
  first.setName(names[0] + '_mesh');
  wrapper.addChild(first);
  scene.addChild(wrapper);
}
for (const s of doc.getRoot().listScenes()) if (s !== scene) s.dispose();

// One shared, smaller atlas.
const atlas = fs.readFileSync(path.join(here, 'atlas512.png'));
for (const tex of doc.getRoot().listTextures()) tex.setImage(atlas).setMimeType('image/png').setURI('atlas.png');

await doc.transform(dedup(), weld(), prune(), unpartition(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));

for (const node of scene.listChildren()) {
  let tris = 0;
  node.traverse((n) => {
    const m = n.getMesh();
    if (m) for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
  });
  manifest[node.getName()] = { tris };
}
await io.write(OUT, doc);
fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB), ${Object.keys(manifest).length} models, textures: ${doc.getRoot().listTextures().length}`);
