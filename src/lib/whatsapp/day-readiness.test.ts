import { describe, expect, it } from 'vitest';
import { isDayReady, type WhatsappDayReadiness } from './day-readiness';

const ready: WhatsappDayReadiness = { date: '2026-10-28', state: 'ready', ready: true,
  messages: 5, audioTotal: 2, audioTranscribed: 2, pendingAudio: 0, reason: '' };

describe('liberação de resumo por dia', () => {
  it('libera somente a data confirmada, com mensagens e sem áudio pendente', () => {
    expect(isDayReady(ready, ready.date)).toBe(true);
    expect(isDayReady(ready, '2026-10-29')).toBe(false);
    expect(isDayReady(null, ready.date)).toBe(false);
    for (const changed of [{ ready: false }, { state: 'history_pending' }, { pendingAudio: 1 }, { messages: 0 }]) {
      expect(isDayReady({ ...ready, ...changed }, ready.date)).toBe(false);
    }
  });
});
