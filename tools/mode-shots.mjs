// Takes the screenshots on the mode picker cards (apps/web/public/modes/*.jpg).
// Needs the built game on :4174 (`npm run preview -w @cr/web -- --port 4174`)
// and a server on :8787 started with FIRST_MOVE_MS=600000 DATA_DIR=memory://.
//   node tools/mode-shots.mjs [ai local online clusters battle]
import { chromium } from '@playwright/test';
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const GAME = process.env.GAME ?? 'http://localhost:4174';
const API = process.env.API ?? 'http://localhost:8787';
const OUT = process.env.OUT ?? 'apps/web/public/modes';
const TMP = process.env.TMP_DIR ?? '/tmp';
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
const want = (m) => !only.length || only.includes(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = Date.now() % 100000;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function page(path, token) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  await ctx.addInitScript((t) => {
    localStorage.setItem('cr-kingdom', JSON.stringify({ animSpeed: 'quick', sound: false }));
    if (t) localStorage.setItem('cf-token', t);
  }, token ?? null);
  const p = await ctx.newPage();
  await p.goto(GAME + path);
  return p;
}
async function save(p, name) {
  const raw = `${TMP}/mode-${name}.png`;
  await p.screenshot({ path: raw });
  execFileSync('python3', ['-c', `from PIL import Image; im=Image.open('${raw}').convert('RGB').resize((480,300), Image.LANCZOS); im.save('${OUT}/${name}.jpg', quality=82, optimize=True)`]);
  await p.context().close();
  console.log('saved', name);
}
const kingdomReady = (p) => p.waitForSelector('body[data-pieces="1"]', { timeout: 240000 });
const settle = async (p, ms = 2500) => {
  await p.waitForTimeout(ms);
  await p.evaluate(() => window.__crKingdom.settleCamera());
  await p.waitForTimeout(800);
};

async function call(path, token, body) {
  const r = await fetch(API + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return r.json();
}
async function account(name) {
  const r = await call('/api/register', null, { name, password: 'correct horse battery' });
  if (!r.token) throw new Error(JSON.stringify(r));
  return { token: r.token, id: r.user.id, name };
}
function sock(token) {
  return new Promise((res) => {
    const ws = new WebSocket(API.replace('http', 'ws') + '/online');
    const msgs = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      msgs.push(m);
      for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
    });
    ws.on('open', () => {
      const s = {
        send: (m) => ws.send(JSON.stringify(m)),
        wait: (pred) => new Promise((r) => { const hit = msgs.find(pred); if (hit) { msgs.splice(msgs.indexOf(hit), 1); return r(hit); } waiters.push({ pred, res: r }); }),
        close: () => ws.close(),
      };
      s.send({ t: 'auth', token });
      s.wait((m) => m.t === 'ready').then(() => res(s));
    });
  });
}

const ITALIAN = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5';
const MIDGAME = 'r2q1rk1/pp2bppp/2n1pn2/3p4/3P1B2/2PB1N2/PP1N1PPP/R2Q1RK1 b - - 3 10';

if (want('ai')) {
  const p = await page('/');
  await kingdomReady(p);
  await p.evaluate((fen) => window.__crKingdom.startGame({ opponent: 'ai', side: 'w', tc: '10+5', level: 'knight', fen }), ITALIAN);
  await settle(p);
  const q = await p.evaluate(() => window.__crKingdom.project('f3'));
  await p.mouse.click(q.x, q.y);
  await p.waitForTimeout(900);
  await save(p, 'ai');
}

if (want('local')) {
  const p = await page('/');
  await kingdomReady(p);
  await p.evaluate((fen) => window.__crKingdom.startGame({ opponent: 'local', tc: '5+3', fen }), MIDGAME);
  await settle(p);
  await p.evaluate(() => window.__crKingdom.play({ from: 'f6', to: 'e4' }));
  await p.waitForTimeout(1600);
  await save(p, 'local');
}

