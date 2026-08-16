import { formatSummaryDate } from './summary-date';

export interface SummaryCalendarDay {
  date: string;
  dayNumber: number;
  isCurrentMonth: boolean;
  isToday: boolean;
}

function toIsoDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function getCalendarMonthStart(dateString: string): string {
  if (!formatSummaryDate(dateString)) return '';
  return `${dateString.slice(0, 7)}-01`;
}

export function shiftCalendarMonth(monthStart: string, offset: number): string {
  if (!getCalendarMonthStart(monthStart) || !Number.isInteger(offset)) return monthStart;

  const year = Number(monthStart.slice(0, 4));
  const month = Number(monthStart.slice(5, 7));
  return toIsoDate(new Date(Date.UTC(year, month - 1 + offset, 1)));
}

export function formatCalendarMonth(monthStart: string): string {
  if (!getCalendarMonthStart(monthStart)) return monthStart;

  const year = Number(monthStart.slice(0, 4));
  const month = Number(monthStart.slice(5, 7));
  const label = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));

  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function buildSummaryCalendarDays(
  monthStart: string,
  todayDate: string,
): SummaryCalendarDay[] {
  if (!getCalendarMonthStart(monthStart)) return [];

  const year = Number(monthStart.slice(0, 4));
  const monthIndex = Number(monthStart.slice(5, 7)) - 1;
  const firstDay = new Date(Date.UTC(year, monthIndex, 1));
  const gridStart = new Date(firstDay);
  gridStart.setUTCDate(firstDay.getUTCDate() - firstDay.getUTCDay());

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    const isoDate = toIsoDate(date);

    return {
      date: isoDate,
      dayNumber: date.getUTCDate(),
      isCurrentMonth: date.getUTCMonth() === monthIndex,
      isToday: isoDate === todayDate,
    };
  });
}
