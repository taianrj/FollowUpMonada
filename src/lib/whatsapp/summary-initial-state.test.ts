import { describe, expect, it } from 'vitest';
import { createInitialSummaryState } from './summary-initial-state';

describe('data inicial dos resumos diários', () => {
  it('abre hoje e seu mês mesmo quando existem apenas resumos antigos', () => {
    const previous = { id: 'previous', summary_date: '2026-09-09' };
    expect(createInitialSummaryState([previous], '2026-10-31')).toEqual({
      date: '2026-10-31',
      calendarMonth: '2026-10-01',
      activeSummary: null,
    });
  });

  it('exibe somente o resumo de hoje, independentemente da ordem dos salvos', () => {
    const today = { id: 'today', summary_date: '2026-10-31' };
    const future = { id: 'future', summary_date: '2026-11-01' };
    expect(createInitialSummaryState([future, today], '2026-10-31')).toEqual({
      date: '2026-10-31',
      calendarMonth: '2026-10-01',
      activeSummary: today,
    });
  });

  it('abre hoje sem resumo em uma conta sem histórico', () => {
    expect(createInitialSummaryState([], '2026-11-01')).toEqual({
      date: '2026-11-01',
      calendarMonth: '2026-11-01',
      activeSummary: null,
    });
  });
});
