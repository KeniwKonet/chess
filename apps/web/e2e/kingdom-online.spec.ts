/**
 * ChessFront online play against a real server process: an account invites a
 * guest by link, they play to checkmate, a spectator watches, and both agree a
 * rematch.
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 8791;
const ONLINE = `http://localhost:${PORT}`;
let server: ChildProcess;

test.beforeAll(async () => {
  server = spawn('npx', ['tsx', 'apps/server/src/main.ts'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: 'memory://', FIRST_MOVE_MS: '600000' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start')), 30_000);
    server.stdout!.on('data', (d) => {
      if (String(d).includes('ChessFront server')) {
        clearTimeout(t);
        res();
      }
    });
  });
});
test.afterAll(() => {
  server?.kill();
});

async function open(browser: Browser, url: string, viewport = { width: 800, height: 560 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => localStorage.setItem('cr-kingdom', JSON.stringify({ animSpeed: 'quick' })));
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('body[data-pieces="1"]', { timeout: 120_000 });
  return page;
}

const plies = (p: Page, n: number) => p.waitForFunction((n) => (window as any).__crKingdom.kc.game.history.length === n, n, { timeout: 60_000 });
const play = async (p: Page, from: string, to: string, n: number) => {
  await plies(p, n - 1);
  await p.waitForFunction(() => !document.querySelector('.k-scrim'), null, { timeout: 60_000 });
  await p.evaluate(([from, to]) => (window as any).__crKingdom.play({ from, to }), [from, to]);
  await plies(p, n);
};

test('invite by link, play to checkmate with a spectator, then rematch', async ({ browser }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  const A = await open(browser, `/?online=${ONLINE}`);
  A.on('pageerror', (e) => errors.push(e.message));
  await A.getByRole('button', { name: /Play online/ }).click();
  await A.getByRole('tab', { name: 'New account' }).click();
  await A.getByLabel('Name').fill('Ada_e2e');
  await A.getByLabel('Password').fill('sunlight-forever');
  await A.getByRole('button', { name: 'Create account' }).click();
  await expect(A.getByText('Connected')).toBeVisible({ timeout: 15_000 });
  await A.getByRole('button', { name: '☀ Sun' }).click();
  await A.getByRole('button', { name: 'Casual' }).click();
  await A.getByRole('button', { name: /Invite a friend/ }).click();
  const link = await A.getByLabel('Invite link').inputValue();
  const code = new URL(link).searchParams.get('play')!;
  expect(link).toContain(`online=${encodeURIComponent(ONLINE)}`);

  const B = await open(browser, link, { width: 390, height: 844 });
  B.on('pageerror', (e) => errors.push(e.message));
  await expect(B.getByText("You've been invited to a battle")).toBeVisible();
  await B.getByRole('button', { name: 'Play as a guest' }).click();
  await expect(B.locator('.k-bar.bottom')).toContainText('(you)', { timeout: 30_000 });
  await expect(A.locator('.k-bar.top')).toContainText('Guest-', { timeout: 30_000 });

  await play(A, 'f2', 'f3', 1);
  await play(B, 'e7', 'e5', 2);
  const C = await open(browser, `/?online=${ONLINE}&watch=${code}`, { width: 480, height: 360 });
  await plies(C, 2);
  await expect(C.getByText(/Watching live/)).toBeVisible();
  await play(A, 'g2', 'g4', 3);
  await play(B, 'd8', 'h4', 4);

  for (const p of [A, B, C]) await expect(p.getByRole('dialog', { name: 'Battle report' })).toContainText('Checkmate', { timeout: 60_000 });
  await expect(B.getByRole('dialog', { name: 'Battle report' })).toContainText('Victory');
  await expect(A.getByRole('dialog', { name: 'Battle report' })).toContainText('Defeat');

  await B.getByRole('button', { name: 'Rematch' }).click();
  await A.getByRole('button', { name: 'Accept the rematch' }).click();
  await A.waitForFunction(() => (window as any).__crKingdom.kc.you === 'b' && !(window as any).__crKingdom.kc.game.over, null, { timeout: 30_000 });
  await B.waitForFunction(() => (window as any).__crKingdom.kc.you === 'w', null, { timeout: 30_000 });
  expect(errors).toEqual([]);
});
