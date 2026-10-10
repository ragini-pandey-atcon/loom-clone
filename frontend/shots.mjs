import { chromium } from '@playwright/test';
const out = '../replica/clone-screens';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--auto-select-desktop-capture-source=Entire screen'] });
const ctx = await browser.newContext({ reducedMotion: 'no-preference', viewport: { width: 1440, height: 900 }, permissions: ['camera','microphone','clipboard-read','clipboard-write'] });
const page = await ctx.newPage();
const made = [];
async function rec(title, secs) {
  await page.goto('http://localhost:5310/record');
  await page.getByLabel('Camera bubble preview').waitFor();
  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.getByRole('heading', { name: 'Recording' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(secs * 1000);
  return title;
}
// S05 setup
await page.goto('http://localhost:5310/record');
await page.getByLabel('Camera bubble preview').waitFor();
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/S05.png` });
// S07 countdown + S08 recording
await page.getByRole('button', { name: 'Start recording' }).click();
await page.locator('.countdown').waitFor();
await page.screenshot({ path: `${out}/S07.png` });
await page.getByRole('heading', { name: 'Recording' }).waitFor({ timeout: 10000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/S08.png` });
await page.getByRole('button', { name: 'Stop and share' }).click();
await page.screenshot({ path: `${out}/S09.png` });
made.push(page.url().split('/v/')[1]);
await page.locator('.player video').waitFor({ state: 'attached', timeout: 20000 });
for (const t of ['Q4 roadmap walkthrough', 'Fixing the invoice export bug']) {
  await rec(t, 2);
  await page.getByRole('button', { name: 'Stop and share' }).click();
  const id = page.url().split('/v/')[1]; made.push(id);
  await page.locator('.player video').waitFor({ state: 'attached', timeout: 20000 });
  await page.request.patch(`http://localhost:5310/api/videos/${id}`, { data: { title: t } });
}
await page.request.patch(`http://localhost:5310/api/videos/${made[0]}`, { data: { title: 'Onboarding: how we review pull requests on the platform team every week' } });
// viewer activity on made[0]
const id = made[0];
for (const [name, emoji, ms] of [['Priya Shah', '👍', 800], ['Tom Becker', '🎉', 2100], ['Priya Shah', '🔥', 3300]])
  await page.request.post(`http://localhost:5310/api/videos/${id}/reactions`, { data: { authorId: 'demo-' + name.replace(' ', ''), authorName: name, emoji, timestampMs: ms } });
const c = await (await page.request.post(`http://localhost:5310/api/videos/${id}/comments`, { data: { authorId: 'demo-PriyaShah', authorName: 'Priya Shah', body: 'Could you show the merge queue settings here?', timestampMs: 1500 } })).json();
await page.request.post(`http://localhost:5310/api/videos/${id}/comments`, { data: { authorId: 'demo-TomBecker', authorName: 'Tom Becker', body: 'Same question from me.', parentId: c.id } });
await page.request.post(`http://localhost:5310/api/videos/${id}/views`, { data: { viewerId: 'demo-PriyaShah', viewerName: 'Priya Shah', deltaMs: 6000, positionMs: 6000, ended: true } });
await page.request.post(`http://localhost:5310/api/videos/${id}/views`, { data: { viewerId: 'demo-TomBecker', viewerName: 'Tom Becker', deltaMs: 5200, positionMs: 5200 } });
// S03 library
await page.goto('http://localhost:5310/');
await page.locator('.card img').first().waitFor();
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/S03.png` });
// S10 owner page + S15
await page.goto(`http://localhost:5310/v/${id}`);
await page.locator('.player video').waitFor({ state: 'attached' });
await page.waitForTimeout(1000);
await page.screenshot({ path: `${out}/S10.png` });
await page.getByRole('tab', { name: 'Activity' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/S15.png` });
// S18 archive empty
await page.goto('http://localhost:5310/archive');
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/S18.png` });
// S12 viewer
const vctx = await browser.newContext({ reducedMotion: 'no-preference', viewport: { width: 1440, height: 900 } });
const v = await vctx.newPage();
await v.goto(`http://localhost:5310/v/${id}`);
await v.locator('.player video').waitFor({ state: 'attached' });
await v.waitForTimeout(800);
await v.screenshot({ path: `${out}/S12.png` });
await v.getByRole('button', { name: 'React 👏' }).click();
await v.waitForTimeout(300);
await v.screenshot({ path: `${out}/S12-name-prompt.png` });
// mobile
const m = await browser.newContext({ reducedMotion: 'no-preference', viewport: { width: 390, height: 844 }, isMobile: true });
const mp = await m.newPage();
await mp.goto(`http://localhost:5310/v/${id}`);
await mp.locator('.player video').waitFor({ state: 'attached' });
await mp.waitForTimeout(800);
await mp.screenshot({ path: `${out}/S12-390.png`, fullPage: true });
const ownerM = await ctx.newPage(); await ownerM.setViewportSize({ width: 390, height: 844 });
await ownerM.goto('http://localhost:5310/'); await ownerM.waitForTimeout(800);
await ownerM.screenshot({ path: `${out}/S03-390.png`, fullPage: true });
await ownerM.goto('http://localhost:5310/record'); await ownerM.getByLabel('Camera bubble preview').waitFor(); await ownerM.waitForTimeout(500);
await ownerM.screenshot({ path: `${out}/S05-390.png`, fullPage: true });
// dark
const d = await browser.newContext({ reducedMotion: 'no-preference', colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
const dp = await d.newPage();
await dp.goto(`http://localhost:5310/v/${id}`); await dp.locator('.player video').waitFor({ state: 'attached' }); await dp.waitForTimeout(800);
await dp.screenshot({ path: `${out}/S12-dark.png` });
for (const v of made) await page.request.delete(`http://localhost:5310/api/videos/${v}`);
console.log("cleaned", made.length);
await browser.close();
