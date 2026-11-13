import { type Browser, expect, test } from '@playwright/test';

import { makePng, uploadFromLibrary } from './helpers';

// Per-video settings, tags, theater mode, hover preview, @mentions, follow, notifications and
// video replies, with an owner and a viewer in two separate browsers. Test names only.

const created = new Set<string>();

test.afterAll(async ({ request }) => {
  for (const id of created) await request.delete(`/api/videos/${id}`);
});

async function browserAs(browser: Browser, name: string, owner: boolean) {
  const ctx = await browser.newContext({
    reducedMotion: 'no-preference',
    acceptDownloads: true,
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
  });
  await ctx.addInitScript(
    ([name, owner]) => {
      if (!localStorage.getItem('asv.name')) localStorage.setItem('asv.name', name as string);
      if (!owner) localStorage.removeItem('loom-clone.recorder');
    },
    [name, owner] as const,
  );
  return ctx;
}

test('settings, tags, theater mode and the hover preview', async ({ browser }) => {
  const ctx = await browserAs(browser, 'Test Owner', true);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  const id = await uploadFromLibrary(page, 'Settings demo.webm', created);

  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('switch', { name: /Show view count to viewers/ }).check();
  await page.getByRole('switch', { name: /Viewers can download/ }).check();
  await page.getByLabel('Recommended playback speed').selectOption('1.5');
  await expect.poll(async () => (await (await page.request.get(`/api/videos/${id}`)).json()).recommendedSpeed).toBe(1.5);
  const meta = await (await page.request.get(`/api/videos/${id}`)).json();
  expect([meta.showViewCount, meta.downloadsEnabled]).toEqual([true, true]);

  // Thumbnail from an uploaded image, then from the current frame: each replaces the stored JPEG.
  const before = (await (await page.request.get(`/api/videos/${id}/thumbnail`)).body()).length;
  await page.getByTestId('thumbnail-input').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: await makePng(page) });
  await expect(page.getByText('Thumbnail updated')).toBeVisible();
  const fromImage = await (await page.request.get(`/api/videos/${id}/thumbnail`)).body();
  expect(fromImage.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect(fromImage.length).not.toBe(before);
  await page.locator('.player video').evaluate((v: HTMLVideoElement) => {
    v.currentTime = 2;
  });
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Use the current frame' }).click();
  await expect(page.getByText('Thumbnail updated').last()).toBeVisible();
  const fromFrame = await (await page.request.get(`/api/videos/${id}/thumbnail`)).body();
  expect(fromFrame.equals(fromImage)).toBe(false);

  // Tags, then the library filter.
  await page.getByRole('button', { name: 'Add a tag' }).click();
  await page.getByLabel('New tag').fill('E2E onboarding, #E2E q4');
  await page.getByLabel('New tag').press('Enter');
  await expect(page.getByRole('link', { name: 'E2E onboarding' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'E2E q4' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove tag E2E q4' }).click();
  await expect(page.getByRole('link', { name: 'E2E q4' })).toBeHidden();
  await page.getByRole('link', { name: 'E2E onboarding' }).click();
  await expect(page).toHaveURL(/\/\?tag=E2E(%20|\+)onboarding$/);
  await expect(page.getByRole('heading', { name: 'E2E onboarding' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings demo' })).toBeVisible();
  await page.getByRole('button', { name: /E2E onboarding/, pressed: true }).click();
  await expect(page).toHaveURL('/');

  // Hover preview on the library card.
  await page.locator('.card', { hasText: 'Settings demo' }).hover();
  await expect(page.locator('.card', { hasText: 'Settings demo' }).locator('video.card-preview')).toBeAttached();
  await page.mouse.move(0, 0);
  await expect(page.locator('video.card-preview')).toHaveCount(0);

  // Theater mode, remembered after a reload.
  await page.goto(`/v/${id}`);
  await page.getByRole('button', { name: 'Theater mode' }).click();
  await expect(page.locator('.watch')).toHaveClass(/is-theater/);
  await page.reload();
  await expect(page.locator('.watch')).toHaveClass(/is-theater/);
  await page.getByRole('button', { name: 'Default view' }).click();
  await expect(page.locator('.watch')).not.toHaveClass(/is-theater/);

  // What a viewer gets from those settings.
  const viewerCtx = await browserAs(browser, 'Vera Viewer', false);
  const viewer = await viewerCtx.newPage();
  await viewer.goto(`/v/${id}`);
  await expect(viewer.locator('.meta-row')).toContainText('0 views');
  await expect(viewer.getByRole('button', { name: 'Download' })).toBeVisible();
  await expect.poll(() => viewer.locator('.player video').evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1.5);
  await expect(viewer.getByRole('tab', { name: 'Settings' })).toHaveCount(0);

  expect(errors).toEqual([]);
  await viewerCtx.close();
  await ctx.close();
});

test('mentions, follow, notifications and a video reply between an owner and a viewer', async ({ browser }) => {
  const ownerCtx = await browserAs(browser, 'Test Owner', true);
  const owner = await ownerCtx.newPage();
  await owner.goto('/');
  const id = await uploadFromLibrary(owner, 'Mention demo.webm', created);
  await owner.getByPlaceholder('Add a comment at this moment').fill('Please review this one.');
  await owner.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(owner.locator('.comment-body', { hasText: 'Please review this one.' })).toBeVisible();

  const viewerCtx = await browserAs(browser, 'Vera Viewer', false);
  const viewer = await viewerCtx.newPage();
  await viewer.goto(`/v/${id}`);

  // Autocomplete a mention with the keyboard.
  const box = viewer.getByPlaceholder('Add a comment at this moment');
  await box.click();
  await box.pressSequentially('Looks good @te');
  await expect(viewer.getByRole('option', { name: 'Test Owner' })).toBeVisible();
  await box.press('Enter');
  await expect(box).toHaveValue('Looks good @Test Owner ');
  await box.pressSequentially('one question');
  await viewer.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(viewer.locator('mark.mention', { hasText: '@Test Owner' })).toBeVisible();
  // Commenting follows the video.
  await expect(viewer.getByRole('button', { name: 'Following' })).toHaveAttribute('aria-pressed', 'true');

  // The owner's bell, then the notifications page.
  await owner.reload();
  await expect(owner.getByRole('link', { name: /Notifications, 1 new/ })).toBeVisible();
  await owner.getByRole('link', { name: /Notifications/ }).click();
  await expect(owner.getByRole('link', { name: 'Vera Viewer mentioned you on Mention demo' })).toBeVisible();
  await expect(owner.getByRole('link', { name: 'Notifications', exact: true })).toBeVisible();

  // The owner replies; the viewer hears about it.
  await owner.getByRole('link', { name: 'Vera Viewer mentioned you on Mention demo' }).click();
  const thread = owner.locator('.thread', { hasText: 'one question' });
  await thread.getByRole('button', { name: 'Reply' }).click();
  await thread.getByPlaceholder('Write a reply').fill('Answered, see 0:02.');
  await thread.getByRole('button', { name: 'Reply', exact: true }).last().click();
  await expect(owner.locator('.comment-body', { hasText: 'Answered' })).toBeVisible();
  await viewer.goto('/notifications');
  await expect(viewer.getByRole('link', { name: 'Test Owner replied to your comment on Mention demo' })).toBeVisible();

  // The viewer answers with a recording of their own.
  await viewer.goto(`/v/${id}`);
  await viewer.getByRole('link', { name: 'Video reply' }).click();
  await expect(viewer.getByRole('heading', { name: 'Video reply' })).toBeVisible();
  await expect(viewer.getByText('When you stop, this recording is posted as a reply on "Mention demo".')).toBeVisible();
  await expect(viewer.getByLabel('Your name')).toHaveValue('Vera Viewer');
  await viewer.getByRole('button', { name: 'Screen only' }).click();
  await viewer.getByRole('switch', { name: '3 second countdown' }).uncheck();
  await viewer.getByRole('button', { name: 'Start recording' }).click();
  await expect(viewer.getByRole('heading', { name: 'Recording' })).toBeVisible({ timeout: 10_000 });
  await viewer.waitForTimeout(2000);
  await viewer.getByRole('button', { name: 'Stop and share' }).click();
  await expect(viewer.getByText('Posted as a video reply on "Mention demo".')).toBeVisible({ timeout: 20_000 });
  const replyId = viewer.url().split('/v/')[1].split('?')[0];
  created.add(replyId);
  // Recording a reply did not make the viewer's browser the owner's.
  expect(await viewer.evaluate(() => localStorage.getItem('asv.owner'))).not.toBe('1');

  await viewer.getByRole('link', { name: 'Back to that video' }).click();
  await expect(viewer.locator('.reply-card')).toContainText('Reply to Mention demo');
  await owner.goto('/notifications');
  await expect(owner.getByRole('link', { name: 'Vera Viewer recorded a video reply on Mention demo' })).toBeVisible();

  await viewerCtx.close();
  await ownerCtx.close();
});
