// A tenth of a second gives a short confirmation without delaying the next scan.
const BEEP_SECONDS = 0.1;
// A mid-high sine tone is easy to hear at a till.
const BEEP_HZ = 880;
// Keep the confirmation quiet relative to full-scale audio.
const BEEP_GAIN = 0.08;

let context: AudioContext | undefined;

export function playScanBeep(): void {
  try {
    const AudioContextClass = globalThis.AudioContext
      ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    context ??= new AudioContextClass();
    if (context.state === 'suspended') void context.resume().catch(() => {});
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.frequency.value = BEEP_HZ;
    gain.gain.value = BEEP_GAIN;
    oscillator.connect(gain);
    gain.connect(context.destination);
    const start = context.currentTime;
    oscillator.start(start);
    oscillator.stop(start + BEEP_SECONDS);
  } catch { /* Sound failures must never block a scan. */ }
}
