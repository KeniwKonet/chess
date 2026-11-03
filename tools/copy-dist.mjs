// Copies the web build (apps/web/dist) to ./dist at the repository root, where
// most static hosts look by default. Run by `npm run build`.
import fs from 'node:fs';
fs.rmSync('dist', { recursive: true, force: true });
fs.cpSync('apps/web/dist', 'dist', { recursive: true });
console.log('Site ready in ./dist');
