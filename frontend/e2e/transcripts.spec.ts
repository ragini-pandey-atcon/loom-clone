import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

// Transcripts from the real local speech model: a video with spoken words is uploaded, the
// model writes the transcript on this computer, and the transcript tab, captions, library search
// and the off switch are checked. The speech comes from Windows' built-in voice, so the test
// runs where the app runs (scripts\start.ps1 is Windows too).

const SENTENCE =
  'Hello team. This is a quick walkthrough of the new export step. First open the settings page, then choose the quarterly report and press download.';
const created = new Set<string>();

test.afterAll(async ({ request }) => {
  for (const id of created) await request.delete(`/api/videos/${id}`);
});

function speechWav(): Buffer {
  const dir = join('test-results', 'fixtures');
  const file = join(dir, 'speech.wav');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const script = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
      `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}', $f)`,
      `$s.Speak('${SENTENCE}')`,
      '$s.Dispose()',
    ].join('; ');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  }
  return readFileSync(file);
}

/** A WebM with a moving picture and the spoken sentence as its sound, recorded in the page. */
async function speakingVideo(page: Page, wav: Buffer): Promise<Buffer> {
  const b64 = await page.evaluate(async (wavB64) => {
    const bytes = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0));
    const ctx = new AudioContext();
    const audio = await ctx.decodeAudioData(bytes.buffer);
    const dest = ctx.createMediaStreamDestination();
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(dest);
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d')!;
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start(250);
    src.start();
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const draw = () => {
        const t = performance.now() - t0;
        g.fillStyle = `hsl(${(t / 30) % 360} 45% 40%)`;
        g.fillRect(0, 0, 640, 360);
        g.fillStyle = '#fff';
        g.font = '40px sans-serif';
        g.fillText('Export walkthrough', 140, 190);
        if (t < audio.duration * 1000 + 600) requestAnimationFrame(draw);
        else resolve();
      };
      draw();
    });
    rec.stop();
    await stopped;
    await ctx.close();
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, wav.toString('base64'));
  return Buffer.from(b64, 'base64');
}

test('a spoken video gets a transcript, captions and search from the local model', async ({ browser }) => {
  test.skip(process.platform !== 'win32', 'The speech fixture uses the Windows voice');
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ reducedMotion: 'no-preference', autoplayPolicy: 'no-user-gesture-required' } as never);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');

  const video = await speakingVideo(page, speechWav());
  await page.getByTestId('upload-input').setInputFiles({ name: 'Export walkthrough.webm', mimeType: 'video/webm', buffer: video });
  await expect(page).toHaveURL(/\/v\/[a-z2-9]{10}$/, { timeout: 30_000 });
  const id = page.url().split('/v/')[1];
  created.add(id);

  // The model runs in the background; the tab shows progress, then the lines.
  await page.getByRole('tab', { name: 'Transcript' }).click();
  const lines = page.locator('.transcript-lines li');
  await expect(lines.first()).toBeVisible({ timeout: 180_000 });
  const text = (await page.locator('.transcript-lines').innerText()).toLowerCase();
  for (const words of ['export step', 'settings page', 'quarterly report', 'download']) expect(text).toContain(words);

  // Click a line: the player jumps there.
  const second = lines.nth(1);
  const label = (await second.getByRole('button').getAttribute('aria-label'))!;
  const [mm, ss] = label.split(':').map(Number);
  await second.getByRole('button').click();
  await expect
    .poll(() => page.locator('.player video').evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThanOrEqual(mm * 60 + ss - 0.2);

  // Search inside the transcript.
  await page.getByLabel('Search the transcript').fill('quarterly');
  await expect(page.locator('.transcript-lines li')).toHaveCount(1);
  await expect(page.locator('.transcript-lines mark')).toHaveText(/quarterly/i);
  await page.getByLabel('Search the transcript').fill('');

  // Captions from the same words.
  await page.getByRole('button', { name: 'Show captions' }).click();
  await expect
    .poll(() =>
      page.locator('.player video').evaluate((v: HTMLVideoElement) => {
        const t = v.textTracks[0];
        return t ? `${t.mode}:${t.cues?.length ?? 0}` : 'none';
      }),
    )
    .toMatch(/^showing:[1-9]/);
  const vtt = await (await page.request.get(`/api/videos/${id}/captions.vtt`)).text();
  expect(vtt.startsWith('WEBVTT')).toBe(true);

  // Library search finds what was said, and says where.
  await page.goto('/');
  await page.getByLabel('Search titles, tags and what was said').fill('quarterly report');
  const card = page.locator('.card', { hasText: 'Export walkthrough' });
  await expect(card.locator('.card-said')).toContainText(/Said at 0:0\d/);
  await expect(card.locator('.card-said')).toContainText(/quarterly report/i);
  expect(await card.getByRole('link', { name: 'Export walkthrough' }).getAttribute('href')).toMatch(new RegExp(`/v/${id}\\?t=\\d+`));

  // The owner turns the transcript off: a viewer no longer sees it, and search no longer finds it.
  await page.request.patch(`/api/videos/${id}`, { data: { transcriptEnabled: false } });
  const viewerCtx = await browser.newContext({ reducedMotion: 'no-preference' });
  const viewer = await viewerCtx.newPage();
  await viewer.goto(`/v/${id}`);
  await expect(viewer.getByRole('heading', { name: 'Export walkthrough' })).toBeVisible();
  await expect(viewer.getByRole('tab', { name: 'Transcript' })).toHaveCount(0);
  await expect(viewer.getByRole('button', { name: /captions/ })).toHaveCount(0);
  expect((await (await page.request.get('/api/videos?q=quarterly%20report')).json()).length).toBe(0);

  expect(errors).toEqual([]);
  await viewerCtx.close();
  await ctx.close();
});
