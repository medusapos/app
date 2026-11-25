export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function parse(value: string | null | undefined): Date | string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date;
}

/** The printed receipt: the locale's medium date and short time, never "Today" (paper outlives the day). */
export function formatReceiptDate(value: string | null | undefined): string {
  const date = parse(value);
  if (typeof date === 'string') return date;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** The paid screen's summary, as v2: `Today · 10:28` for an order on the device's local day, else `Nov 17, 2026 · 7:30 AM`. */
export function formatPaidDate(value: string | null | undefined, now: Date = new Date()): string {
  const date = parse(value);
  if (typeof date === 'string') return date;
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(date);
  const today = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const day = today ? 'Today' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
  return `${day} · ${time}`;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** The Orders table's day header, as v2: `Today`, `Yesterday` (the previous local calendar day), else the medium date. */
export function formatDayHeader(value: string | null | undefined, now: Date = new Date()): string {
  const date = parse(value);
  if (typeof date === 'string') return date;
  if (sameDay(date, now)) return 'Today';
  // Built from the calendar fields, so a day of 23 or 25 hours (a DST change) is still one day back.
  if (sameDay(date, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}
