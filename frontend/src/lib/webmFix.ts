/**
 * Makes a MediaRecorder WebM seekable without ffmpeg.
 *
 * Chrome's MediaRecorder writes WebM in "live" mode: no Duration in the Info element, no Cues
 * (seek index), and Segment and Cluster sizes left as "unknown". A player then shows no length
 * and either cannot seek or has to scan the whole file to do it.
 *
 * fixWebm walks the recording once, then builds a new metadata header:
 *
 *   EBML header | Segment (unknown size) | SeekHead | Info + Duration | Tracks | other | Cues
 *
 * The clusters (the media itself) are untouched, so the fixed file is
 * `header + recording.slice(bodyOffset)`. Only the header travels to the server at Stop, which
 * is what keeps the share link instant. Every number in the header is written with a fixed
 * 8-byte width, so its size is known before the positions inside it are.
 */

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Void: 0xec,
} as const;

/** Elements that live directly under Segment. Seeing one ends an unknown-size Cluster. */
const LEVEL1 = new Set<number>([
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cluster,
  ID.Cues,
  0x1254c367, // Tags
  0x1043a770, // Chapters
  0x1941a469, // Attachments
]);

const WINDOW = 4 * 1024 * 1024;

export interface FixResult {
  /** New metadata to put in front of `recording.slice(bodyOffset)`. */
  header: Uint8Array<ArrayBuffer>;
  bodyOffset: number;
  durationMs: number;
  cueCount: number;
  /** True when the recording ended mid-element (a crash); the tail is dropped by players. */
  truncated: boolean;
}

export class WebmFixError extends Error {}

/** Random access over a Blob through a 4 MB window, so an hour-long take never sits in JS memory. */
class Reader {
  private start = 0;
  private bytes = new Uint8Array(0);
  readonly size: number;
  constructor(private readonly blob: Blob) {
    this.size = blob.size;
  }
  has(pos: number, len: number): boolean {
    return pos >= this.start && pos + len <= this.start + this.bytes.length;
  }
  async load(pos: number, len: number): Promise<void> {
    const end = Math.min(this.size, pos + Math.max(len, WINDOW));
    this.bytes = new Uint8Array(await this.blob.slice(pos, end).arrayBuffer());
    this.start = pos;
  }
  async ensure(pos: number, len: number): Promise<boolean> {
    if (pos + len > this.size) return false;
    if (!this.has(pos, len)) await this.load(pos, len);
    return true;
  }
  byte(pos: number): number {
    return this.bytes[pos - this.start];
  }
  slice(pos: number, len: number): Uint8Array {
    const from = pos - this.start;
    return this.bytes.slice(from, from + len);
  }
}

interface Header {
  id: number;
  /** null for "unknown size". */
  size: number | null;
  dataStart: number;
}

function vintLength(first: number): number {
  for (let len = 1; len <= 8; len++) if (first & (0x80 >> (len - 1))) return len;
  return 0;
}

/** Reads an element ID and size at pos. Returns null at a clean or truncated end of data. */
async function readHeader(r: Reader, pos: number): Promise<Header | null> {
  if (!(await r.ensure(pos, 1))) return null;
  const idLen = vintLength(r.byte(pos));
  if (idLen < 1 || idLen > 4) throw new WebmFixError(`Bad element ID at byte ${pos}`);
  if (!(await r.ensure(pos, idLen + 1))) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + r.byte(pos + i);
  const sizePos = pos + idLen;
  const sizeLen = vintLength(r.byte(sizePos));
  if (sizeLen < 1) throw new WebmFixError(`Bad element size at byte ${sizePos}`);
  if (!(await r.ensure(sizePos, sizeLen))) return null;
  let value = r.byte(sizePos) & (0xff >> sizeLen);
  let allOnes = value === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    const b = r.byte(sizePos + i);
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  return { id, size: allOnes ? null : value, dataStart: sizePos + sizeLen };
}

function readUint(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

// ---- writing -------------------------------------------------------------------------------

function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

/** 8-byte size vint (0x01 marker + 7 bytes), so an element's length never depends on its data. */
function size8(n: number): number[] {
  const out = [0x01];
  for (let i = 6; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) % 256);
  return out;
}

function uint8(n: number): number[] {
  const out: number[] = [];
  for (let i = 7; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) % 256);
  return out;
}

function float64(n: number): number[] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, n);
  return Array.from(new Uint8Array(view.buffer));
}

function el(id: number, data: ArrayLike<number>): number[] {
  return [...idBytes(id), ...size8(data.length), ...Array.from(data)];
}

const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

// ---- the walk ------------------------------------------------------------------------------

interface Cue {
  timeTicks: number;
  clusterPos: number;
}

