/**
 * Shared character packer for units.glb (battle soldiers) and pieces.glb
 * (Chess Kingdom pieces): keeps the listed mesh parts and animation clips of
 * KayKit Adventurers characters, renames clips "<model>|<clip>", strips
 * textures (the game loads team-coloured PNGs from assets/units/), adds
 * simplified "__lod" copies, then compresses (meshopt) or writes plain JSON.
 *
 * Source: KayKit Adventurers Character Pack 1.0 by Kay Lousberg, CC0.
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, mergeDocuments, meshopt, quantize, unpartition, resample, simplifyPrimitive, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';

export const ADVENTURERS = '/home/claude/vendor/adv/addons/kaykit_character_pack_adventures';

/**
 * @param {Record<string, { file: string, keep: string[] }>} MODELS
 * @param {Record<string, string[]>} CLIPS clip names to keep, per model
 * @param {string} OUT .glb (meshopt) or .json (self-contained, PLAIN=1 recommended)
 * @param {string} ROOT path to the Adventurers pack
 * @param {{ lod?: boolean }} opts lod: add simplified copies for mid-range zoom (default true)
 */
export async function packCharacters(MODELS, CLIPS, OUT, ROOT = ADVENTURERS, opts = {}) {
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

  let doc;
  let scene;
  for (const [name, def] of Object.entries(MODELS)) {
    const src = await io.read(path.join(ROOT, 'Characters/gltf', def.file));
    const r = src.getRoot();
    for (const node of r.listNodes()) if (node.getMesh() && !def.keep.includes(node.getName())) node.setMesh(null);
    for (const anim of r.listAnimations()) {
      if (!CLIPS[name].includes(anim.getName())) {
        // Dispose channels and samplers too; a bare anim.dispose() leaves them (and their data) in the file.
        for (const ch of anim.listChannels()) ch.dispose();
        // Keyframe time arrays can be shared between clips, so leave accessors to prune().
        for (const sm of anim.listSamplers()) sm.dispose();
        anim.dispose();
      }
      else anim.setName(`${name}|${anim.getName()}`);
    }
    for (const m of r.listMaterials()) m.setBaseColorTexture(null).setName(`${name}_material`);
    const sceneSrc = r.listScenes()[0];
    if (!doc) {
      doc = src;
      scene = sceneSrc;
      const wrapper = doc.createNode(name);
      for (const c of scene.listChildren()) {
        scene.removeChild(c);
        wrapper.addChild(c);
      }
      scene.addChild(wrapper);
    } else {
      const map = mergeDocuments(doc, src);
      const merged = map.get(sceneSrc);
      const wrapper = doc.createNode(name);
      for (const c of merged.listChildren()) {
        merged.removeChild(c);
        wrapper.addChild(c);
      }
      scene.addChild(wrapper);
      merged.dispose();
    }
  }
  for (const s of doc.getRoot().listScenes()) if (s !== scene) s.dispose();

  if (opts.lod !== false) {
    // Lower-detail copies ("<part>__lod") for mid-range zoom: same skin, same bones, fewer triangles.
    await MeshoptSimplifier.ready;
    await doc.transform(weld());
    let full = 0;
    let lod = 0;
    for (const node of doc.getRoot().listNodes()) {
      const mesh = node.getMesh();
      if (!mesh || node.getName().endsWith('__lod')) continue;
      const copy = doc.createMesh(`${mesh.getName()}__lod`);
      for (const prim of mesh.listPrimitives()) {
        const p2 = prim.clone();
        p2.setIndices(prim.getIndices().clone());
        for (const sem of prim.listSemantics()) p2.setAttribute(sem, prim.getAttribute(sem));
        full += prim.getIndices().getCount() / 3;
        simplifyPrimitive(p2, { simplifier: MeshoptSimplifier, ratio: 0.3, error: 0.03, lockBorder: false });
        lod += p2.getIndices().getCount() / 3;
        copy.addPrimitive(p2);
      }
      const twin = doc.createNode(`${node.getName()}__lod`).setMesh(copy).setTranslation(node.getTranslation()).setRotation(node.getRotation()).setScale(node.getScale());
      if (node.getSkin()) twin.setSkin(node.getSkin());
      for (const parent of node.listParents()) if (parent.propertyType === 'Node') parent.addChild(twin);
      for (const sc of doc.getRoot().listScenes()) if (sc.listChildren().includes(node)) sc.addChild(twin);
    }
    console.log(`LOD triangles: ${full} -> ${lod}`);
  } else await doc.transform(weld());
  // keepAttributes: UVs look unused once textures are stripped, but the game supplies its own textures.
  await doc.transform(resample({ tolerance: 1e-4 }), dedup(), prune({ keepAttributes: true }), unpartition());
  // UVs stay unquantised: their dequantisation would live on the (stripped) texture reference.
  const Q = { pattern: /^(POSITION|NORMAL|TANGENT|JOINTS_\d+|WEIGHTS_\d+)$/ };
  await doc.transform(...(process.env.PLAIN ? [quantize(Q)] : [meshopt({ encoder: MeshoptEncoder, level: 'medium', ...Q })]));

  if (OUT.endsWith('.json')) {
    const { json, resources } = await io.writeJSON(doc, { format: 'gltf' });
    for (const b of json.buffers ?? []) b.uri = `data:application/octet-stream;base64,${Buffer.from(resources[b.uri]).toString('base64')}`;
    fs.writeFileSync(OUT, JSON.stringify(json));
  } else {
    await io.write(OUT, doc);
  }
  const anims = doc.getRoot().listAnimations().map((a) => a.getName());
  console.log(`skins ${doc.getRoot().listSkins().length}, meshes ${doc.getRoot().listMeshes().length}`); console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB); clips: ${anims.length} (${anims.join(', ')})`);

}
