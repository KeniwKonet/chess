/**
 * Chess Kingdom: every soldier is a chess piece; taps select and move; the
 * rules, clocks, promotion, check and mate come from chess.js.
 */
import { test, expect, type Page } from '@playwright/test';

type K = {
  kc: { game: { history: { san: string }[]; tracker: { on: (s: string) => { role: string; colour: string } | undefined }; result: unknown } };
  project: (sq: string) => { x: number; y: number };
  play: (m: string) => boolean;
  startGame: (o: Record<string, unknown>) => void;
  settleCamera: () => void;
};
const k = (page: Page) => page.evaluate(() => (window as unknown as { __crKingdom: K }).__crKingdom !== undefined);
const history = (page: Page) => page.evaluate(() => (window as unknown as { __crKingdom: K }).__crKingdom.kc.game.history.map((m) => m.san));
async function tap(page: Page, sq: string) {
  const p = await page.evaluate((s) => (window as unknown as { __crKingdom: K }).__crKingdom.project(s), sq);
  await page.mouse.click(p.x, p.y);
}
async function settle(page: Page) {
  await page.evaluate(() => (window as unknown as { __crKingdom: K }).__crKingdom.settleCamera());
  await page.waitForTimeout(600);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => /Shader Error|program not valid/.test(m.text()) && errors.push(m.text()));
  (page as unknown as { errors: string[] }).errors = errors;
  await page.goto('/');
  await page.waitForSelector('body[data-ready="1"]', { timeout: 120_000 });
  await page.waitForSelector('body[data-pieces="1"]', { timeout: 120_000 });
});
test.afterEach(async ({ page }) => {
  expect((page as unknown as { errors: string[] }).errors).toEqual([]);
});

test('home offers the computer and two-player games; tap a soldier, see its role and moves, move, and the computer replies', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Chess Realms' })).toBeVisible();
  await page.getByRole('button', { name: /Play the computer/ }).click();
  await page.locator('label.diff', { hasText: 'Squire' }).click();
  await page.getByRole('button', { name: /Sun \(moves first\)/ }).click();
  await page.getByRole('button', { name: 'No clock' }).click();
  await page.getByRole('button', { name: 'To battle' }).click();
  expect(await k(page)).toBe(true);
  await settle(page);
  await tap(page, 'g1');
  await expect(page.locator('.k-card')).toContainText('Raider');
  await expect(page.locator('.k-card')).toContainText('Leaps in an L');
  await expect(page.locator('.k-card')).toContainText('2 squares it can reach');
  // e5 is not a knight move: nothing happens.
  await tap(page, 'e5');
  expect(await history(page)).toEqual([]);
  await tap(page, 'g1');
  await tap(page, 'f3');
  await expect.poll(() => history(page)).toEqual(['Nf3']);
  await expect.poll(async () => (await history(page)).length, { timeout: 60_000 }).toBe(2);
  await expect(page.locator('.k-bar.top')).toContainText('Moon · Squire (computer)');
});

test('an enemy soldier shows its card but cannot be moved', async ({ page }) => {
  await page.getByRole('button', { name: /Two players/ }).click();
  await page.getByRole('button', { name: 'To battle' }).click();
  await settle(page);
  await tap(page, 'd8');
  await expect(page.locator('.k-card')).toContainText('Sorceress');
  await expect(page.locator('.k-card')).not.toContainText('can reach');
  await tap(page, 'd5');
  expect(await history(page)).toEqual([]);
});

test('promotion asks which soldier the Footman becomes, and it becomes that piece', async ({ page }) => {
  await page.evaluate(() => (window as unknown as { __crKingdom: K }).__crKingdom.startGame({ opponent: 'local', tc: 'untimed', fen: '8/4P3/8/8/8/8/k7/4K3 w - - 0 1' }));
  await settle(page);
  await tap(page, 'e7');
  await tap(page, 'e8');
  await expect(page.getByRole('dialog', { name: 'Promotion' })).toBeVisible();
  await page.getByRole('button', { name: /Raider/ }).click();
  await expect.poll(() => history(page)).toEqual(['e8=N']);
  expect(await page.evaluate(() => (window as unknown as { __crKingdom: K }).__crKingdom.kc.game.tracker.on('e8'))).toMatchObject({ role: 'n', colour: 'w' });
});

test('checkmate ends the battle with a report; Rematch starts again', async ({ page }) => {
  await page.getByRole('button', { name: /Two players/ }).click();
  await page.getByRole('button', { name: 'To battle' }).click();
  for (const m of ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']) expect(await page.evaluate((mv) => (window as unknown as { __crKingdom: K }).__crKingdom.play(mv), m)).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Battle report' })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('dialog', { name: 'Battle report' })).toContainText('Checkmate. The Sun wins.');
  await page.getByRole('button', { name: 'Rematch' }).click();
  await expect(page.getByRole('dialog', { name: 'Battle report' })).toHaveCount(0);
  expect(await history(page)).toEqual([]);
});

test('chess clocks: the side to move runs down; the menu offers resign', async ({ page }) => {
  await page.getByRole('button', { name: /Two players/ }).click();
  await page.getByRole('button', { name: /^3 min/ }).click();
  await page.getByRole('button', { name: 'To battle' }).click();
  await expect(page.getByLabel('Sun clock')).toHaveText('3:00');
  expect(await page.evaluate(() => (window as unknown as { __crKingdom: K }).__crKingdom.play('e4'))).toBe(true);
  await expect(page.getByLabel('Sun clock')).toHaveText('3:02'); // increment
  await expect.poll(async () => page.getByLabel('Moon clock').textContent(), { timeout: 10_000 }).not.toBe('3:00');
  await page.getByRole('button', { name: 'Game menu' }).click();
  await page.getByRole('button', { name: '⚑ Resign' }).click();
  await expect(page.getByRole('dialog', { name: 'Battle report' })).toContainText('resigns', { timeout: 60_000 });
});

test('battle mode is still one link away', async ({ page }) => {
  await page.getByRole('link', { name: /Battle mode/ }).click();
  await page.waitForSelector('body[data-ready="1"]', { timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Begin the battle' })).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true });
  test('home, setup and the game fit the screen, and taps move soldiers', async ({ page }) => {
    const offscreen = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('button')]
          .filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && getComputedStyle(b).visibility !== 'hidden' && (r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1 || r.top < -1);
          })
          .map((b) => b.textContent?.trim()),
      );
    expect(await offscreen()).toEqual([]);
    await page.getByRole('button', { name: /Two players/ }).tap();
    await page.getByRole('button', { name: 'To battle' }).tap();
    await settle(page);
    expect(await offscreen()).toEqual([]);
    const p = await page.evaluate(() => (window as unknown as { __crKingdom: K }).__crKingdom.project('e2'));
    await page.touchscreen.tap(p.x, p.y);
    const q = await page.evaluate(() => (window as unknown as { __crKingdom: K }).__crKingdom.project('e4'));
    await page.touchscreen.tap(q.x, q.y);
    await expect.poll(() => history(page)).toEqual(['e4']);
  });
});
