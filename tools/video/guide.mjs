// Records the "How to play" video guide by driving the real game.
//
// The page runs on Playwright's fake clock and a hijacked requestAnimationFrame,
// so every video frame is exactly one rendered frame at exactly 1/FPS of game
// time, however slow software WebGL is here. Captions, the cursor and click
// ripples are DOM overlays animated per frame from this script (CSS animations
// would run on the real clock and be skipped).
//
//   FPS=20 OUT=frames node tools/video/guide.mjs   then ffmpeg (see make-guide.sh)
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const FPS = Number(process.env.FPS ?? 20);
const DT = 1000 / FPS;
const OUT = process.env.OUT ?? 'frames';
const BASE = process.env.URL ?? 'http://localhost:4174/';
const FONTS = process.env.FONTS; // node_modules/@fontsource folder (Google Fonts is unreachable here)
const W = 1280;
const H = 720;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));

if (FONTS) {
  const face = (fam, pkg, file, weight) =>
    `@font-face{font-family:'${fam}';font-weight:${weight};font-style:normal;font-display:block;src:url(https://fonts.local/${pkg}/files/${file}) format('woff2');}`;
  const css = [
    ...[400, 500, 600, 700].map((w) => face('Barlow', 'barlow', `barlow-latin-${w}-normal.woff2`, w)),
    ...[500, 600, 700].map((w) => face('Barlow Condensed', 'barlow-condensed', `barlow-condensed-latin-${w}-normal.woff2`, w)),
    face('Marcellus', 'marcellus', 'marcellus-latin-400-normal.woff2', 400),
  ].join('\n');
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: css }));
  await page.route('https://fonts.local/**', (r) => {
    const rel = new URL(r.request().url()).pathname.slice(1);
    r.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(path.join(FONTS, rel)) });
  });
}

await page.clock.install();
await page.addInitScript(() => {
  let q = [];
  let manual = false;
  const real = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    if (!manual) return real(cb);
    q.push(cb);
    return q.length;
  };
  window.__manual = () => (manual = true);
  window.__frame = () => {
    const cur = q;
    q = [];
    const t = performance.now();
    for (const cb of cur) cb(t);
  };
});

console.log('setup:', 'await page.goto(BASE);');
await page.goto(BASE);
await page.waitForSelector('body[data-ready="1"]', { timeout: 180_000 });
console.log('setup:', 'fonts');
await page.evaluate(() => document.fonts.ready);
// From here on, the game renders only when this script asks (one render per video frame).
await page.evaluate(() => window.__manual());
// Freeze the fake clock: from now on game time moves only by runFor, never with wall time
// (otherwise the slow software renderer would make the battle run several times too fast).
await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
/** Advance game time without recording, rendering now and then (setup only). */
async function idle(ms) {
  for (let t = 0; t < ms; t += 250) {
    await page.clock.runFor(250);
    await page.evaluate(() => window.__frame());
  }
}

// Set Medium quality once (it remounts the canvas), then back to the title screen to start recording.
await page.evaluate(() => window.__crStart('recruit'));
await idle(1500);
await page.getByRole('button', { name: 'Settings' }).click();
await page.getByRole('button', { name: process.env.QUALITY ?? 'Medium', exact: true }).click();
await page.getByRole('button', { name: 'Close' }).click();
await idle(4000);
await page.keyboard.press('p');
console.log('setup:', "await page.getByRole('button', { name: '");
await page.getByRole('button', { name: 'Quit to title' }).click();
await idle(800);

// ---------------------------------------------------------------- overlay

