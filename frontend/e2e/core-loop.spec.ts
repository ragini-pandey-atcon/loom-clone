import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

// The core loop end to end, with real MediaRecorder output: record, stop, the link is on the
// clipboard, the repaired WebM has a duration and seeks, and a viewer can react, comment and
// count as a view. Every video made here is deleted at the end.

const created: string[] = [];

async function ownerContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    reducedMotion: 'no-preference',
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
  });
}

async function record(page: Page, seconds: number): Promise<string> {
  await page.goto('/record');
  const start = page.getByRole('button', { name: 'Start recording' });
  await expect(page.getByLabel('Camera bubble preview')).toBeVisible();
  await start.click();
  await expect(page.getByRole('heading', { name: 'Recording' })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(seconds * 1000);
  return page.url();
}

async function videoState(page: Page) {
  return page.locator('.player video').evaluate((el: HTMLVideoElement) => ({
    duration: el.duration,
    seekableEnd: el.seekable.length ? el.seekable.end(0) : 0,
  }));
}

test.afterAll(async ({ request }) => {
  for (const id of created) await request.delete(`/api/videos/${id}`);
});

test('record, stop, link copied, video seeks', async ({ browser }) => {
  const ctx = await ownerContext(browser);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await record(page, 3);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('heading', { name: 'Paused' })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.waitForTimeout(2500);

  await page.getByRole('button', { name: 'Stop and share' }).click();
  await expect(page).toHaveURL(/\/v\/[a-z2-9]{10}$/);
  const id = page.url().split('/v/')[1];
  created.push(id);

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(`http://localhost:5310/v/${id}`);

  // The page opens at once; the player appears when the upload finishes.
  const video = page.locator('.player video');
  await expect(video).toBeAttached({ timeout: 20_000 });
  await expect.poll(async () => (await videoState(page)).duration, { timeout: 15_000 }).toBeGreaterThan(4);

  const state = await videoState(page);
  // About 5.5 s recorded, with the 1.5 s pause left out.
  expect(state.duration).toBeGreaterThan(4);
  expect(state.duration).toBeLessThan(8);
  expect(Number.isFinite(state.duration)).toBe(true);
  expect(state.seekableEnd).toBeGreaterThan(4);

  const landed = await video.evaluate(
    (el: HTMLVideoElement) =>
      new Promise<number>((resolve) => {
        el.addEventListener('seeked', () => resolve(el.currentTime), { once: true });
        el.currentTime = 3.2;
      }),
  );
  expect(Math.abs(landed - 3.2)).toBeLessThan(0.3);

  const meta = await (await page.request.get(`/api/videos/${id}`)).json();
  expect(meta).toMatchObject({ status: 'ready', seekable: true, hasThumbnail: true, sourceMode: 'screen_camera' });
  expect(meta.width).toBeGreaterThan(0);

  const ranged = await page.request.get(`/api/videos/${id}/media`, { headers: { Range: 'bytes=0-99' } });
  expect(ranged.status()).toBe(206);

  await page.goto('/');
  await expect(page.getByRole('link', { name: meta.title })).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a viewer reacts, comments and counts as a view; the owner sees it', async ({ browser }) => {
  const owner = await ownerContext(browser);
  const ownerPage = await owner.newPage();
  await record(ownerPage, 7);
  await ownerPage.getByRole('button', { name: 'Stop and share' }).click();
  await expect(ownerPage).toHaveURL(/\/v\//);
  const id = ownerPage.url().split('/v/')[1];
  created.push(id);
  await expect(ownerPage.locator('.player video')).toBeAttached({ timeout: 20_000 });

  const viewer = await browser.newContext({ reducedMotion: 'no-preference' });
  const page = await viewer.newPage();
  await page.goto(`/v/${id}`);
  // Viewers do not get the owner's library navigation.
  await expect(page.getByRole('navigation', { name: 'Library' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Play video' }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'React 🎉' }).click();
  await page.getByLabel('Display name').fill('Sam Viewer');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: /Sam Viewer reacted 🎉/ })).toBeAttached();

  await page.waitForTimeout(5500);
  await page.locator('.player video').evaluate((el: HTMLVideoElement) => el.pause());
  await page.getByLabel('Comment', { exact: true }).fill('Can we slow down here?');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.comment-body')).toHaveText('Can we slow down here?');
  // Leaving the page flushes the last heartbeat.
  await page.goto('about:blank');
  await viewer.close();

  await ownerPage.reload();
  await expect(ownerPage.getByText('Can we slow down here?')).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Reply' }).click();
  await ownerPage.getByLabel('Reply', { exact: true }).fill('Yes, will do.');
  await ownerPage.getByRole('button', { name: 'Reply', exact: true }).last().click();
  const nameField = ownerPage.getByLabel('Display name');
  if (await nameField.isVisible().catch(() => false)) {
    await nameField.fill('Ragini');
    await ownerPage.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(ownerPage.getByText('Yes, will do.')).toBeVisible();
  await expect(ownerPage.getByText('Owner')).toBeVisible();

  await ownerPage.getByRole('tab', { name: 'Activity' }).click();
  await expect(ownerPage.locator('.stat strong')).toHaveText('1');
  await expect(ownerPage.getByText('Sam Viewer').first()).toBeVisible();
  await owner.close();
});

test('rename, archive, restore and delete from the library', async ({ browser }) => {
  const ctx = await ownerContext(browser);
  const page = await ctx.newPage();
  await record(page, 2);
  await page.getByRole('button', { name: 'Stop and share' }).click();
  const id = page.url().split('/v/')[1];
  created.push(id);
  await expect(page.locator('.player video')).toBeAttached({ timeout: 20_000 });

  const title = `E2E clip ${Date.now()}`;
  await page.locator('.title-button').click();
  await page.getByLabel('Video title').fill(title);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  await page.goto('/');
  await page.getByLabel('Search titles, tags and what was said').fill(title);
  await expect(page.locator('.card')).toHaveCount(1);
  await page.getByRole('button', { name: `Actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(page.locator('.card')).toHaveCount(0);

  await page.goto('/archive');
  await page.getByRole('button', { name: `Actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'Restore' }).click();
  await expect(page.getByRole('heading', { name: 'Nothing archived' }).or(page.locator('.card'))).toBeVisible();

  await page.goto('/');
  await page.getByRole('button', { name: `Actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('link', { name: title })).toHaveCount(0);
  expect((await page.request.get(`/api/videos/${id}`)).status()).toBe(404);
  await ctx.close();
});

test('a take whose tab closed mid-recording can be recovered', async ({ browser }) => {
  const ctx = await ownerContext(browser);
  const page = await ctx.newPage();
  await record(page, 4);
  const ids = (await (await page.request.get('/api/videos')).json()) as { id: string; status: string }[];
  const id = ids.find((v) => v.status === 'recording')!.id;
  created.push(id);
  await page.close({ runBeforeUnload: false });

  const again = await ctx.newPage();
  await again.goto(`/v/${id}`);
  await again.getByRole('button', { name: 'Recover recording' }).click();
  await expect(again.locator('.player video')).toBeAttached({ timeout: 20_000 });
  await expect
    .poll(async () => (await videoState(again)).duration, { timeout: 15_000 })
    .toBeGreaterThan(2);
  const meta = await (await again.request.get(`/api/videos/${id}`)).json();
  expect(meta).toMatchObject({ status: 'ready', seekable: true });
  await ctx.close();
});

for (const mode of ['Screen only', 'Camera only'] as const) {
  test(`${mode} records a seekable video`, async ({ browser }) => {
    const ctx = await ownerContext(browser);
    const page = await ctx.newPage();
    await page.goto('/record');
    await page.getByRole('button', { name: mode }).click();
    if (mode === 'Camera only') await expect(page.getByLabel('Camera preview')).toBeVisible();
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('heading', { name: 'Recording' })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(3000);
    await page.getByRole('button', { name: 'Stop and share' }).click();
    const id = page.url().split('/v/')[1];
    created.push(id);
    await expect(page.locator('.player video')).toBeAttached({ timeout: 20_000 });
    await expect.poll(async () => (await videoState(page)).duration, { timeout: 15_000 }).toBeGreaterThan(2);
    const meta = await (await page.request.get(`/api/videos/${id}`)).json();
    expect(meta).toMatchObject({
      status: 'ready',
      seekable: true,
      sourceMode: mode === 'Screen only' ? 'screen' : 'camera',
    });
    await ctx.close();
  });
}
