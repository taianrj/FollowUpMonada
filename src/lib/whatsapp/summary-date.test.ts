import { describe, expect, it } from 'vitest';
import { formatSummaryDate } from './summary-date';

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
