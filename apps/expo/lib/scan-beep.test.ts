import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('AudioContext', undefined);
  vi.stubGlobal('webkitAudioContext', undefined);
});
afterEach(() => vi.unstubAllGlobals());

function stubAudio(state = 'running') {
  const oscillator = { frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const gain = { gain: { value: 0 }, connect: vi.fn() };
  const constructed = vi.fn(), resume = vi.fn().mockResolvedValue(undefined);
  class StubAudioContext {
    state = state;
    currentTime = 2;
    destination = {};
    resume = resume;
    createOscillator = vi.fn(() => oscillator);
    createGain = vi.fn(() => gain);
    constructor() { constructed(this); }
  }
  vi.stubGlobal('AudioContext', StubAudioContext);
  return { oscillator, gain, constructed, resume };
}

describe('playScanBeep', () => {
  it('is a no-op without AudioContext', async () => {
    const { playScanBeep } = await import('./scan-beep');
    expect(playScanBeep).not.toThrow();
  });

  it('connects, starts and stops one oscillator through one gain', async () => {
    const { oscillator, gain, constructed } = stubAudio();
    const { playScanBeep } = await import('./scan-beep');
    expect(constructed).not.toHaveBeenCalled();
    playScanBeep();
    const context = constructed.mock.calls[0][0];
    expect(context.createOscillator).toHaveBeenCalledTimes(1);
    expect(context.createGain).toHaveBeenCalledTimes(1);
    expect(oscillator.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(context.destination);
    expect(oscillator.start).toHaveBeenCalledWith(2);
    expect(oscillator.stop).toHaveBeenCalledWith(2.1);
    expect(gain.gain.value).toBeGreaterThan(0);
    expect(gain.gain.value).toBeLessThan(0.2);
  });

  it('reuses the context across calls', async () => {
    const { constructed, oscillator } = stubAudio();
    const { playScanBeep } = await import('./scan-beep');
    playScanBeep(); playScanBeep();
    expect(constructed).toHaveBeenCalledTimes(1);
    expect(oscillator.start).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('resumes a suspended context and swallows rejection: %s', async (rejects) => {
    const { resume, oscillator } = stubAudio('suspended');
    if (rejects) resume.mockRejectedValue(new Error('Audio blocked'));
    const { playScanBeep } = await import('./scan-beep');
    expect(playScanBeep).not.toThrow();
    await Promise.resolve();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(oscillator.start).toHaveBeenCalledTimes(1);
  });

  it('swallows a constructor failure', async () => {
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('Audio unavailable'); } });
    const { playScanBeep } = await import('./scan-beep');
    expect(playScanBeep).not.toThrow();
  });
});
