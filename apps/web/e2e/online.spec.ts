/**
 * Online play against a real authoritative server process (apps/server):
 * orders and War Table moves go over WebSocket, and the field log is rebuilt
 * from acks and snapshots.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 8790;
let server: ChildProcess;

test.beforeAll(async () => {
  server = spawn('npx', ['tsx', 'apps/server/src/main.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start')), 30_000);
    server.stdout!.on('data', (d) => {
      if (String(d).includes('Chess Realms server')) {
        clearTimeout(t);
        res();
      }
    });
  });
});
test.afterAll(() => {
  server?.kill();
});

test('joins the server, marches soldiers by right-click and plays the War Table online', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const room = `e2e${Date.now()}`;
  await page.goto(`/?server=${encodeURIComponent(`ws://localhost:${PORT}/?room=${room}&mode=ai&difficulty=recruit`)}`);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Join the online battle' }).click();
  await expect(page.locator('.log')).toContainText("against the server's Moon AI", { timeout: 15_000 });
  await page.waitForSelector('body[data-units="1"]', { timeout: 60_000 });

  // Select the infantry and order a march well away from them.
  await page.locator('.army .btn').nth(0).click();
  await expect(page.locator('.selection h2')).toHaveText('8 Infantry');
  await page.evaluate(() => window.__crCam!.jump({ x: 20, z: 18, dist: 30, yaw: 0 }));
  await page.waitForTimeout(800);
  const pt = await page.evaluate(() => (window as unknown as { __crProject: (x: number, y: number, z: number) => { x: number; y: number } }).__crProject(27, 0.2, 10));
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await expect(page.locator('.log')).toContainText('8 Infantry marching', { timeout: 15_000 });
  await expect
    .poll(async () => page.evaluate(() => (window.__crGame!.sim.units as { side: string; type: string; state: string }[]).filter((u) => u.side === 'sun' && u.type === 'infantry' && u.state === 'moving').length), { timeout: 15_000 })
    .toBeGreaterThan(4);

  // A War Table move goes to the server and comes back on the board.
  await page.keyboard.press('b');
  await page.locator('button[aria-label^="d2"]').click();
  await page.locator('button[aria-label^="d4"]').click();
  await expect(page.locator('.log')).toContainText('War Table, Sun d4: Advance', { timeout: 15_000 });
  // The server's Moon AI replies (Recruit thinks for 12 s).
  await expect(page.locator('.wt-log li')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('.log')).toContainText('War Table, Moon', { timeout: 5_000 });
  expect(errors).toEqual([]);
});
