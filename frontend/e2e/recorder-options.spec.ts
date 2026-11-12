import { expect, type Page, test } from '@playwright/test';

// The recorder options: bubble shape, size and drag-to-snap, settings that carry over, recording
// quality and countdown off. Every video made here is deleted at the end.

const created: string[] = [];
const PREFS_KEY = 'loom-clone.recorder';

test.afterAll(async ({ request }) => {
  for (const id of created) await request.delete(`/api/videos/${id}`);
});

async function prefs(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), PREFS_KEY);
}

test('bubble shape, size and position are set by hand and carried over', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'no-preference', permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  await page.goto('/record');
  await page.evaluate((key) => localStorage.removeItem(key), PREFS_KEY);
  await page.reload();

  const bubble = page.getByRole('button', { name: /^Camera bubble\./ });
  await expect(page.getByLabel('Camera bubble preview')).toBeVisible();
  const before = (await bubble.boundingBox())!;

  await page.getByRole('button', { name: 'Portrait' }).click();
  await page.locator('.camera-controls').getByLabel('Bubble size').fill('4');
  await expect(page.getByRole('button', { name: 'Portrait' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await bubble.boundingBox())!.height).toBeGreaterThan(before.height * 1.5);
  const tall = (await bubble.boundingBox())!;
  expect(tall.height).toBeGreaterThan(tall.width);

  // Drag from the bottom-left corner most of the way to the top-right: it snaps into the corner.
  const stage = (await page.locator('.stage').boundingBox())!;
  await page.mouse.move(tall.x + tall.width / 2, tall.y + tall.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width - 30, stage.y + 30, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await prefs(page))?.bubble).toMatchObject({ px: 1, py: 0, size: 4, shape: 'portrait' });
  const moved = (await bubble.boundingBox())!;
  expect(moved.x + moved.width).toBeGreaterThan(stage.x + stage.width * 0.9);
  expect(moved.y).toBeLessThan(stage.y + stage.height * 0.1);

  // Keyboard: focus the bubble, move it left, make it smaller.
  await bubble.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('-');
  await expect.poll(async () => (await prefs(page))?.bubble).toMatchObject({ px: 0.95, size: 3 });

  await page.getByLabel('Filter').selectOption('mono');
  await page.getByRole('switch', { name: /Flip camera/ }).check();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Portrait' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Filter')).toHaveValue('mono');
  await expect(page.getByRole('switch', { name: /Flip camera/ })).toBeChecked();
  expect((await prefs(page)).bubble).toMatchObject({ shape: 'portrait', size: 3, filter: 'mono', mirror: false });
  await ctx.close();
});

test('720p with no countdown records at 720p, and the bubble changes mid-take', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'no-preference', permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/record');
  await page.evaluate((key) => localStorage.removeItem(key), PREFS_KEY);
  await page.reload();

  await page.getByLabel('Video quality').selectOption('720p');
  await page.getByRole('switch', { name: '3 second countdown' }).uncheck();
  await expect(page.getByLabel('Camera bubble preview')).toBeVisible();

  await page.getByRole('button', { name: 'Start recording' }).click();
  // No "Get ready": recording starts straight away.
  await expect(page.getByRole('heading', { name: 'Recording' })).toBeVisible({ timeout: 10_000 });
  const chip = page.locator('.page-head .chip');
  await expect(chip).toBeVisible();
  const [w, h] = (await chip.innerText()).split('×').map((n) => Number(n.trim()));
  expect(Math.min(w, h)).toBeLessThanOrEqual(720);

  // Live controls: change shape and size, double-click for full camera and back, camera off and on.
  const handle = page.getByRole('button', { name: /^Camera bubble\./ });
  await expect(handle).toBeVisible();
  await page.getByRole('button', { name: 'Rounded square' }).click();
  await page.locator('.live-camera').getByLabel('Bubble size').fill('0');
  await handle.dblclick();
  await expect(page.getByRole('switch', { name: 'Full camera' })).toBeChecked();
  await page.getByRole('button', { name: /Camera fills the recording/ }).dblclick();
  await expect(page.getByRole('switch', { name: 'Full camera' })).not.toBeChecked();
  await page.getByRole('switch', { name: 'Camera on' }).uncheck();
  await expect(handle).toBeHidden();
  await page.getByRole('switch', { name: 'Camera on' }).check();
  await expect(handle).toBeVisible();
  await page.waitForTimeout(2500);

  await page.getByRole('button', { name: 'Stop and share' }).click();
  await expect(page).toHaveURL(/\/v\/[a-z2-9]{10}$/);
  const id = page.url().split('/v/')[1];
  created.push(id);
  await expect(page.locator('.player video')).toBeAttached({ timeout: 20_000 });
  await expect
    .poll(async () => page.locator('.player video').evaluate((el: HTMLVideoElement) => el.videoHeight), { timeout: 15_000 })
    .toBeGreaterThan(0);
  const size = await page.locator('.player video').evaluate((el: HTMLVideoElement) => [el.videoWidth, el.videoHeight]);
  expect(Math.min(size[0], size[1])).toBeLessThanOrEqual(720);
  expect([size[0], size[1]]).toEqual([w, h]);

  // The settings changed mid-take are remembered for the next recording.
  expect((await prefs(page)).bubble).toMatchObject({ shape: 'squircle', size: 0 });
  expect(errors).toEqual([]);
  await ctx.close();
});
