const MONTHS = [
  'jan.',
  'fev.',
  'mar.',
  'abr.',
  'mai.',
  'jun.',
  'jul.',
  'ago.',
  'set.',
  'out.',
  'nov.',
  'dez.',
] as const;

const WEEKDAYS = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
] as const;

export interface SummaryDateLabels {
  numeric: string;
  compact: string;
  weekday: string;
}

export function formatSummaryDate(dateString: string): SummaryDateLabels | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    numeric: `${match[3]}/${match[2]}/${match[1]}`,
    compact: `${match[3]} ${MONTHS[month - 1]} ${match[1]}`,
    weekday: WEEKDAYS[date.getUTCDay()],
  };
}
