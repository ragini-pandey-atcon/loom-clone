import { beforeEach, describe, expect, it } from 'vitest';

import { defaultPreferences, loadPreferences, savePreferences } from './preferences';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

describe('recorder preferences', () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('starts from the defaults: 1080p, countdown on, mirrored circle bottom left', () => {
    const p = loadPreferences(storage);
    expect(p).toEqual(defaultPreferences());
    expect(p.quality).toBe('1080p');
    expect(p.countdown).toBe(true);
    expect(p.bubble).toMatchObject({ shape: 'circle', mirror: true, px: 0, py: 1 });
  });

  it('carries settings over to the next recording', () => {
    const p = defaultPreferences();
    p.quality = '1440p';
    p.countdown = false;
    p.bubble = { ...p.bubble, shape: 'portrait', size: 4, px: 0.7, py: 0.2, filter: 'mono', mirror: false };
    savePreferences(p, storage);
    expect(loadPreferences(storage)).toEqual(p);
  });

  it('never carries over a take-only state: full camera or a hidden bubble', () => {
    const p = defaultPreferences();
    p.bubble = { ...p.bubble, fullCamera: true, visible: false };
    savePreferences(p, storage);
    expect(loadPreferences(storage).bubble).toMatchObject({ fullCamera: false, visible: true });
  });

  it('ignores anything invalid and falls back field by field', () => {
    storage.setItem(
      'loom-clone.recorder',
      JSON.stringify({ quality: '8k', countdown: 'yes', bubble: { shape: 'star', size: 9, px: 2, py: -1, filter: 'mono' } }),
    );
    const p = loadPreferences(storage);
    expect(p.quality).toBe('1080p');
    expect(p.countdown).toBe(true);
    expect(p.bubble).toMatchObject({ shape: 'circle', size: 2, px: 1, py: 0, filter: 'mono' });
  });

  it('survives storage that is broken or unavailable', () => {
    storage.setItem('loom-clone.recorder', '{not json');
    expect(loadPreferences(storage)).toEqual(defaultPreferences());
    const throwing = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(loadPreferences(throwing)).toEqual(defaultPreferences());
    expect(() => savePreferences(defaultPreferences(), throwing)).not.toThrow();
  });
});