export async function fixWebm(recording: Blob): Promise<FixResult> {
  const r = new Reader(recording);

  const ebml = await readHeader(r, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === null) throw new WebmFixError('Not a WebM file');
  const segPos = ebml.dataStart + ebml.size;
  const seg = await readHeader(r, segPos);
  if (!seg || seg.id !== ID.Segment) throw new WebmFixError('No Segment');
  await r.ensure(0, segPos);
  const ebmlBytes = r.slice(0, segPos);

  let timecodeScale = 1_000_000;
  let infoChildren: number[] = [];
  let tracksBytes: Uint8Array | null = null;
  const extras: Uint8Array[] = [];
  let videoTrack: number | null = null;
  let firstTrack: number | null = null;
  let firstCluster: number | null = null;
  let maxTicks = 0;
  let truncated = false;
  const cues: Cue[] = [];
  const clusterCues: Cue[] = [];

  let pos = seg.dataStart;
  while (pos < r.size) {
    const h = await readHeader(r, pos);
    if (!h) {
      truncated = true;
      break;
    }

    if (h.id === ID.Cluster) {
      if (firstCluster === null) firstCluster = pos;
      const clusterPos = pos;
      const end = h.size === null ? Infinity : h.dataStart + h.size;
      let clusterTicks = 0;
      let cuedThisCluster = false;
      let p = h.dataStart;
      let clean = true;
      while (p < end && p < r.size) {
        const c = await readHeader(r, p);
        if (!c) {
          clean = false;
          break;
        }
        if (h.size === null && LEVEL1.has(c.id)) break;
        if (c.size === null) throw new WebmFixError(`Unknown-size element inside a Cluster at ${p}`);
        if (!(await r.ensure(c.dataStart, Math.min(c.size, 4)))) {
          clean = false;
          break;
        }
        if (c.dataStart + c.size > r.size) {
          clean = false;
          break;
        }
        if (c.id === ID.Timecode) {
          await r.ensure(c.dataStart, c.size);
          clusterTicks = readUint(r.slice(c.dataStart, c.size));
          clusterCues.push({ timeTicks: clusterTicks, clusterPos });
        } else if (c.id === ID.SimpleBlock || c.id === ID.BlockGroup) {
          let blockStart = c.dataStart;
          // A BlockGroup holds a Block and, for a frame that depends on others, a ReferenceBlock.
          // Chrome writes video this way when frames carry alpha, so it matters for the cues.
          let groupKeyframe = true;
          if (c.id === ID.BlockGroup) {
            let found: number | null = null;
            let q = c.dataStart;
            const groupEnd = c.dataStart + c.size;
            while (q < groupEnd) {
              const inner = await readHeader(r, q);
              if (!inner || inner.size === null) break;
              if (inner.id === ID.Block) found = inner.dataStart;
              if (inner.id === ID.ReferenceBlock) groupKeyframe = false;
              q = inner.dataStart + inner.size;
            }
            if (found === null) {
              p = groupEnd;
              continue;
            }
            blockStart = found;
          }
          await r.ensure(blockStart, Math.min(11, c.dataStart + c.size - blockStart));
          const trackLen = vintLength(r.byte(blockStart));
          const track = readUint(r.slice(blockStart, trackLen)) - (0x80 >> (trackLen - 1)) * 256 ** (trackLen - 1);
          const relRaw = (r.byte(blockStart + trackLen) << 8) | r.byte(blockStart + trackLen + 1);
          const rel = relRaw > 0x7fff ? relRaw - 0x10000 : relRaw;
          const flags = r.byte(blockStart + trackLen + 2);
          const ticks = clusterTicks + rel;
          if (ticks > maxTicks) maxTicks = ticks;
          if (firstTrack === null) firstTrack = track;
          const keyframe = c.id === ID.SimpleBlock ? (flags & 0x80) !== 0 : groupKeyframe;
          if (keyframe && track === videoTrack && !cuedThisCluster) {
            cues.push({ timeTicks: Math.max(0, ticks), clusterPos });
            cuedThisCluster = true;
          }
        }
        p = c.dataStart + c.size;
      }
      if (!clean) {
        truncated = true;
        break;
      }
      pos = h.size === null ? p : end;
      continue;
    }

    if (h.size === null) throw new WebmFixError(`Unknown-size element ${h.id.toString(16)} at ${pos}`);
    const end = h.dataStart + h.size;
    if (end > r.size) {
      truncated = true;
      break;
    }

    if (firstCluster === null) {
      if (h.id === ID.Info) {
        await r.ensure(h.dataStart, h.size);
        let p = h.dataStart;
        while (p < end) {
          const c = await readHeader(r, p);
          if (!c || c.size === null) throw new WebmFixError('Bad Info element');
          const childEnd = c.dataStart + c.size;
          await r.ensure(p, childEnd - p);
          if (c.id === ID.TimecodeScale) timecodeScale = readUint(r.slice(c.dataStart, c.size));
          if (c.id !== ID.Duration) infoChildren = infoChildren.concat(Array.from(r.slice(p, childEnd - p)));
          p = childEnd;
        }
      } else if (h.id === ID.Tracks) {
        await r.ensure(pos, end - pos);
        tracksBytes = r.slice(pos, end - pos);
        videoTrack = await findVideoTrack(r, h.dataStart, end);
      } else if (h.id !== ID.SeekHead && h.id !== ID.Cues && h.id !== ID.Void) {
        await r.ensure(pos, end - pos);
        extras.push(r.slice(pos, end - pos));
      }
    }
    pos = end;
  }

  if (firstCluster === null) throw new WebmFixError('The recording has no video data');
  if (!tracksBytes) throw new WebmFixError('The recording has no Tracks');

  // A small tail so the last frame is inside the duration rather than on its edge.
  const durationTicks = maxTicks + Math.round(20_000_000 / timecodeScale);
  const durationMs = Math.round((durationTicks * timecodeScale) / 1_000_000);

  const chosen = cues.length > 0 ? cues : dedupeByCluster(clusterCues);
  const cueTrack = videoTrack ?? firstTrack ?? 1;

  const info = el(ID.Info, [...infoChildren, ...el(ID.Duration, float64(durationTicks))]);
  const extraBytes = extras.flatMap((e) => Array.from(e));

  const buildCues = (clustersStart: number) =>
    el(
      ID.Cues,
      chosen.flatMap((cue) =>
        el(ID.CuePoint, [
          ...el(ID.CueTime, uint8(cue.timeTicks)),
          ...el(ID.CueTrackPositions, [
            ...el(ID.CueTrack, uint8(cueTrack)),
            ...el(ID.CueClusterPosition, uint8(clustersStart + (cue.clusterPos - firstCluster!))),
          ]),
        ]),
      ),
    );
  const buildSeekHead = (infoPos: number, tracksPos: number, cuesPos: number) =>
    el(ID.SeekHead, [
      ...el(ID.Seek, [...el(ID.SeekID, idBytes(ID.Info)), ...el(ID.SeekPosition, uint8(infoPos))]),
      ...el(ID.Seek, [...el(ID.SeekID, idBytes(ID.Tracks)), ...el(ID.SeekPosition, uint8(tracksPos))]),
      ...el(ID.Seek, [...el(ID.SeekID, idBytes(ID.Cues)), ...el(ID.SeekPosition, uint8(cuesPos))]),
    ]);

  // Sizes first (fixed-width numbers make them independent of the values), then positions.
  const seekHeadLen = buildSeekHead(0, 0, 0).length;
  const cuesLen = buildCues(0).length;
  const infoPos = seekHeadLen;
  const tracksPos = infoPos + info.length;
  const cuesPos = tracksPos + tracksBytes.length + extraBytes.length;
  const clustersStart = cuesPos + cuesLen;

  const segmentData = [
    ...buildSeekHead(infoPos, tracksPos, cuesPos),
    ...info,
    ...Array.from(tracksBytes),
    ...extraBytes,
    ...buildCues(clustersStart),
  ];
  const header = new Uint8Array(ebmlBytes.length + 4 + 8 + segmentData.length);
  header.set(ebmlBytes, 0);
  header.set([...idBytes(ID.Segment), ...UNKNOWN_SIZE], ebmlBytes.length);
  header.set(segmentData, ebmlBytes.length + 12);

  return { header, bodyOffset: firstCluster, durationMs, cueCount: chosen.length, truncated };
}

function dedupeByCluster(list: Cue[]): Cue[] {
  const seen = new Set<number>();
  return list.filter((c) => (seen.has(c.clusterPos) ? false : (seen.add(c.clusterPos), true)));
}

async function findVideoTrack(r: Reader, start: number, end: number): Promise<number | null> {
  let p = start;
  while (p < end) {
    const entry = await readHeader(r, p);
    if (!entry || entry.size === null) return null;
    const entryEnd = entry.dataStart + entry.size;
    if (entry.id === ID.TrackEntry) {
      let number: number | null = null;
      let type: number | null = null;
      let q = entry.dataStart;
      while (q < entryEnd) {
        const c = await readHeader(r, q);
        if (!c || c.size === null) break;
        await r.ensure(c.dataStart, c.size);
        if (c.id === ID.TrackNumber) number = readUint(r.slice(c.dataStart, c.size));
        if (c.id === ID.TrackType) type = readUint(r.slice(c.dataStart, c.size));
        q = c.dataStart + c.size;
      }
      if (type === 1 && number !== null) return number;
    }
    p = entryEnd;
  }
  return null;
}
