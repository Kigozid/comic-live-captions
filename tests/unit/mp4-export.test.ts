import { describe, expect, it } from 'vitest';
import { resolveMp4Dimensions } from '../../apps/web/src/mp4-export.js';

describe('MP4 export dimensions', () => {
  it('provides the requested 720p and 1080p frame sizes', () => {
    expect(resolveMp4Dimensions({ resolution: '720p' })).toEqual({
      width: 1280,
      height: 720,
    });
    expect(resolveMp4Dimensions({ resolution: '1080p' })).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('validates custom sizes and aligns dimensions to encoder-safe even values', () => {
    expect(
      resolveMp4Dimensions({ resolution: 'custom', width: 1279, height: 719 }),
    ).toEqual({ width: 1280, height: 720 });
    expect(() =>
      resolveMp4Dimensions({ resolution: 'custom', width: 0, height: 1080 }),
    ).toThrow(RangeError);
    expect(() =>
      resolveMp4Dimensions({ resolution: 'custom', width: 7682, height: 1080 }),
    ).toThrow(RangeError);
  });
});
