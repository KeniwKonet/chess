// Records a staged sequence of moves in Chess Kingdom on a frozen clock (one render per frame),
// to check the battle scenes frame by frame. Pass-and-play; moves via the controller.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const OUT = process.env.OUT; fs.mkdirSync(OUT, { recursive: true });
const FPS = Number(process.env.FPS ?? 8);
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await b.newPage({ viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 800) } });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.clock.install();
await page.addInitScript(() => {
  let q = []; let manual = false; const real = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { if (!manual) return real(cb); q.push(cb); return q.length; };
  window.__manual = () => (manual = true);
  window.__frame = () => { const c = q; q = []; const t = performance.now(); for (const cb of c) cb(t); };
});
await page.goto(process.env.URL ?? 'http://localhost:4174/');
await page.waitForSelector('body[data-ready="1"]', { timeout: 180000 });
await page.waitForSelector('body[data-pieces="1"]', { timeout: 180000 });
await page.evaluate(() => window.__manual());
await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
const idle = async (ms) => { for (let t = 0; t < ms; t += 100) { await page.clock.runFor(100); await page.evaluate(() => window.__frame()); } };
await page.evaluate(() => localStorage.setItem('cr-kingdom', JSON.stringify({ flipEachTurn: false, tc: 'untimed' })));
await page.reload();
await page.waitForSelector('body[data-pieces="1"]', { timeout: 180000 });
await page.evaluate(() => window.__manual());
await page.getByRole('button', { name: /Two players/ }).click();
await page.getByRole('button', { name: 'To battle' }).click();
await page.evaluate(() => { const k = window.__crKingdom; k.kc.you = 'both'; });
await idle(1500);
await page.evaluate(() => window.__crKingdom.settleCamera());
await idle(300);
let n = 0;
const shot = async () => { await page.clock.runFor(1000 / FPS); await page.evaluate(() => window.__frame()); await page.screenshot({ path: `${OUT}/f${String(n++).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 80 }); };
const moves = (process.env.MOVES ?? 'e4 d5 exd5 Qxd5 Nc3 Qa5').split(' ');
for (const m of moves) {
  await page.evaluate((mv) => window.__crKingdom.play(mv), m);
  for (let i = 0; i < FPS * Number(process.env.SECS ?? 4); i++) await shot();
}
console.log('frames', n, await page.evaluate(() => window.__crKingdom.kc.game.history.map((m) => m.san).join(' ')));
await b.close();
