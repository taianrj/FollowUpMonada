import { describe, expect, it } from 'vitest';
import {
  buildSummaryCalendarDays,
  formatCalendarMonth,
  getCalendarMonthStart,
  shiftCalendarMonth,
} from './summary-calendar';

describe('calendário dos resumos do WhatsApp', () => {
  it('monta uma grade estável de seis semanas começando no domingo', () => {
    const days = buildSummaryCalendarDays('2026-08-01', '2026-08-16');

    expect(days).toHaveLength(42);
    expect(days[0]).toMatchObject({ date: '2026-07-26', isCurrentMonth: false });
    expect(days[6].date).toBe('2026-08-01');
    expect(days.find((day) => day.date === '2026-08-16')).toMatchObject({
      isCurrentMonth: true,
      isToday: true,
    });
    expect(days.at(-1)?.date).toBe('2026-09-05');
  });

  it('navega entre anos e mantém datas de calendário válidas', () => {
    expect(shiftCalendarMonth('2026-01-01', -1)).toBe('2025-12-01');
    expect(shiftCalendarMonth('2026-12-01', 1)).toBe('2027-01-01');
    expect(getCalendarMonthStart('2024-02-29')).toBe('2024-02-01');
  });

  it('formata o mês em português e rejeita datas inválidas', () => {
    expect(formatCalendarMonth('2026-08-01')).toBe('Agosto de 2026');
    expect(buildSummaryCalendarDays('2026-02-30', '2026-08-16')).toEqual([]);
  });
});
