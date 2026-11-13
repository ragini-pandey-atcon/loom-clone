/**
 * Turns a video's sound into what the local speech model reads: 16 kHz, mono, 16-bit PCM. The
 * browser's own decoder does it (decodeAudioData resamples to the context's rate), so the server
 * needs no ffmpeg.
 */
import { api, mediaUrl, type Transcript } from '../api/client';

export const SAMPLE_RATE = 16_000;
/** Quieter than this all the way through counts as no speech. Whisper invents words on silence. */
const SILENCE_RMS = 0.003;

/** Mixes channels down to one and converts to 16-bit little-endian PCM. */
export function toPcm16(channels: Float32Array[]): Int16Array {
  const length = channels[0]?.length ?? 0;
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    const v = Math.max(-1, Math.min(1, sum / channels.length));
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

export function isSilent(pcm: Int16Array): boolean {
  if (pcm.length === 0) return true;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length) < SILENCE_RMS;
}

/** The sound of a video file as PCM, or null when it has none the browser can read. */
export async function extractSpeechPcm(file: Blob): Promise<Int16Array | null> {
  const bytes = await file.arrayBuffer();
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: SAMPLE_RATE, sampleRate: SAMPLE_RATE });
  let audio: AudioBuffer;
  try {
    audio = await ctx.decodeAudioData(bytes);
  } catch {
    return null; // no audio track (screen recorded without a microphone, for example)
  }
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
  const pcm = toPcm16(channels);
  return isSilent(pcm) ? null : pcm;
}

/** Decodes the sound and hands it to the API, which transcribes it in the background. */
export async function startTranscript(videoId: string, file?: Blob): Promise<Transcript> {
  let source: Blob;
  if (file) source = file;
  else {
    const res = await fetch(mediaUrl(videoId));
    if (!res.ok) throw new Error('The video file could not be read.');
    source = await res.blob();
  }
  const pcm = await extractSpeechPcm(source);
  return api.putAudio(videoId, new Blob(pcm ? [pcm.buffer as ArrayBuffer] : [], { type: 'application/octet-stream' }));
}
