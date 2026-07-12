type BrowserWindowWithWebkitAudioContext = Window & {
  webkitAudioContext?: typeof AudioContext;
};

const NOTIFICATION_NOTES = [
  { frequency: 659.25, startOffset: 0, duration: 0.14 },
  { frequency: 783.99, startOffset: 0.16, duration: 0.22 },
] as const;

export function playSummaryCompletionSound(
  AudioContextConstructor?: typeof AudioContext
): boolean {
  const Constructor = AudioContextConstructor
    ?? (typeof window !== 'undefined'
      ? window.AudioContext
        ?? (window as BrowserWindowWithWebkitAudioContext).webkitAudioContext
      : undefined);

  if (!Constructor) return false;

  const context = new Constructor();
  const startTime = context.currentTime;

  if (context.state === 'suspended') {
    void context.resume();
  }

  NOTIFICATION_NOTES.forEach(({ frequency, startOffset, duration }, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = startTime + startOffset;
    const noteEnd = noteStart + duration;

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, noteStart);

    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.08, noteStart + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(noteStart);
    oscillator.stop(noteEnd);

    if (index === NOTIFICATION_NOTES.length - 1) {
      oscillator.addEventListener('ended', () => {
        void context.close();
      }, { once: true });
    }
  });

  return true;
}
