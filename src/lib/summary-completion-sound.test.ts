import { describe, expect, it, vi } from 'vitest';
import { playSummaryCompletionSound } from './summary-completion-sound';

describe('playSummaryCompletionSound', () => {
  it('toca duas notas discretas, sem a varredura de frequência do alerta anterior', () => {
    const oscillators = Array.from({ length: 2 }, () => ({
      type: 'sine' as OscillatorType,
      frequency: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
    }));
    const gains = Array.from({ length: 2 }, () => ({
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    }));
    const context = {
      currentTime: 10,
      state: 'running',
      destination: {},
      createOscillator: vi
        .fn()
        .mockReturnValueOnce(oscillators[0])
        .mockReturnValueOnce(oscillators[1]),
      createGain: vi.fn().mockReturnValueOnce(gains[0]).mockReturnValueOnce(gains[1]),
      resume: vi.fn(),
      close: vi.fn(),
    };
    const AudioContextMock = vi.fn(function AudioContextMock() {
      return context;
    });

    const played = playSummaryCompletionSound(AudioContextMock as unknown as typeof AudioContext);

    expect(played).toBe(true);
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(659.25, 10);
    expect(oscillators[1].frequency.setValueAtTime).toHaveBeenCalledWith(783.99, 10.16);
    expect(oscillators[0].frequency.exponentialRampToValueAtTime).not.toHaveBeenCalled();
    expect(oscillators[1].frequency.exponentialRampToValueAtTime).not.toHaveBeenCalled();
    expect(oscillators[0].stop).toHaveBeenCalledWith(10.14);
    expect(oscillators[1].stop).toHaveBeenCalledWith(10.38);
  });

  it('não tenta tocar quando a Web Audio API não está disponível', () => {
    expect(playSummaryCompletionSound()).toBe(false);
  });
});
