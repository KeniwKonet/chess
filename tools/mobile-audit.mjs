// Mobile experience audit: plays through the main flows on emulated phones and a
// tablet with real touch input, screenshots each step, and runs layout checks
// (off-screen controls, small tap targets, overlapping panels, tiny text,
// sideways page scroll). Software WebGL here, so it says nothing about frame rate.
//
//   URL=http://localhost:4174/ OUT=audit node tools/mobile-audit.mjs
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.URL ?? 'http://localhost:4174/';
const OUT = process.env.OUT ?? 'mobile-audit';
const ONLY = process.env.ONLY;
fs.mkdirSync(OUT, { recursive: true });

const DEVICES = [
  { name: 'android-small', w: 360, h: 800, dpr: 3 }, // common budget Android (Tecno, Infinix, Samsung A)
  { name: 'iphone-se', w: 375, h: 667, dpr: 2 },
  { name: 'pixel-7', w: 412, h: 915, dpr: 2.625 },
  { name: 'phone-landscape', w: 844, h: 390, dpr: 3 },
  { name: 'ipad-mini', w: 768, h: 1024, dpr: 2 },
].filter((d) => !ONLY || ONLY.split(',').includes(d.name));

/** Layout checks run in the page. */
function audit() {
  const vw = innerWidth;
  const vh = innerHeight;
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
  const out = { offscreen: [], small: [], overlaps: [], tinyText: [], pageScroll: document.documentElement.scrollWidth > vw + 1 };
  const controls = [...document.querySelectorAll('button, [role=button], input, label.diff, summary, a')].filter(visible);
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    // Inside a scrolling strip, being outside the strip's box is expected; outside the screen is reported anyway.
    if (r.right > vw + 1 || r.left < -1 || r.bottom > vh + 1 || r.top < -1) out.offscreen.push(`${label(el)} @${Math.round(r.left)},${Math.round(r.top)}`);
    if (r.width < 40 || r.height < 36) {
      // Chess squares are a deliberate grid; report them once as a size.
      if (el.classList.contains('sq')) continue;
      out.small.push(`${label(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  }
  const sq = document.querySelector('.sq');
  if (sq && visible(sq)) out.square = Math.round(sq.getBoundingClientRect().width);
  const panels = [
    ['brand', '.brand'], ['toolbar', '.toolbar'], ['resources', '.resources'], ['army', '.army'], ['selection', '.selection'],
    ['minimap', '.minimap'], ['camera', '.cam-buttons'], ['log', '.log'], ['wartable', '.wartable'], ['overlay-labels', null],
  ]
    .filter(([, s]) => s)
    .map(([n, s]) => [n, document.querySelector(s)])
    .filter(([, el]) => el && visible(el))
    .map(([n, el]) => [n, el.getBoundingClientRect()]);
  for (let i = 0; i < panels.length; i++) {
    for (let j = i + 1; j < panels.length; j++) {
      const [a, ra] = panels[i];
      const [b, rb] = panels[j];
      const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (x > 4 && y > 4) out.overlaps.push(`${a} × ${b} (${Math.round(x)}×${Math.round(y)})`);
    }
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  while (walker.nextNode()) {
    const t = walker.currentNode;
    const el = t.parentElement;
    if (!el || !t.textContent.trim() || !visible(el) || seen.has(el)) continue;
    seen.add(el);
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 11.5) out.tinyText.push(`${fs}px "${t.textContent.trim().slice(0, 30)}"`);
  }
  out.tinyText = [...new Set(out.tinyText)].slice(0, 12);
  return out;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const report = {};
for (const d of DEVICES) {
  const ctx = await browser.newContext({ viewport: { width: d.w, height: d.h }, deviceScaleFactor: d.dpr, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => /Shader Error|program not valid/.test(m.text()) && errors.push(m.text().slice(0, 120)));
  const r = (report[d.name] = { steps: {}, notes: [], errors });
  const shot = async (step) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `${d.name}-${step}.png`) });
    r.steps[step] = await page.evaluate(audit);
  };
  const tapEl = async (loc) => {
    const b = await loc.boundingBox();
    if (!b) throw new Error('not visible');
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  };
  const t0 = Date.now();
  await page.goto(BASE);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 180_000 });
  r.loadSeconds = +((Date.now() - t0) / 1000).toFixed(1);
  await page.waitForTimeout(1500);
  await shot('1-title');
  r.quality = await page.evaluate(() => document.querySelector('canvas') && window.devicePixelRatio);

  // Start.
  try {
    await tapEl(page.getByRole('button', { name: 'Begin the battle' }));
  } catch (e) {
    r.notes.push(`Begin button: ${e.message}`);
    await page.evaluate(() => window.__crStart('recruit'));
  }
  await page.waitForSelector('body[data-units="1"]', { timeout: 60_000 }).catch(() => r.notes.push('units never ready'));
  await page.waitForTimeout(2500);
  await shot('2-battle');

  // Toolbar: which buttons are on screen without scrolling?
  r.toolbar = await page.evaluate(() =>
    [...document.querySelectorAll('.toolbar .btn')].map((b) => {
      const rc = b.getBoundingClientRect();
      return { label: (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 18), onScreen: rc.right <= innerWidth && rc.left >= 0 };
    }),
  );

  // Select infantry with the army bar, then tap the ground to march.
  try {
    await tapEl(page.locator('.army .btn').nth(0));
    await page.waitForTimeout(800);
    await shot('3-selected');
    const p = await page.evaluate(() => {
      const us = window.__crGame.sim.units.filter((u) => u.side === 'sun' && u.type === 'infantry');
      const x = us.reduce((a, u) => a + u.x, 0) / us.length + 6;
      const z = us.reduce((a, u) => a + u.z, 0) / us.length;
      return window.__crProject(x, 0, z);
    });
    const inView = p.x > 0 && p.x < d.w && p.y > 0 && p.y < d.h;
    if (!inView) r.notes.push('march target off screen in default view');
    await page.touchscreen.tap(Math.min(Math.max(p.x, 20), d.w - 20), Math.min(Math.max(p.y, 20), d.h - 20));
    await page.waitForTimeout(1500);
    r.marching = await page.evaluate(() => window.__crGame.sim.units.filter((u) => u.side === 'sun' && u.type === 'infantry' && u.state === 'moving').length);
    await shot('4-march');
  } catch (e) {
    r.notes.push(`select/march: ${e.message}`);
  }

  // War Table: from the toolbar (scrolling it into view the way a finger would).
  try {
    const wtb = page.locator('.toolbar .btn', { hasText: 'War Table' });
    await wtb.scrollIntoViewIfNeeded();
    await tapEl(wtb);
    await page.waitForSelector('.wartable', { timeout: 5000 });
    await shot('5-wartable');
    await tapEl(page.locator('button[aria-label^="e2"]'));
    await page.waitForTimeout(300);
    await tapEl(page.locator('button[aria-label^="e4"]'));
    await page.waitForTimeout(800);
    r.chessMoved = await page.evaluate(() => document.querySelectorAll('.wt-log li').length);
    await shot('6-wartable-moved');
    const close = page.locator('.wartable button[aria-label="Close"]');
    if (await close.count()) await tapEl(close.first());
  } catch (e) {
    r.notes.push(`war table: ${e.message}`);
  }

  // Tap a single soldier.
  try {
    const p = await page.evaluate(() => {
      const u = window.__crGame.sim.units.find((u) => u.side === 'sun' && u.type === 'archer');
      window.__crCam.jump({ x: u.x, z: u.z, dist: 14 });
      return { id: u.id };
    });
    await page.waitForTimeout(900);
    const sp = await page.evaluate((id) => {
      const u = window.__crGame.sim.unit(id);
      return window.__crProject(u.x, 0.5, u.z);
    }, p.id);
    await page.touchscreen.tap(sp.x, sp.y);
    await page.waitForTimeout(800);
    r.singleSelected = await page.evaluate(() => (window.__crUi ? window.__crUi().length : -1));
    await shot('7-soldier');
  } catch (e) {
    r.notes.push(`tap soldier: ${e.message}`);
  }

  // Pause menu from the toolbar.
  try {
    const pb = page.locator('.toolbar .btn').last();
    await pb.scrollIntoViewIfNeeded();
    await tapEl(pb);
    await page.waitForTimeout(500);
    r.paused = await page.getByRole('dialog', { name: 'Paused' }).isVisible();
    await shot('8-pause');
    await tapEl(page.getByRole('button', { name: 'Resume' }));
  } catch (e) {
    r.notes.push(`pause: ${e.message}`);
  }

  // Help sheet.
  try {
    const hb = page.locator('.toolbar .btn', { hasText: '?' });
    await hb.scrollIntoViewIfNeeded();
    await tapEl(hb);
    await page.waitForTimeout(500);
    await shot('9-help');
    await page.keyboard.press('Escape');
  } catch (e) {
    r.notes.push(`help: ${e.message}`);
  }

  // Battle report.
  await page.evaluate(() => window.__crGame.sim.declareWinner('sun', 'Nocturne Castle has fallen'));
  await page.waitForSelector('.summary-kicker', { timeout: 30_000 }).catch(() => r.notes.push('no battle report'));
  await shot('10-report');
  await ctx.close();
  console.log(`${d.name}: done`);
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
await browser.close();
