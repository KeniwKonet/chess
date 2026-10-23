import { chromium } from '@playwright/test';
const [,, url = 'http://localhost:4173/', out = 'shot.png', w = '1440', h = '900', script = ''] = process.argv;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, ...(process.env.MOBILE ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForSelector('body[data-ready="1"]', { timeout: 60000 }).catch(() => logs.push('NOT READY'));
await page.waitForTimeout(4500);
if (script) { await page.evaluate(script); await page.waitForTimeout(2500); }
if (process.env.CLICK) { const [cx, cy] = process.env.CLICK.split(',').map(Number); await page.mouse.click(cx, cy); await page.waitForTimeout(2500); }
if (process.env.ACTIONS) {
  for (const a of JSON.parse(process.env.ACTIONS)) {
    if (a.click) await page.mouse.click(a.click[0], a.click[1]);
    if (a.tap) await page.touchscreen.tap(a.tap[0], a.tap[1]);
    if (a.rclick) await page.mouse.click(a.rclick[0], a.rclick[1], { button: 'right' });
    if (a.drag) { await page.mouse.move(a.drag[0], a.drag[1]); await page.mouse.down(); await page.mouse.move(a.drag[2], a.drag[3], { steps: 6 }); await page.mouse.up(); }
    if (a.key) await page.keyboard.press(a.key);
    if (a.sel) await page.click(a.sel);
    if (a.eval) await page.evaluate(a.eval);
    await page.waitForTimeout(a.wait ?? 600);
  }
}
if (process.env.KEYS) { for (const k of process.env.KEYS.split(',')) { await page.keyboard.press(k); await page.waitForTimeout(400); } await page.waitForTimeout(1500); }
await page.screenshot({ path: out });
const perf = await page.evaluate(() => window.__crPerf);
console.log(JSON.stringify(perf));
console.log(logs.slice(0, 30).join('\n'));
await browser.close();
