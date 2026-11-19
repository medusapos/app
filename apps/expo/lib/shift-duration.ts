// How often the open user sheet refreshes the shift duration: the shown minute is at most 15 s late.
export const SHIFT_TICK_MS = 15_000;

/** The time since the register opened, as v2's user sheet: `0 m`, `45 m`, `1 h 43 m` (no days unit). */
export function formatShiftDuration(openedAtIso: string, nowMs: number): string {
  const openedMs = Date.parse(openedAtIso);
  if (Number.isNaN(openedMs)) return '';
  // Clock skew (an opening time in the future) reads as 0 m.
  const minutes = Math.max(0, Math.floor((nowMs - openedMs) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} m` : `${minutes} m`;
}
