import { describe, expect, it } from 'vitest';

import { fixWebm, WebmFixError } from './webmFix';

// A tiny WebM shaped like Chrome's MediaRecorder output: unknown-size Segment and Clusters,
// no Duration, no Cues. Sizes use the shortest encoding, as a real muxer does.

function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}
function size(n: number): number[] {
  if (n < 0x7f) return [0x80 | n];
  if (n < 0x3fff) return [0x40 | (n >> 8), n & 0xff];
  return [0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff];
}
const el = (id: number, data: number[]) => [...idBytes(id), ...size(data.length), ...data];
const unknown = (id: number, data: number[]) => [...idBytes(id), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...data];
const uint = (n: number) => (n < 256 ? [n] : [n >> 8, n & 0xff]);
const block = (track: number, rel: number, key: boolean) =>
  el(0xa3, [0x80 | track, (rel >> 8) & 0xff, rel & 0xff, key ? 0x80 : 0x00, 0xde, 0xad]);
// Chrome writes video as BlockGroups when frames carry alpha; a ReferenceBlock marks a delta frame.
const group = (track: number, rel: number, key: boolean) =>
  el(0xa0, [
    ...el(0xa1, [0x80 | track, (rel >> 8) & 0xff, rel & 0xff, 0x00, 0xbe, 0xef]),
    ...(key ? [] : el(0xfb, [0xff])),
  ]);

function recording(): Uint8Array<ArrayBuffer> {
  const ebml = el(0x1a45dfa3, [...el(0x4282, [0x77, 0x65, 0x62, 0x6d])]);
  const info = el(0x1549a966, [...el(0x2ad7b1, [0x0f, 0x42, 0x40]), ...el(0x4d80, [0x43, 0x68])]);
  const tracks = el(0x1654ae6b, [
    ...el(0xae, [...el(0xd7, [1]), ...el(0x83, [2])]), // audio is track 1
    ...el(0xae, [...el(0xd7, [2]), ...el(0x83, [1])]), // video is track 2
  ]);
  const cluster1 = unknown(0x1f43b675, [
    ...el(0xe7, [0]),
    ...block(2, 0, true),
    ...block(1, 10, true),
    ...block(2, 33, false),
  ]);
  const cluster3 = unknown(0x1f43b675, [
    ...el(0xe7, uint(4000)),
    ...group(2, 0, false), // delta frame first: no cue here
    ...block(1, 10, true),
  ]);
  const cluster4 = unknown(0x1f43b675, [
    ...el(0xe7, uint(5000)),
    ...block(1, 0, true),
    ...group(2, 20, true),
    ...group(2, 53, false),
  ]);
  const cluster2 = unknown(0x1f43b675, [
    ...el(0xe7, uint(1000)),
    ...block(1, 0, true),
    ...block(2, 5, true),
    ...block(2, 2400, false),
  ]);
  return new Uint8Array([...ebml, ...unknown(0x18538067, [...info, ...tracks, ...cluster1, ...cluster2, ...cluster3, ...cluster4])]);
}

/** Minimal reader used only to check the output. */
function readVint(b: Uint8Array, p: number, keepMarker: boolean) {
  let len = 1;
  while (len <= 8 && !(b[p] & (0x80 >> (len - 1)))) len++;
  let v = keepMarker ? b[p] : b[p] & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + b[p + i];
  return { v, len };
}
function children(b: Uint8Array, start: number, end: number) {
  const out: { id: number; start: number; dataStart: number; size: number }[] = [];
  let p = start;
  while (p < end) {
    const id = readVint(b, p, true);
    const sz = readVint(b, p + id.len, false);
    out.push({ id: id.v, start: p, dataStart: p + id.len + sz.len, size: sz.v });
    p += id.len + sz.len + sz.v;
  }
  return out;
}
const uintAt = (b: Uint8Array, p: number, n: number) => b.slice(p, p + n).reduce((v, x) => v * 256 + x, 0);

describe('fixWebm', () => {
  it('adds a Duration and Cues that point at the real clusters', async () => {
    const raw = recording();
    const fix = await fixWebm(new Blob([raw]));
    const fixed = new Uint8Array([...fix.header, ...raw.slice(fix.bodyOffset)]);

    expect(fix.durationMs).toBe(5053 + 20);
    expect(fix.truncated).toBe(false);

    const [ebml] = children(fixed, 0, 30);
    const segStart = ebml.dataStart + ebml.size;
    const segDataStart = segStart + 4 + 8;
    const level1 = children(fixed, segDataStart, fix.header.length);
    expect(level1.map((e) => e.id)).toEqual([0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1c53bb6b]);

    const info = level1[1];
    const duration = children(fixed, info.dataStart, info.dataStart + info.size).find((e) => e.id === 0x4489)!;
    expect(new DataView(fixed.buffer, duration.dataStart, 8).getFloat64(0)).toBe(5073);

    // SeekHead positions land on the elements they name.
    const seeks = children(fixed, level1[0].dataStart, level1[0].dataStart + level1[0].size);
    for (const seek of seeks) {
      const [seekId, seekPos] = children(fixed, seek.dataStart, seek.dataStart + seek.size);
      const target = readVint(fixed, segDataStart + uintAt(fixed, seekPos.dataStart, seekPos.size), true).v;
      expect(target).toBe(uintAt(fixed, seekId.dataStart, seekId.size));
    }

    // One cue per cluster with a video keyframe, on the video track, at the keyframe's time.
    const cues = level1[3];
    const points = children(fixed, cues.dataStart, cues.dataStart + cues.size);
    expect(points).toHaveLength(3);
    const seen = points.map((point) => {
      const [time, positions] = children(fixed, point.dataStart, point.dataStart + point.size);
      const [track, clusterPos] = children(fixed, positions.dataStart, positions.dataStart + positions.size);
      const at = segDataStart + uintAt(fixed, clusterPos.dataStart, clusterPos.size);
      expect(Array.from(fixed.slice(at, at + 4))).toEqual([0x1f, 0x43, 0xb6, 0x75]);
      return [uintAt(fixed, time.dataStart, time.size), uintAt(fixed, track.dataStart, track.size)];
    });
    expect(seen).toEqual([
      [0, 2],
      [1005, 2],
      [5020, 2],
    ]);
  });

  it('survives a recording cut off mid-block', async () => {
    const raw = recording();
    const fix = await fixWebm(new Blob([raw.slice(0, raw.length - 3)]));
    expect(fix.truncated).toBe(true);
    expect(fix.durationMs).toBe(5020 + 20);
  });

  it('rejects something that is not WebM', async () => {
    await expect(fixWebm(new Blob([new Uint8Array([1, 2, 3, 4])]))).rejects.toBeInstanceOf(WebmFixError);
  });
});
