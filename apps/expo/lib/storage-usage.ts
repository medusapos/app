import { Platform } from 'react-native';

/** The bytes this origin stores (web: `navigator.storage.estimate()`), or null when unknown; null on native. Never throws. */
export async function storageUsageBytes(): Promise<number | null> {
  if (Platform.OS !== 'web') return null;
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    const usage = estimate?.usage;
    return typeof usage === 'number' && Number.isFinite(usage) && usage >= 0 ? usage : null;
  } catch {
    return null;
  }
}

const UNITS = ['B', 'KB', 'MB', 'GB'];

/** `Unknown` for null; else B, KB, MB or GB in 1024 steps, one decimal under 10 and none from 10 up. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unknown';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1; }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}