console.log('setup:', 'await page.addStyleTag({');
await page.addStyleTag({
  content: `
#g-cap{position:fixed;left:660px;bottom:22px;transform:translateX(-50%);width:584px;z-index:2147483000;pointer-events:none;
  background:rgba(22,17,12,.94);border:1px solid rgba(232,190,110,.55);border-radius:14px;padding:13px 18px 14px;
  box-shadow:0 10px 30px rgba(0,0,0,.45);font-family:Barlow,system-ui,sans-serif;color:#F3E9D8}
#g-cap .k{display:flex;align-items:center;gap:10px;font:600 13px/1 'Barlow Condensed',sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#E8BE6E;margin-bottom:6px}
#g-cap .k .n{color:#a8957a}
#g-cap .t{font:500 17.5px/1.38 Barlow,sans-serif}
#g-cap kbd{display:inline-block;min-width:22px;padding:1px 7px;margin:0 1px;border-radius:6px;background:#3a2d1f;border:1px solid #7a6243;
  border-bottom-width:3px;font:600 14px/1.35 Barlow,sans-serif;color:#fff;text-align:center}
#g-cap b{color:#F2C14E;font-weight:600}
#g-cap .moon{color:#8FB6F0;font-weight:600}
#g-card{position:fixed;inset:0;z-index:2147483100;pointer-events:none;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(ellipse at center,rgba(30,22,14,.86),rgba(12,9,6,.97));color:#F3E9D8;font-family:Barlow,sans-serif;text-align:center}
#g-card h1{font:400 64px/1.05 Marcellus,serif;margin:0 0 14px;color:#F2D58C;letter-spacing:.02em}
#g-card h2{font:400 40px/1.1 Marcellus,serif;margin:0 0 18px;color:#F2D58C}
#g-card p{font:500 21px/1.45 Barlow,sans-serif;margin:0 auto;max-width:760px;color:#E9DCC6}
#g-card .kick{font:600 15px/1 'Barlow Condensed',sans-serif;letter-spacing:.24em;text-transform:uppercase;color:#C9A15A;margin-bottom:18px}
#g-card ul{list-style:none;padding:0;margin:8px auto 0;max-width:820px;text-align:left}
#g-card li{font:500 20px/1.4 Barlow,sans-serif;margin:0 0 13px;padding-left:34px;position:relative;color:#EFE3CE}
#g-card li:before{content:'♜';position:absolute;left:0;top:0;color:#E8BE6E}
#g-card .rule{width:120px;height:2px;background:linear-gradient(90deg,transparent,#C9A15A,transparent);margin:22px auto}
#g-cursor{position:fixed;left:0;top:0;z-index:2147483200;pointer-events:none;width:26px;height:26px;margin:-2px 0 0 -3px}
#g-ripple{position:fixed;z-index:2147483150;pointer-events:none;border-radius:50%;border:3px solid #F2C14E}
#g-ff{position:fixed;top:132px;left:50%;transform:translateX(-50%);z-index:2147483000;pointer-events:none;background:rgba(22,17,12,.9);
  border:1px solid rgba(232,190,110,.5);border-radius:999px;padding:6px 14px;font:600 14px/1 'Barlow Condensed',sans-serif;letter-spacing:.12em;color:#E8BE6E;text-transform:uppercase}
`,
});
await page.evaluate(() => {
  const el = (id, html = '') => {
    const d = document.createElement('div');
    d.id = id;
    d.innerHTML = html;
    d.style.display = 'none';
    document.body.appendChild(d);
    return d;
  };
  el('g-cap');
  el('g-card');
  el('g-ff', '');
  el('g-ripple');
  el(
    'g-cursor',
    `<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2 L3 21 L8.2 16.3 L11.8 24 L15.2 22.4 L11.7 14.9 L18.6 14.6 Z" fill="#fff" stroke="#16110C" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  );
  window.__ov = (s) => {
    const cap = document.getElementById('g-cap');
    cap.style.display = s.cap ? 'block' : 'none';
    cap.style.opacity = s.capA;
    if (s.capHtml !== cap.dataset.h) {
      cap.innerHTML = s.capHtml;
      cap.dataset.h = s.capHtml;
    }
    const card = document.getElementById('g-card');
    card.style.display = s.cardA > 0 ? 'flex' : 'none';
    card.style.opacity = s.cardA;
    if (s.cardHtml !== card.dataset.h) {
      card.innerHTML = s.cardHtml;
      card.dataset.h = s.cardHtml;
    }
    const cur = document.getElementById('g-cursor');
    cur.style.display = s.cursor ? 'block' : 'none';
    cur.style.transform = `translate(${s.cx}px,${s.cy}px)`;
    const r = document.getElementById('g-ripple');
    r.style.display = s.rip ? 'block' : 'none';
    if (s.rip) {
      const d = s.rip.size;
      Object.assign(r.style, { left: `${s.rip.x - d / 2}px`, top: `${s.rip.y - d / 2}px`, width: `${d}px`, height: `${d}px`, opacity: s.rip.a, borderColor: s.rip.color });
    }
    const ff = document.getElementById('g-ff');
    ff.style.display = s.ff ? 'block' : 'none';
    if (s.ff) ff.textContent = `Fast-forward ×${s.ff}`;
  };
});

// ---------------------------------------------------------------- director

const ov = { cap: false, capA: 0, capHtml: '', cardA: 0, cardHtml: '', cursor: false, cx: W / 2, cy: H / 2, rip: null, ff: false };
let n = 0;
let speed = 1;
let ripple = null; // { x, y, t, color }
let capFade = null; // { from, to, t, dur }
const cdp = await page.context().newCDPSession(page);
const t0 = Date.now();

const dbg = (...a) => process.env.DEBUG && console.log(`[${n}]`, ...a);
async function frame() {
  dbg('runFor');
  await page.clock.runFor(DT * speed);
  dbg('overlay');
  if (ripple) {
    const k = ripple.t / (0.45 * FPS);
    ov.rip = k >= 1 ? null : { x: ripple.x, y: ripple.y, size: 14 + 46 * k, a: 1 - k, color: ripple.color };
    ripple.t++;
    if (k >= 1) ripple = null;
  }
  if (capFade) {
    const k = Math.min(1, capFade.t / capFade.dur);
    ov.capA = capFade.from + (capFade.to - capFade.from) * k;
    capFade.t++;
    if (k >= 1) {
      if (capFade.to === 0) ov.cap = false;
      capFade = null;
    }
  }
  ov.ff = speed > 1 ? speed : 0;
  await page.evaluate((s) => {
    window.__ov(s);
    window.__frame();
  }, ov);
  dbg('shot');
  const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  fs.writeFileSync(path.join(OUT, `f${String(n++).padStart(5, '0')}.jpg`), Buffer.from(r.data, 'base64'));
  if (n % 100 === 0) console.log(`${n} frames (${(n / FPS).toFixed(1)} s of video), ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);
}
const hold = async (s) => {
  for (let i = 0, k = Math.round(s * FPS); i < k; i++) await frame();
};
/** Render frames until fn() (evaluated in the page) is truthy, or max seconds pass. */
async function until(fn, max, arg) {
  for (let i = 0, k = Math.round(max * FPS); i < k; i++) {
    if (await page.evaluate(fn, arg)) return true;
    await frame();
  }
  console.warn('until: gave up after', max, 's');
  return false;
}

async function caption(step, title, html) {
  ov.cap = true;
  ov.capHtml = `<div class="k">${step ? `<span class="n">${step}</span>` : ''}<span>${title}</span></div><div class="t">${html}</div>`;
  capFade = { from: 0, to: 1, t: 0, dur: Math.round(0.3 * FPS) };
}
async function hideCaption() {
  capFade = { from: ov.capA, to: 0, t: 0, dur: Math.round(0.25 * FPS) };
}
async function card(html, s, fadeIn = 0.5, fadeOut = 0.5) {
  ov.cardHtml = html;
  const fi = Math.round(fadeIn * FPS);
  for (let i = 0; i < fi; i++) {
    ov.cardA = (i + 1) / fi;
    await frame();
  }
  ov.cardA = 1;
  await hold(s);
  const fo = Math.round(fadeOut * FPS);
  for (let i = 0; i < fo; i++) {
    ov.cardA = 1 - (i + 1) / fo;
    await frame();
  }
  ov.cardA = 0;
}
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
async function moveTo(x, y, s = 0.6) {
  ov.cursor = true;
  const sx = ov.cx;
  const sy = ov.cy;
  const k = Math.max(1, Math.round(s * FPS));
  for (let i = 1; i <= k; i++) {
    const e = ease(i / k);
    ov.cx = sx + (x - sx) * e;
    ov.cy = sy + (y - sy) * e;
    await page.mouse.move(ov.cx, ov.cy);
    await frame();
  }
}
async function click(button = 'left') {
  ripple = { x: ov.cx, y: ov.cy, t: 0, color: button === 'right' ? '#FF6B5B' : '#F2C14E' };
  await page.mouse.click(ov.cx, ov.cy, { button });
  await frame();
}
async function clickAt(x, y, button = 'left', s = 0.6) {
  await moveTo(x, y, s);
  await hold(0.15);
  await click(button);
}
async function clickEl(locator, button = 'left', s = 0.6) {
  const b = await locator.boundingBox();
  if (!b) throw new Error(`not visible: ${locator}`);
  await clickAt(b.x + b.width / 2, b.y + b.height / 2, button, s);
}
async function drag(x0, y0, x1, y1, s = 0.9, button = 'left') {
  await moveTo(x0, y0, 0.5);
  await page.mouse.down({ button });
  const k = Math.round(s * FPS);
  for (let i = 1; i <= k; i++) {
    const e = ease(i / k);
    ov.cx = x0 + (x1 - x0) * e;
    ov.cy = y0 + (y1 - y0) * e;
    await page.mouse.move(ov.cx, ov.cy);
    await frame();
  }
  await page.mouse.up({ button });
  await frame();
}
const project = (x, z, y = 0.3) => page.evaluate(([x, y, z]) => window.__crProject(x, y, z), [x, y, z]);
const fly = (p) => page.evaluate((p) => window.__crCam.flyTo(p), p);
const sim = (fn, arg) => page.evaluate(fn, arg);

// ---------------------------------------------------------------- the guide

console.log('setup:', '// Intro card over the title screen.');
// Intro card over the title screen.
ov.cursor = false;
await card(
  `<div><div class="kick">A two-minute guide</div><h1>How to play<br>Chess Realms</h1><div class="rule"></div>
   <p>A real-time battle and a game of chess, fought at the same time.<br>Every chess move gives orders to your army.</p></div>`,
  4.2,
  0.6,
  0.7,
);

// 1. Start.
ov.cx = 900;
ov.cy = 560;
await caption('1 / 9', 'Start a battle', 'Choose how tough the <span class="moon">Moon</span> should be. <b>Recruit</b> is the gentlest. Then press <b>Begin the battle</b>.');
await hold(1.4);
await clickEl(page.locator('label.diff').nth(0), 'left', 0.8);
await hold(0.6);
await clickEl(page.getByRole('button', { name: 'Begin the battle' }), 'left', 0.7);
await hold(0.4);
// The guide drives the Moon's army itself so the right things happen on camera.
// (The Moon still plays its War Table moves on its own.)
await sim(() => {
  const g = window.__crGame;
  g.match.commander = null;
  g.match.patrol = null;
  // Keep the Moon's towers quiet so the demonstration fight at the ford isn't decided by tower fire.
  for (const b of g.sim.buildings) if (b.side === 'moon' && b.type === 'tower') b.weapon = null;
});
const W0 = await sim(() => {
  const s = window.__crGame.sim;
  const pick = (f) => {
    const b = s.buildings.find(f);
    return { x: b.x, z: b.z, id: b.id };
  };
  return {
    sunCastle: pick((b) => b.side === 'sun' && b.type === 'castle'),
    moonCastle: pick((b) => b.side === 'moon' && b.type === 'castle'),
    captures: Object.fromEntries(s.captures.map((c) => [c.id, { x: c.x, z: c.z, name: c.name, r: c.radius }])),
  };
});
console.log(JSON.stringify(W0));
await hold(1.2);
await hideCaption();

// 2. The goal.
ov.cursor = false;
await caption(
  '2 / 9',
  'Your goal',
  'You lead the <b>Sun</b> (gold) in the west. The <span class="moon">Moon</span> (blue) holds the east, across the river. Win by <b>destroying Nocturne Castle</b>, or by <b>checkmate</b> on the War Table.',
);
await fly({ x: 32, z: 19, dist: 82, yaw: 0 });
await hold(3.6);
await fly({ x: W0.moonCastle.x, z: W0.moonCastle.z, dist: 26, yaw: 0 });
await hold(3.0);
await fly({ x: W0.sunCastle.x + 5, z: W0.sunCastle.z + 1, dist: 28, yaw: 0 });
await hold(2.6);
await hideCaption();

// 3. Camera.
await caption(
  '3 / 9',
  'Look around',
  '<b>Right-drag</b> to pan, <b>scroll</b> to zoom, <kbd>Q</kbd> <kbd>E</kbd> to turn, <kbd>N</kbd> to face north again. On a phone: drag, pinch and twist.',
);
await hold(0.8);
await drag(780, 380, 560, 420, 1.0, 'right');
await hold(0.3);
for (let i = 0; i < 4; i++) {
  await page.mouse.wheel(0, -260);
  await hold(0.18);
}
await hold(0.6);
await page.keyboard.down('e');
await hold(1.0);
await page.keyboard.up('e');
await hold(0.6);
await page.keyboard.press('n');
await hold(1.0);
await hideCaption();

// 4. Select.
const army = await sim(() => {
  const us = window.__crGame.sim.units.filter((u) => u.side === 'sun');
  const avg = (t) => {
    const g = us.filter((u) => u.type === t);
    return { x: g.reduce((a, u) => a + u.x, 0) / g.length, z: g.reduce((a, u) => a + u.z, 0) / g.length };
  };
  return { inf: avg('infantry'), arc: avg('archer') };
});
await fly({ x: (army.inf.x + army.arc.x) / 2, z: (army.inf.z + army.arc.z) / 2, dist: 20, yaw: 0 });
await hold(0.4);
await caption(
  '4 / 9',
  'Choose your soldiers',
  'Use the <b>army buttons</b> (top left) for infantry, archers or everyone, click a single soldier, or <b>left-drag a box</b> around them.',
);
await hold(1.0);
await clickEl(page.locator('.army .btn').nth(0));
await hold(1.4);
const arcBox = await sim(() => {
  const us = window.__crGame.sim.units.filter((u) => u.side === 'sun' && u.type === 'archer');
  const pts = us.map((u) => window.__crProject(u.x, 0.4, u.z));
  return { x0: Math.min(...pts.map((p) => p.x)) - 26, y0: Math.min(...pts.map((p) => p.y)) - 34, x1: Math.max(...pts.map((p) => p.x)) + 26, y1: Math.max(...pts.map((p) => p.y)) + 22 };
});
await drag(arcBox.x0, arcBox.y0, arcBox.x1, arcBox.y1, 1.0);
await hold(1.6);
await clickEl(page.locator('.army .btn').nth(2));
await hold(1.2);
await hideCaption();

// 5. Move.
const ford = W0.captures.ford ?? Object.values(W0.captures)[0];
await caption(
  '5 / 9',
  'March',
  '<b>Right-click the ground</b> to march there. Soldiers find their own way: <b>roads are fastest</b>, and the river can only be crossed at the bridges and the ford.',
);
await fly({ x: (army.inf.x + ford.x) / 2, z: (army.inf.z + ford.z) / 2, dist: 30, yaw: 0 });
await hold(1.0);
let p = await project(ford.x, ford.z);
await clickAt(p.x, p.y, 'right', 0.8);
await hold(1.0);
ov.cursor = false;
await fly({ x: ford.x - 3, z: ford.z, dist: 24, yaw: 0 });
await hold(1.5);
speed = 2;
await hold(2.0);
speed = 1;
await hideCaption();

// 6. Capture.
await caption(
  '6 / 9',
  'Take the ground',
  'Stand inside a <b>ring</b> to capture it, as long as no enemy is inside. Hold the <b>Ford of Ash</b>, the <b>Old Mill</b> and <b>Vey Watchtower</b>. Vey lets your soldiers see further.',
);
speed = 2;
await until(() => window.__crGame.sim.captures.find((c) => c.id === 'ford')?.owner === 'sun', 25);
speed = 1;
await hold(2.0);
await hideCaption();

// Send a Moon company toward the ford for the fight (they start out of sight, in the fog).
await sim((f) => {
  const s = window.__crGame.sim;
  const moon = s.units.filter((u) => u.side === 'moon');
  const inf = moon.filter((u) => u.type === 'infantry').slice(0, 3);
  const arc = moon.filter((u) => u.type === 'archer').slice(0, 1);
  [...inf, ...arc].forEach((u, i) => {
    u.x = f.x + 9 + (i % 3) * 0.8;
    u.z = f.z - 1 + Math.floor(i / 3) * 0.9;
  });
  s.issue({ kind: 'move', side: 'moon', ids: [...inf, ...arc].map((u) => u.id), x: f.x + 3.2, z: f.z, attack: true });
}, ford);

// 7. Fog, then fight.
await caption('7 / 9', 'Fog of war', 'Darker ground is <b>fog of war</b>. You only see enemies close to your soldiers and buildings, so scout before you charge.');
await fly({ x: ford.x + 6, z: ford.z, dist: 46, yaw: 0 });
await hold(4.2);
await hideCaption();
await fly({ x: ford.x + 2, z: ford.z, dist: 22, yaw: 0 });
speed = 2;
await until(() => window.__crGame.sim.units.some((u) => u.side === 'moon' && u.hp > 0 && window.__crGame.sim.sees('sun', u.x, u.z)), 12);
speed = 1;
await caption(
  '7 / 9',
  'Fight',
  'Enemy in sight! <b>Right-click an enemy</b> to attack it. Or press <kbd>T</kbd>, then right-click, to <b>attack-move</b>: march and fight anything on the way.',
);
await hold(0.6);
const foe = await sim(() => {
  const s = window.__crGame.sim;
  const u = s.units.find((u) => u.side === 'moon' && u.hp > 0 && u.type === 'infantry' && s.sees('sun', u.x, u.z)) ?? s.units.find((u) => u.side === 'moon' && u.hp > 0 && s.sees('sun', u.x, u.z));
  return { x: u.x, z: u.z };
});
p = await project(foe.x, foe.z, 0.5);
await clickAt(p.x, p.y, 'right', 0.7);
ov.cursor = false;
await until(() => !window.__crGame.sim.units.some((u) => u.side === 'moon' && u.hp > 0 && window.__crGame.sim.sees('sun', u.x, u.z) && Math.hypot(u.x - 30, u.z - 15) < 30), 16);
await hold(1.2);
await hideCaption();

// 8. War Table.
await caption(
  '8 / 9',
  'The War Table',
  'Press <kbd>B</kbd> or the <b>War Table</b> button. It is a real game of chess against the Moon, played during the battle. Move whenever it says <b>Your move</b>.',
);
await hold(1.6);
await moveTo(640, 300, 0.5);
await page.keyboard.press('b');
await hold(1.4);
// Play a pawn whose soldier is still alive, so the move visibly gives an order.
const file = await sim(() => {
  const wt = window.__crGame.match.warTable;
  for (const f of ['e', 'd', 'c', 'f', 'b', 'g', 'a', 'h']) {
    const b = wt.bonds.on(`${f}2`);
    if (b && b.role === 'p' && !wt.bonds.leaderless(b, wt.live) && wt.targets(`${f}2`).includes(`${f}4`)) return f;
  }
  return 'e';
});
console.log('pawn file', file);
await clickEl(page.locator(`button[aria-label^="${file}2"]`));
await hold(0.4);
await clickEl(page.locator(`button[aria-label^="${file}4"]`));
await hold(1.8);
await hideCaption();
await caption(
  '8 / 9',
  'Every piece commands part of your army',
  'Your pawn moved, so <b>its soldier marches forward</b>. Bishops make archers shoot faster, rooks power up towers, the queen rallies everyone, the king repairs your castle.',
);
const legend = page.getByText('What each piece does');
await clickEl(legend);
await hold(0.4);
await moveTo(650, 600, 0.6);
await hold(5.2);
await hideCaption();
await caption(
  '8 / 9',
  'Your move, then theirs',
  'The <span class="moon">Moon</span> thinks, then replies. Capturing a piece <b>weakens the soldiers it commands</b>, and <b>checkmate wins the whole battle</b>.',
);
speed = 4;
await until(() => document.querySelectorAll('.wt-log li').length >= 2, 12);
speed = 1;
await hold(3.0);
await page.keyboard.press('b');
await hideCaption();

// 9. Soldier details, reinforcements, pause.
const one = await sim(() => {
  const s = window.__crGame.sim;
  const u = s.units.find((u) => u.side === 'sun' && u.hp > 0 && u.type === 'archer') ?? s.units.find((u) => u.side === 'sun' && u.hp > 0);
  return { x: u.x, z: u.z };
});
await fly({ x: one.x, z: one.z, dist: 18, yaw: 0 });
await hold(0.8);
await caption(
  '9 / 9',
  'Keep an eye on things',
  '<b>Click a soldier</b> to see its health and what it is doing. Every 90 seconds your barracks and archery range send <b>reinforcements</b>. Towers and castles shoot at enemies nearby.',
);
const now1 = await sim(() => {
  const s = window.__crGame.sim;
  const u = s.units.find((u) => u.side === 'sun' && u.hp > 0 && u.type === 'archer') ?? s.units.find((u) => u.side === 'sun' && u.hp > 0);
  return { x: u.x, z: u.z };
});
p = await project(now1.x, now1.z, 0.5);
await clickAt(p.x, p.y, 'left', 0.8);
await hold(4.0);
await hideCaption();
await caption('9 / 9', 'Take a breather', 'Press <kbd>P</kbd> or the <b>❚❚</b> button to pause at any time. <kbd>?</kbd> shows every control.');
await moveTo(1237, 93, 0.8);
await hold(0.2);
await click();
await hold(1.8);
await clickEl(page.getByRole('button', { name: 'Resume' }));
await hold(0.8);
await hideCaption();

// Victory: the Sun storms Nocturne (shown after a "later" card).
ov.cursor = false;
await sim((c) => {
  const s = window.__crGame.sim;
  const castle = s.buildings.find((b) => b.id === c.id);
  castle.hp = Math.min(castle.hp, 70);
  const us = s.units.filter((u) => u.side === 'sun' && u.hp > 0);
  us.forEach((u, i) => {
    const a = Math.PI * (0.65 + (i / us.length) * 0.7);
    u.x = c.x + Math.cos(a) * 6;
    u.z = c.z + Math.sin(a) * 6;
  });
  // The Moon's soldiers are elsewhere; this is the final assault.
  // (Removed cleanly as if long fallen: dead, with corpses already cleared next tick.)
  s.units.filter((u) => u.side === 'moon').forEach((u) => Object.assign(u, { hp: 0, state: 'dead', deadAt: s.tick - 100, goal: null, goalHex: null, target: null }));
  s.issue({ kind: 'attack', side: 'sun', ids: us.map((u) => u.id), target: { kind: 'building', id: c.id } });
}, W0.moonCastle);
await page.evaluate((c) => window.__crCam.jump({ x: c.x - 2, z: c.z, dist: 24, yaw: 0 }), W0.moonCastle);
await card(`<div><div class="kick">Later in the battle</div><h2>The Sun storms Nocturne</h2></div>`, 1.4, 0.4, 0.5);
await caption('', 'Victory', 'Bring down <b>Nocturne Castle</b>, or checkmate the Moon, to win. The <b>battle report</b> shows how the fight went.');
await until(() => !!window.__crGame.sim.winner, 20);
await until(() => !!document.querySelector('.summary-kicker'), 8);
await hideCaption();
await hold(3.6);

// Tips and outro.
await card(
  `<div><h2>Tips for your first battle</h2>
   <ul>
     <li>Keep <b style="color:#F2C14E">archers behind your infantry</b>: they hit hard from range but are fragile up close.</li>
     <li>Take the <b style="color:#F2C14E">Ford of Ash</b> early. It is the shortest way across the river.</li>
     <li>Play the War Table between fights: a <b style="color:#F2C14E">bishop</b> or <b style="color:#F2C14E">queen</b> move just before a clash makes your army stronger.</li>
     <li>Lost track? Press <b style="color:#F2C14E">?</b> in the game for every control.</li>
   </ul></div>`,
  7.5,
  0.6,
  0.6,
);
await card(`<div><div class="kick">Now take the field</div><h1>Chess Realms</h1><div class="rule"></div><p>Sun against Moon. Board against battlefield.</p></div>`, 3.0, 0.6, 0.8);

console.log(`done: ${n} frames, ${(n / FPS).toFixed(1)} s, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
await browser.close();
