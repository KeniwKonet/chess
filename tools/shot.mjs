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
if (process.env.KEYS) { for (const k of process.env.KEYS.split(',')) { await page.keyboard.press(k); await page.waitForTimeout(400); } await page.waitForTimeout(1500); }
await page.screenshot({ path: out });
const perf = await page.evaluate(() => window.__crPerf);
console.log(JSON.stringify(perf));
console.log(logs.slice(0, 30).join('\n'));
await browser.close();
