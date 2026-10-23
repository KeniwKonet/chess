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

test('right-drag pans, wheel zooms, keys rotate and jump', async ({ page }) => {
  await jump(page, { x: 30, z: 18, dist: 40, yaw: 0 });
  const a = await goal(page);
  const vp = page.viewportSize()!;
  await page.mouse.move(vp.width / 2, vp.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(vp.width / 2 - 200, vp.height / 2, { steps: 4 });
  await page.mouse.up({ button: 'right' });
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

type U = { id: number; side: string; type: string; state: string; x: number; z: number };
const units = (page: Page) =>
  page.evaluate(() => window.__crGame!.sim.units.map((u: U) => ({ id: u.id, side: u.side, type: u.type, state: u.state, x: u.x, z: u.z }))) as Promise<U[]>;
const selected = (page: Page) => page.evaluate(() => (window as unknown as { __crUi: () => number[] }).__crUi());

test.describe('units', () => {
  test.beforeEach(async ({ page }) => {
    await page.waitForSelector('body[data-units="1"]', { timeout: 60_000 });
  });

  test('army bar selects a company; right-click orders it to march and arrive', async ({ page }) => {
    await jump(page, { x: 21, z: 16, dist: 20, yaw: 0 });
    await page.locator('.army .btn').first().click();
    await expect(page.locator('.selection h2')).toHaveText('8 Infantry');
    const vp = page.viewportSize()!;
    await page.mouse.click(vp.width * 0.62, vp.height * 0.4, { button: 'right' });
    await expect(page.locator('.log')).toContainText('8 Infantry marching', { timeout: 15_000 });
    await expect.poll(async () => (await units(page)).filter((u) => u.side === 'sun' && u.type === 'infantry' && u.state === 'moving').length, { timeout: 20_000 }).toBeGreaterThan(0);
    // Speed the sim up for the test only, then expect arrival.
    await page.evaluate(() => { for (let i = 0; i < 400; i++) { window.__crGame!.sim.step(); } });
    await expect.poll(async () => (await units(page)).filter((u) => u.side === 'sun' && u.type === 'infantry' && u.state !== 'idle').length, { timeout: 20_000 }).toBe(0);
  });

  test('left-drag box-selects only your soldiers; X stops them', async ({ page }) => {
    await jump(page, { x: 19, z: 17.5, dist: 22, yaw: 0 });
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width * 0.2, vp.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(vp.width * 0.8, vp.height * 0.85, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await selected(page)).length, { timeout: 15_000 }).toBeGreaterThan(3);
    const ids = await selected(page);
    const all = await units(page);
    expect(ids.every((id) => all.find((u) => u.id === id)!.side === 'sun')).toBe(true);
    await page.mouse.click(vp.width * 0.5, vp.height * 0.3, { button: 'right' });
    await expect(page.locator('.log')).toContainText('marching', { timeout: 15_000 });
    await expect.poll(async () => (await units(page)).filter((u) => ids.includes(u.id) && u.state !== 'idle').length, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.keyboard.press('x');
    await expect.poll(async () => (await units(page)).filter((u) => ids.includes(u.id) && u.state !== 'idle').length, { timeout: 15_000 }).toBe(0);
    await expect(page.locator('.log')).toContainText('halted');
  });

  test('clicking a soldier selects just that soldier', async ({ page }) => {
    const u = (await units(page)).find((x) => x.side === 'sun')!;
    await jump(page, { x: u.x, z: u.z, dist: 16, yaw: 0 });
    await page.waitForTimeout(1500);
    // Project the soldier's chest to the screen and click it.
    const pt = await page.evaluate(([x, z]) => (window as unknown as { __crProject: (x: number, y: number, z: number) => { x: number; y: number } }).__crProject(x, 0.4, z), [u.x, u.z]);
    await page.mouse.click(pt.x, pt.y);
    await expect.poll(async () => (await selected(page)).length, { timeout: 15_000 }).toBe(1);
    await expect(page.locator('.selection .sel-kicker')).toContainText('Yours (Sun)');
  });
});

test.describe('touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('tap a company, tap the map: they march', async ({ page }) => {
    await page.waitForSelector('body[data-units="1"]', { timeout: 60_000 });
    await jump(page, { x: 20, z: 18, dist: 24, yaw: 0 });
    const btn = (await page.locator('.army .btn').nth(1).boundingBox())!;
    await page.touchscreen.tap(btn.x + btn.width / 2, btn.y + btn.height / 2);
    await expect(page.locator('.selection h2')).toHaveText('6 Archers');
    await page.touchscreen.tap(300, 420);
    // The field log starts collapsed on phones, so check the soldiers themselves.
    await expect.poll(async () => (await units(page)).filter((u) => u.side === 'sun' && u.type === 'archer' && u.state !== 'idle').length, { timeout: 15_000 }).toBe(6);
  });
});
