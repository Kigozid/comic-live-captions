import { describe, expect, it } from 'vitest';
import {
  ApplicationAudioClock,
  audioFormatFromFilename,
  createAudioTime,
  createWaveform,
  sampleToSeconds,
  secondsToSample,
  validateAudioInterval,
  type ClockOptions,
} from '@comic-captioner/audio-engine';
import type { AudioTimebase } from '@comic-captioner/shared';

const sampleTimebase: AudioTimebase = {
  id: 'audio:test-samples' as AudioTimebase['id'],
  unit: 'samples',
  sampleRateHz: 48_000,
};
const secondsTimebase: AudioTimebase = {
  id: 'audio:test-seconds' as AudioTimebase['id'],
  unit: 'seconds',
};

function createFakeClock() {
  let now = 0;
  let scheduled: (() => void) | null = null;
  let cancelled = false;
  const options: ClockOptions = {
    now: () => now,
    setInterval: (callback) => {
      scheduled = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      cancelled = true;
      scheduled = null;
    },
  };
  const clock = new ApplicationAudioClock(options);
  return {
    clock,
    advance(seconds: number) {
      now += seconds;
      scheduled?.();
    },
    get cancelled() {
      return cancelled;
    },
  };
}

describe('audio timebase and timeline clock', () => {
  it('converts seconds to nearest samples and back without accumulating fractional drift', () => {
    expect(secondsToSample(1 / 3, 48_000)).toBe(16_000);
    expect(sampleToSeconds(16_000, 48_000)).toBeCloseTo(1 / 3, 12);
    expect(secondsToSample(0.00001, 48_000)).toBe(0);
  });

  it('validates ordered sample and second intervals against audio duration', () => {
    validateAudioInterval(
      createAudioTime(48_000, sampleTimebase),
      createAudioTime(96_000, sampleTimebase),
      3,
      48_000,
    );
    validateAudioInterval(
      createAudioTime(0.5, secondsTimebase),
      createAudioTime(2.5, secondsTimebase),
      3,
      48_000,
    );
    expect(() =>
      validateAudioInterval(
        createAudioTime(96_000, sampleTimebase),
        createAudioTime(48_000, sampleTimebase),
        3,
        48_000,
      ),
    ).toThrow(/ordered/);
    expect(() =>
      validateAudioInterval(
        createAudioTime(0, secondsTimebase),
        createAudioTime(4, secondsTimebase),
        3,
        48_000,
      ),
    ).toThrow(/duration/);
    expect(() =>
      validateAudioInterval(
        createAudioTime(0, secondsTimebase),
        createAudioTime(1, sampleTimebase),
        3,
        48_000,
      ),
    ).toThrow(/same audio timebase/);
  });

  it('advances from monotonic time independently of subscriber scheduling and supports pause, seek, and speed', () => {
    const fake = createFakeClock();
    fake.clock.setDuration(12);
    fake.clock.play();
    fake.advance(2.5);
    expect(fake.clock.getSnapshot().positionSeconds).toBeCloseTo(2.5);
    fake.clock.setPlaybackRate(2);
    fake.advance(1.25);
    expect(fake.clock.getSnapshot().positionSeconds).toBeCloseTo(5);
    fake.clock.seek(30);
    expect(fake.clock.getSnapshot().positionSeconds).toBe(12);
    fake.advance(0.1);
    expect(fake.clock.getSnapshot().status).toBe('paused');
    expect(fake.cancelled).toBe(true);
  });

  it('keeps paused position stable and rejects invalid duration, seek, and playback rates', () => {
    const fake = createFakeClock();
    expect(() => fake.clock.setDuration(0)).toThrow(/Duration/);
    fake.clock.setDuration(5);
    fake.clock.play();
    fake.advance(1.2);
    fake.clock.pause();
    fake.advance(6);
    expect(fake.clock.getSnapshot().positionSeconds).toBeCloseTo(1.2);
    expect(() => fake.clock.seek(Number.NaN)).toThrow(/finite/);
    expect(() => fake.clock.setPlaybackRate(8)).toThrow(/speed/);
  });

  it('recognizes each supported extension and rejects others', () => {
    expect(
      [
        'track.mp3',
        'track.wav',
        'track.m4a',
        'track.aac',
        'track.ogg',
        'track.webm',
      ].map(audioFormatFromFilename),
    ).toEqual(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'webm']);
    expect(audioFormatFromFilename('recording.flac')).toBeNull();
  });

  it('creates normalized waveform peak bins across channels', () => {
    const channelA = new Float32Array([0.1, -0.2, 0.8, 0.1]);
    const channelB = new Float32Array([0.4, 0.2, -0.3, 0.1]);
    const buffer = {
      duration: 1,
      length: 4,
      numberOfChannels: 2,
      getChannelData: (channel: number) =>
        channel === 0 ? channelA : channelB,
    } as AudioBuffer;
    const waveform = createWaveform(buffer, 2);
    expect(waveform.bins[0]).toBeCloseTo(0.4);
    expect(waveform.bins[1]).toBeCloseTo(0.8);
    expect(waveform.durationSeconds).toBe(1);
  });
});
