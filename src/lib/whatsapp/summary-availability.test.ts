import { describe, expect, it } from 'vitest';
import { describeMissingSummaryMessages } from './summary-availability';

const now = new Date('2026-11-01T00:30:00Z');
const options = { retentionDays: 2, syncStatus: 'completed', now };

describe('mensagens ausentes para um resumo', () => {
  it('explica por que uma data antiga não deve disparar reconexões', () => {
    expect(describeMissingSummaryMessages({ ...options, date: '2026-10-28' }))
      .toContain('fora da janela de coleta configurada de 2 dias');
  });

  it('preserva a possibilidade de mensagens no primeiro dia parcial da janela', () => {
    expect(describeMissingSummaryMessages({ ...options, date: '2026-10-29' }))
      .not.toContain('fora da janela');
  });

  it('calcula o corte no dia de São Paulo, inclusive próximo da meia-noite UTC', () => {
    expect(describeMissingSummaryMessages({ ...options, date: '2026-10-29', now: new Date('2026-11-01T02:59:59Z') }))
      .not.toContain('fora da janela');
    expect(describeMissingSummaryMessages({ ...options, date: '2026-10-29', now: new Date('2026-11-01T03:00:00Z') }))
      .toContain('fora da janela');
  });

  it.each(['pending', 'syncing', 'stalled'])('não declara conclusão quando o histórico está %s', (syncStatus) => {
    expect(describeMissingSummaryMessages({ ...options, date: '2026-10-31', syncStatus }))
      .toContain('ainda não confirmou a conclusão');
  });

  it('não confunde histórico concluído com cobertura de todas as datas', () => {
    expect(describeMissingSummaryMessages({ ...options, date: '2026-10-31' }))
      .toContain('não garante que o celular enviou mensagens de todos os dias');
  });

  it.each([null, 0, -1, NaN, 1.5])('não inventa janela se a configuração recebida for %s', (retentionDays) => {
    expect(describeMissingSummaryMessages({ ...options, date: '2026-10-28', retentionDays }))
      .not.toContain('fora da janela');
  });

  it('rejeita datas impossíveis em vez de normalizá-las', () => {
    expect(describeMissingSummaryMessages({ ...options, date: '2026-02-30' }))
      .toContain('Data inválida');
  });
});
