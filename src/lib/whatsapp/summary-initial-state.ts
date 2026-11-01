import { getCalendarMonthStart } from './summary-calendar';

export function createInitialSummaryState<T extends { summary_date: string }>(
  summaries: T[],
  today: string,
) {
  const date = today;
  return {
    date,
    calendarMonth: getCalendarMonthStart(date),
    activeSummary: summaries.find((summary) => summary.summary_date === date) ?? null,
  };
}
