import { describe, expect, it } from 'vitest';
import {
  createWhatsappStatusHealth,
  recordWhatsappStatusFailure,
  recordWhatsappStatusSuccess
} from './status-health';

describe('WhatsApp status health', () => {
  it('preserva uma conexao conhecida durante falhas transitorias', () => {
    let state = recordWhatsappStatusSuccess(createWhatsappStatusHealth(), 1_000);
    for (const now of [2_000, 3_000, 4_000, 45_000]) {
      const result = recordWhatsappStatusFailure(state, now);
      state = result.state;
      expect(result.shouldMarkDisconnected).toBe(false);
    }
  });

  it('marca indisponivel somente apos limiar e janela de tolerancia', () => {
    let state = recordWhatsappStatusSuccess(createWhatsappStatusHealth(), 1_000);
    state = recordWhatsappStatusFailure(state, 47_000).state;
    state = recordWhatsappStatusFailure(state, 48_000).state;
    const result = recordWhatsappStatusFailure(state, 49_000);
    expect(result.shouldMarkDisconnected).toBe(true);
  });

  it('uma resposta bem sucedida zera falhas consecutivas', () => {
    let state = createWhatsappStatusHealth();
    state = recordWhatsappStatusFailure(state, 1_000).state;
    state = recordWhatsappStatusSuccess(state, 2_000);
    expect(state).toEqual({ consecutiveFailures: 0, lastSuccessAt: 2_000 });
  });
});
