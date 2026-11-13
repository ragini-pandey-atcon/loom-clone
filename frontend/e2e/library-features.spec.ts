import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

import { uploadFromLibrary } from './helpers';

// Folders, upload, trim, download, duplicate, a link at a timestamp, watch later and the
// floating recording controls. Everything made here is deleted at the end.

const createdVideos = new Set<string>();
const createdFolders = new Set<string>();

test.afterAll(async ({ request }) => {
  for (const id of createdVideos) await request.delete(`/api/videos/${id}`);
  for (const id of createdFolders) await request.delete(`/api/folders/${id}`);
});

async function ownerContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    reducedMotion: 'no-preference',
    acceptDownloads: true,
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
  });
}

const upload = (page: Page, name: string) => uploadFromLibrary(page, name, createdVideos);

async function playerTime(page: Page) {
  return page.locator('.player-time').innerText();
}

test('upload, trim and revert, download, duplicate, link at a time, watch later', async ({ browser }) => {
  const ctx = await ownerContext(browser);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');

  const id = await upload(page, 'Quarterly demo.webm');
  await expect(page.getByRole('heading', { name: 'Quarterly demo' })).toBeVisible();
  const meta = await (await page.request.get(`/api/videos/${id}`)).json();
  expect(meta).toMatchObject({ status: 'ready', uploaded: true, hasThumbnail: true, width: 640, height: 360 });
  expect(meta.durationMs).toBeGreaterThan(3000);
  await expect.poll(() => playerTime(page)).toMatch(/\/ 0:0[34]$/);

  // Trim: keep 1 s to 3 s, with the keyboard on the handles.
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Trim' }).click();
  const start = page.getByRole('slider', { name: 'Trim start' });
  const end = page.getByRole('slider', { name: 'Trim end' });
  await start.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await end.focus();
  // Home takes the end handle as far left as it goes: half a second after the start (1.5 s).
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect(page.locator('.trim-head .muted')).toHaveText('Keeping 0:01 to 0:03 (0:02)');
  await page.getByRole('button', { name: 'Save trim' }).click();
  await expect(page.getByText('Trim saved')).toBeVisible();
  const trimmed = await (await page.request.get(`/api/videos/${id}`)).json();
  expect([trimmed.trimStartMs, trimmed.trimEndMs]).toEqual([1000, 3000]);
  await expect.poll(() => playerTime(page)).toBe('0:00 / 0:02');
  // It plays from the trim start and stops at the trim end.
  await page.getByRole('button', { name: 'Play video' }).click();
  await expect.poll(() => page.locator('.player video').evaluate((v: HTMLVideoElement) => v.paused), { timeout: 8000 }).toBe(true);
  const stoppedAt = await page.locator('.player video').evaluate((v: HTMLVideoElement) => v.currentTime);
  expect(stoppedAt).toBeGreaterThan(2.8);
  expect(stoppedAt).toBeLessThan(3.15);

  // Revert to original.
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit trim' }).click();
  await page.getByRole('button', { name: 'Revert to original' }).click();
  await expect(page.getByText('Back to the original')).toBeVisible();
  expect((await (await page.request.get(`/api/videos/${id}`)).json()).trimStartMs).toBeNull();

  // Download: the whole file, named after the title.
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Download' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('Quarterly demo.webm');

  // A link that starts at a timestamp.
  await page.locator('.player video').evaluate((v: HTMLVideoElement) => {
    v.currentTime = 2.4;
  });
  await page.getByRole('button', { name: 'Share options' }).click();
  await page.getByRole('menuitem', { name: 'Copy link at the current time' }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(`http://localhost:5310/v/${id}?t=2`);
  await page.goto(link);
  await expect
    .poll(() => page.locator('.player video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 })
    .toBeCloseTo(2, 0);

  // Watch later.
  await page.getByRole('button', { name: 'Watch later' }).click();
  await expect(page.getByRole('button', { name: 'Saved for later' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('link', { name: 'Watch later' }).click();
  await expect(page.getByRole('link', { name: 'Quarterly demo' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Quarterly demo from Watch later' }).click();
  await expect(page.getByText('Nothing saved for later')).toBeVisible();

  // Duplicate opens the copy.
  await page.goto(`/v/${id}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.getByRole('heading', { name: 'Quarterly demo (copy)' })).toBeVisible();
  createdVideos.add(page.url().split('/v/')[1]);
  expect(page.url().split('/v/')[1]).not.toBe(id);

  expect(errors).toEqual([]);
  await ctx.close();
});

test('folders: create, move a video in, rename, open, delete keeps the video', async ({ browser }) => {
  const ctx = await ownerContext(browser);
  const page = await ctx.newPage();
  await page.goto('/');
  const id = await upload(page, 'Folder test.webm');
  await page.goto('/');

  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByLabel('Folder name').fill('E2E onboarding');
  await page.getByRole('button', { name: 'Create folder' }).click();
  const card = page.locator('.folder-card', { hasText: 'E2E onboarding' });
  await expect(card).toBeVisible();
  const folders = await (await page.request.get('/api/folders')).json();
  const folderId = folders.find((f: { name: string }) => f.name === 'E2E onboarding').id;
  createdFolders.add(folderId);

  await page.getByRole('button', { name: 'Actions for Folder test' }).click();
  await page.getByRole('menuitem', { name: 'Move to folder' }).click();
  await page.getByRole('radio', { name: /E2E onboarding/ }).check();
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByText('Moved to E2E onboarding')).toBeVisible();
  await expect(card).toContainText('1 video');
  // At the top level, a video in a folder shows inside its folder only...
  await expect(page.getByRole('link', { name: 'Folder test' })).toBeHidden();
  // ...but a search looks everywhere, and says which folder it is in.
  await page.getByLabel('Search by title').fill('Folder test');
  await expect(page.locator('.card', { hasText: 'Folder test' })).toContainText('E2E onboarding');
  await page.getByLabel('Search by title').fill('');

  await card.getByRole('link').click();
  await expect(page).toHaveURL(`/folders/${folderId}`);
  await expect(page.getByRole('link', { name: 'Folder test' })).toBeVisible();

  await page.getByRole('button', { name: 'Actions for folder E2E onboarding' }).click();
  await page.getByRole('menuitem', { name: 'Rename folder' }).click();
  await page.getByLabel('Folder name').fill('E2E sales');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'E2E sales' })).toBeVisible();

  await page.getByRole('button', { name: 'Actions for folder E2E sales' }).click();
  await page.getByRole('menuitem', { name: 'Delete folder…' }).click();
  await expect(page.getByText('Its 1 video move back to My videos; none are deleted.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete folder' }).click();
  await expect(page).toHaveURL('/');
  createdFolders.delete(folderId);
  await expect(page.getByRole('link', { name: 'Folder test' })).toBeVisible();
  expect((await (await page.request.get(`/api/videos/${id}`)).json()).folderId).toBeNull();
  await ctx.close();
});

test('floating controls pause and stop the recording from their own window', async ({ browser }) => {
  const ctx = await ownerContext(browser);
  const page = await ctx.newPage();
  await page.goto('/record');
  await page.evaluate(() => localStorage.removeItem('loom-clone.recorder'));
  await page.reload();
  const supported = await page.evaluate(() => 'documentPictureInPicture' in window);
  test.skip(!supported, 'This Chromium build has no Document Picture-in-Picture');

  await page.getByRole('switch', { name: '3 second countdown' }).uncheck();
  await expect(page.getByLabel('Camera bubble preview')).toBeVisible();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByRole('heading', { name: 'Recording' })).toBeVisible({ timeout: 10_000 });

  const popout = page.getByRole('button', { name: /floating controls|Pop out controls/ });
  if ((await popout.innerText()).includes('Pop out')) {
    const opened = ctx.waitForEvent('page');
    await popout.click();
    await opened;
  }
  await expect(page.getByRole('button', { name: 'Close floating controls' })).toBeVisible();
  const pip = ctx.pages().find((p) => p !== page)!;
  await expect(pip.getByRole('toolbar', { name: 'Recording controls' })).toBeVisible();

  await pip.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('heading', { name: 'Paused' })).toBeVisible();
  await pip.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('heading', { name: 'Recording' })).toBeVisible();
  await page.waitForTimeout(1500);
  await pip.getByRole('button', { name: 'Stop' }).click();
  await expect(page).toHaveURL(/\/v\/[a-z2-9]{10}/, { timeout: 15_000 });
  createdVideos.add(page.url().split('/v/')[1].split('?')[0]);
  await expect(page.locator('.player video')).toBeAttached({ timeout: 20_000 });
  await ctx.close();
});
