import { expect, type Page } from '@playwright/test';

/** A real WebM of `seconds`, made in the browser from a canvas. It has no duration in its header,
 * like many recorders' files, so the upload's length probe is exercised too. */
export async function makeWebm(page: Page, seconds = 4): Promise<Buffer> {
  const base64 = await page.evaluate(async (seconds) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d')!;
    const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start(250);
    const t0 = performance.now();
    await new Promise<void>((resolve) => {
      const draw = () => {
        const t = performance.now() - t0;
        ctx.fillStyle = `hsl(${(t / 20) % 360} 70% 45%)`;
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#fff';
        ctx.font = '64px sans-serif';
        ctx.fillText((t / 1000).toFixed(1), 240, 200);
        if (t < seconds * 1000) requestAnimationFrame(draw);
        else resolve();
      };
      draw();
    });
    rec.stop();
    await done;
    const buf = new Uint8Array(await new Blob(parts).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, seconds);
  return Buffer.from(base64, 'base64');
}

/** Uploads a generated video from the library page; resolves to its id on its video page. */
export async function uploadFromLibrary(page: Page, name: string, created: Set<string>, seconds = 4): Promise<string> {
  const file = await makeWebm(page, seconds);
  await page.getByTestId('upload-input').setInputFiles({ name, mimeType: 'video/webm', buffer: file });
  await expect(page).toHaveURL(/\/v\/[a-z2-9]{10}$/, { timeout: 30_000 });
  const id = page.url().split('/v/')[1];
  created.add(id);
  return id;
}

/** A small PNG made in the browser. */
export async function makePng(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 180;
    const x = c.getContext('2d')!;
    x.fillStyle = '#c0392b';
    x.fillRect(0, 0, 320, 180);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    return btoa(String.fromCharCode(...buf));
  });
  return Buffer.from(base64, 'base64');
}
