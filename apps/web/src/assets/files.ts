/**
 * Where the 3D models are served from. Normal builds use the compact .glb
 * files. `vite build --mode plain` uses self-contained .json copies instead,
 * for hosts that only serve common web file types (see docs/ASSETS.md).
 * Nothing needs setting on the host for a normal deploy.
 */
const EXT = import.meta.env.MODE === 'plain' ? 'json' : 'glb';
export const assetUrl = (name: 'kit' | 'units' | 'pieces') => `${import.meta.env.BASE_URL}assets/${name}.${EXT}`;
