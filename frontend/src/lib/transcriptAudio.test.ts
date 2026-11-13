import { describe, expect, it } from 'vitest';

import { isSilent, toPcm16 } from './transcriptAudio';

describe('toPcm16', () => {
  it('mixes channels and clips to 16 bits', () => {
    const left = new Float32Array([1, -1, 0.5, 2]);
    const right = new Float32Array([1, -1, -0.5, 2]);
    expect(Array.from(toPcm16([left, right]))).toEqual([32767, -32768, 0, 32767]);
  });

  it('is empty for no samples', () => {
    expect(toPcm16([new Float32Array(0)]).length).toBe(0);
  });
});

describe('isSilent', () => {
  it('treats near-silence as no speech, so the model is not asked to invent words', () => {
    expect(isSilent(new Int16Array(16000))).toBe(true);
    expect(isSilent(new Int16Array(16000).fill(20))).toBe(true);
    const speech = new Int16Array(16000).map((_, i) => Math.round(Math.sin(i / 10) * 4000));
    expect(isSilent(speech)).toBe(false);
  });
});
