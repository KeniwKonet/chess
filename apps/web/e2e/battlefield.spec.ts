import { test, expect, type Page } from '@playwright/test';

type Pose = { x: number; z: number; yaw: number; dist: number };
const goal = (page: Page) => page.evaluate(() => ({ ...window.__crCam!.cam.goal })) as Promise<Pose>;
const jump = (page: Page, p: Partial<Pose>) => page.evaluate((pp) => window.__crCam!.jump(pp), p);

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  (page as unknown as { errors: string[] }).errors = errors;
  await page.goto('/');
  await page.waitForSelector('body[data-ready="1"]', { timeout: 60_000 });
});

test('loads the battlefield with HUD and no script errors', async ({ page }) => {
  await expect(page.locator('.brand-name')).toHaveText('Chess Realms');
  await expect(page.locator('.resources')).toContainText('820');
  await expect(page.locator('.minimap canvas')).toBeVisible();
  await expect(page.locator('.log')).toContainText('Battlefield loaded');
  expect((page as unknown as { errors: string[] }).errors).toEqual([]);
  // The world draws a few frames after the ready flag; wait for a full frame.
  await expect.poll(async () => (await page.evaluate(() => window.__crPerf!)).calls, { timeout: 20_000 }).toBeGreaterThan(20);
});

test('clicking a building selects it; Esc clears', async ({ page }) => {
  await jump(page, { x: 15, z: 15.59, dist: 20, yaw: 0 }); // Sun barracks at screen centre
  await page.waitForTimeout(1500);
  const vp = page.viewportSize()!;
  await page.mouse.click(vp.width / 2, vp.height / 2);
  await expect(page.locator('.selection h2')).toHaveText('Barracks', { timeout: 15_000 });
  await expect(page.locator('.selection')).toContainText('700 / 700');
  await expect(page.locator('.log')).toContainText('Selected Barracks (Sun)');
  await page.keyboard.press('Escape');
  await expect(page.locator('.selection')).toHaveCount(0);
});

test('clicking open ground inspects the tile and its movement cost', async ({ page }) => {
  await jump(page, { x: 31, z: 19.05, dist: 18, yaw: 0 }); // the Ford of Ash
  await page.waitForTimeout(1500);
  const vp = page.viewportSize()!;
  await page.mouse.click(vp.width / 2, vp.height / 2);
  await expect(page.locator('.selection h2')).toHaveText('Ford', { timeout: 15_000 });
  await expect(page.locator('.selection')).toContainText('Movement cost 2.5');
});

test('drag pans, wheel zooms, keys rotate and jump', async ({ page }) => {
  await jump(page, { x: 30, z: 18, dist: 40, yaw: 0 });
  const a = await goal(page);
  const vp = page.viewportSize()!;
  await page.mouse.move(vp.width / 2, vp.height / 2);
  await page.mouse.down();
  await page.mouse.move(vp.width / 2 - 200, vp.height / 2, { steps: 4 });
  await page.mouse.up();
  const b = await goal(page);
  expect(b.x).toBeGreaterThan(a.x + 2); // dragging left moves the view east
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(300);
  expect((await goal(page)).dist).toBeLessThan(b.dist);
  await page.keyboard.down('q');
  await page.waitForTimeout(500);
  await page.keyboard.up('q');
  expect((await goal(page)).yaw).toBeGreaterThan(0.1);
  await page.keyboard.press('o');
  expect((await goal(page)).dist).toBeGreaterThan(70);
  await page.keyboard.press('h');
  expect((await goal(page)).dist).toBeLessThan(35);
});

test('minimap click moves the camera there', async ({ page }) => {
  await jump(page, { x: 8, z: 17, dist: 30 });
  const box = (await page.locator('.minimap canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.5);
  const g = await goal(page);
  expect(g.x).toBeGreaterThan(45);
});

test('graphics quality switches and reduces draw calls on Low', async ({ page }) => {
  await jump(page, { x: 32, z: 19, dist: 60, yaw: 0 });
  const calls = async () => (await page.evaluate(() => window.__crPerf!)).calls;
  await expect.poll(calls, { timeout: 30_000 }).toBeGreaterThan(20);
  await page.waitForTimeout(1500);
  const high = await calls();
  await page.getByRole('button', { name: 'Low', exact: true }).click();
  // Low drops the shadow pass, so each frame needs fewer draw calls.
  await expect.poll(calls, { timeout: 30_000 }).toBeLessThan(high);
  expect(await calls()).toBeGreaterThan(20);
  await expect(page.locator('.log')).toContainText('Graphics quality: low');
});