if (want('online')) {
  const a = await account(`Kenneth${uniq}`.slice(0, 20));
  const b = await account(`Amara${uniq}`.slice(0, 20));
  const sb = await sock(b.token);
  sb.send({ t: 'invite', tc: '5+3', colour: 'b', rated: true });
  const { code } = await sb.wait((m) => m.t === 'invited');
  const p = await page(`/?play=${code}`, a.token);
  await kingdomReady(p);
  await p.waitForFunction(() => window.__crKingdom.kc.opponent === 'online', null, { timeout: 60000 });
  const moves = [['e2', 'e4'], ['c7', 'c5'], ['g1', 'f3'], ['d7', 'd6'], ['d2', 'd4'], ['c5', 'd4'], ['f3', 'd4'], ['g8', 'f6']];
  for (let i = 0; i < moves.length; i++) {
    const [from, to] = moves[i];
    if (i % 2 === 0) {
      await p.waitForFunction((n) => window.__crKingdom.kc.game.history.length === n, i, { timeout: 60000 });
      await p.evaluate(([from, to]) => window.__crKingdom.play({ from, to }), [from, to]);
    } else {
      sb.send({ t: 'move', code, ply: i, move: { from, to } });
    }
    await p.waitForFunction((n) => window.__crKingdom.kc.game.history.length === n, i + 1, { timeout: 60000 });
    await sleep(300);
  }
  await settle(p, 3000);
  await save(p, 'online');
  sb.close();
}

if (want('clusters')) {
  const k1 = await account(`KingSun${uniq}`.slice(0, 20));
  const ada = await account(`Ada${uniq}`.slice(0, 20));
  const tunde = await account(`Tunde${uniq}`.slice(0, 20));
  const k2 = await account(`KingMoon${uniq}`.slice(0, 20));
  await call('/api/clusters/new', k1.token, { name: `Okeigbo Lions ${uniq % 100}`, motto: 'One army' });
  const sunName = `Okeigbo Lions ${uniq % 100}`;
  await call('/api/clusters/new', k2.token, { name: `Lagos Ravens ${uniq % 100}` });
  for (const m of [ada, tunde]) {
    await call(`/api/clusters/${encodeURIComponent(sunName)}/join`, m.token, {});
    await call(`/api/clusters/${encodeURIComponent(sunName)}/decide`, k1.token, { user: m.id, as: 'member' });
  }
  await call(`/api/clusters/${encodeURIComponent(sunName)}/role`, k1.token, { user: ada.id, role: 'n2' });
  await call(`/api/clusters/${encodeURIComponent(sunName)}/role`, k1.token, { user: tunde.id, role: 'b2' });
  const s1 = await sock(k1.token);
  const s2 = await sock(k2.token);
  const sa = await sock(ada.token);
  const st = await sock(tunde.token);
  s1.send({ t: 'clash-create', turnSecs: 60, target: `Lagos Ravens ${uniq % 100}` });
  const { code } = await s1.wait((m) => m.t === 'clash-created');
  s2.send({ t: 'clash-accept', code });
  const v = (await s1.wait((m) => m.t === 'clash' && m.clash.status === 'playing')).clash;
  const sun = v.white.name === sunName ? 'w' : 'b';
  const kingOf = { [sun]: s1, [sun === 'w' ? 'b' : 'w']: s2 };
  // A few moves by the Kings, from White's point of view, so the Sun cluster ends up to move.
  const opening = [['e2', 'e4'], ['e7', 'e5'], ['d2', 'd4'], ['e5', 'd4']];
  if (sun === 'b') opening.push(['c2', 'c3']);
  let ply = 0;
  for (const [from, to] of opening) {
    const side = ply % 2 === 0 ? 'w' : 'b';
    kingOf[side].send({ t: 'clash-propose', code, ply, move: { from, to } });
    ply++;
    await s1.wait((m) => m.t === 'clash' && m.clash.moves.length === ply);
  }
  // The browser is the Sun King, seeing his members' proposals.
  const p = await page(`/?clash=${code}`, k1.token);
  await kingdomReady(p);
  await p.waitForFunction(() => window.__crKingdom.kc.opponent === 'clash', null, { timeout: 60000 });
  const r1 = sun === 'w' ? 1 : 8;
  sa.send({ t: 'clash-propose', code, ply, move: { from: `g${r1}`, to: `f${sun === 'w' ? 3 : 6}` } });
  st.send({ t: 'clash-propose', code, ply, move: { from: `f${r1}`, to: `c${sun === 'w' ? 4 : 5}` } });
  await sleep(600);
  const props = (await sa.wait((m) => m.t === 'clash' && m.clash.proposals.length === 2)).clash.proposals;
  st.send({ t: 'clash-back', code, id: props.find((x) => x.byName.startsWith('Ada')).id });
  await settle(p, 3000);
  await save(p, 'clusters');
  for (const s of [s1, s2, sa, st]) s.close();
}

if (want('battle')) {
  const p = await page('/?mode=battle');
  await p.waitForSelector('body[data-ready="1"]', { timeout: 240000 });
  await p.getByRole('button', { name: 'Begin the battle' }).click();
  await p.waitForSelector('body[data-units="1"]', { timeout: 240000 });
  await p.waitForTimeout(9000);
  await save(p, 'battle');
}

await browser.close();
