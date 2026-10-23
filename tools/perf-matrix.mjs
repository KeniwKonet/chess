// Records draw calls and triangles per frame for each quality level at overview and close zoom.
// Software rendering here, so fps is not meaningful; calls/triangles/memory are GPU-independent.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:4173/');
await page.waitForSelector('body[data-ready="1"]');
const rows = [];
const kitBytes = await page.evaluate(async () => (await (await fetch('assets/kit.glb')).arrayBuffer()).byteLength);
for (const q of ['High', 'Medium', 'Low']) {
  await page.getByRole('button', { name: q, exact: true }).click();
  for (const [label, pose] of [['overview', { x: 32, z: 19, dist: 92, yaw: 0 }], ['close (Sunspire)', { x: 12, z: 17, dist: 20, yaw: 0 }]]) {
    await page.waitForSelector('body[data-ready="1"]');
    await page.evaluate((p) => window.__crCam.jump(p), pose);
    // Wait for 6 fresh frames after the change, then read (gl.info reflects the previous frame).
    const f0 = await page.evaluate(() => window.__crPerf.frames);
    await page.waitForFunction((f) => window.__crPerf.frames >= f + 6 && window.__crPerf.calls > 5, f0, { timeout: 120000 });
    const s = await page.evaluate(() => ({ ...window.__crPerf }));
    const mem = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
    rows.push({ quality: q, view: label, drawCalls: s.calls, triangles: s.triangles, geometries: s.geometries, textures: s.textures, dpr: s.dpr, jsHeapMB: mem });
  }
}
console.log(JSON.stringify({ kitKB: Math.round(kitBytes / 1024), rows }, null, 1));
await browser.close();
