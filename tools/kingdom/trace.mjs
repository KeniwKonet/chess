import { chromium } from '@playwright/test';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await b.newPage({ viewport: { width: 640, height: 400 } });
page.on('console', (m) => { if (/Kingdom|rror/.test(m.text())) console.log('CONSOLE', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto('http://localhost:4174/');
await page.waitForSelector('body[data-pieces="1"]', { timeout: 180000 });
await page.getByRole('button', { name: /Two players/ }).click();
await page.getByRole('button', { name: 'To battle' }).click();
await page.evaluate(() => { const k = window.__crKingdom; for (const m of ['e4', 'd5', 'exd5', 'Qxd5']) k.play(m); });
const t0 = Date.now();
let last = '';
while (Date.now() - t0 < 120000) {
  const s = await page.evaluate(() => { const d = window.__crKingdom.director; const q = d.pieces.get('b-q-d8'); const p = d.pieces.get('w-p-e2'); return `t=${d.now.toFixed(1)} busy=${d.pending} Q ${q.x.toFixed(1)},${q.z.toFixed(1)} ${q.clip} | P ${p.x.toFixed(1)},${p.z.toFixed(1)} ${p.clip} fade=${p.fade.toFixed(2)} fx=${d.effects.map((e) => e.kind).join(',')}`; });
  if (s.replace(/t=[\d.]+ /, '') !== last) { console.log(s); last = s.replace(/t=[\d.]+ /, ''); }
  if (s.includes('busy=0')) break;
  await page.waitForTimeout(150);
}
await b.close();
