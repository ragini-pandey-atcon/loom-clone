import { describe, expect, it } from 'vitest';

import { playedDurationMs, playWindow } from '../api/client';
import { titleFromFileName, uploadMimeType } from './probeVideo';

describe('uploadMimeType', () => {
  it('trusts a known type', () => {
    expect(uploadMimeType({ name: 'a.bin', type: 'video/mp4' })).toBe('video/mp4');
  });

  it('falls back to the extension when Windows reports no type', () => {
    expect(uploadMimeType({ name: 'Demo.MOV', type: '' })).toBe('video/quicktime');
    expect(uploadMimeType({ name: 'clip.m4v', type: '' })).toBe('video/mp4');
    expect(uploadMimeType({ name: 'take.webm', type: 'application/octet-stream' })).toBe('video/webm');
  });

  it('refuses what the player cannot show', () => {
    expect(uploadMimeType({ name: 'old.avi', type: 'video/x-msvideo' })).toBeNull();
    expect(uploadMimeType({ name: 'notes.txt', type: 'text/plain' })).toBeNull();
  });
});

describe('titleFromFileName', () => {
  it('drops only the last extension', () => {
    expect(titleFromFileName('Team update.final.mp4')).toBe('Team update.final');
    expect(titleFromFileName('.mp4')).toBe('Uploaded video');
  });
});

describe('playWindow and playedDurationMs', () => {
  it('is the whole file when not trimmed', () => {
    const v = { durationMs: 10_000, trimStartMs: null, trimEndMs: null };
    expect(playWindow(v)).toEqual({ startMs: 0, endMs: 10_000 });
    expect(playedDurationMs(v)).toBe(10_000);
  });

  it('is the kept part when trimmed', () => {
    const v = { durationMs: 10_000, trimStartMs: 1500, trimEndMs: 8000 };
    expect(playWindow(v)).toEqual({ startMs: 1500, endMs: 8000 });
    expect(playedDurationMs(v)).toBe(6500);
  });

  it('has no length while the length is unknown', () => {
    expect(playedDurationMs({ durationMs: null, trimStartMs: null, trimEndMs: null })).toBeNull();
  });
});
