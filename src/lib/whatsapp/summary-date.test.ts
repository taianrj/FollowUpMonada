import { describe, expect, it } from 'vitest';
import { formatSummaryDate, getSaoPauloDateString } from './summary-date';

describe('data atual de São Paulo', () => {
  it('mantém o dia anterior quando o UTC já mudou de dia e mês', () => {
    expect(getSaoPauloDateString(new Date('2026-11-01T02:59:59.999Z')))
      .toBe('2026-10-31');
  });

  it('muda de dia à meia-noite em São Paulo', () => {
    expect(getSaoPauloDateString(new Date('2026-11-01T03:00:00.000Z')))
      .toBe('2026-11-01');
  });
});

describe('formatSummaryDate', () => {
  it('formata a data e o dia da semana sem deslocamento de fuso horário', () => {
    expect(formatSummaryDate('2026-07-12')).toEqual({
      numeric: '12/07/2026',
      compact: '12 jul. 2026',
      weekday: 'Domingo',
    });
  });

  it('aceita datas bissextas reais', () => {
    expect(formatSummaryDate('2024-02-29')).toEqual({
      numeric: '29/02/2024',
      compact: '29 fev. 2024',
      weekday: 'Quinta-feira',
    });
  });

  it.each(['2026-02-29', '2026-13-01', '12/07/2026', ''])('rejeita a data inválida %s', (date) => {
    expect(formatSummaryDate(date)).toBeNull();
  });
});
