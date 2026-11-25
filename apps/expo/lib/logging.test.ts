import { saleLogger, taxLogger, type LogEntry } from '@tallyui/pos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRecentLogs, formatLogLine, installLogSinks, RECENT_LOG_LIMIT, recentLogs, subscribeRecentLogs } from './logging';
import { formatBytes, storageUsageBytes } from './storage-usage';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  installLogSinks();
  clearRecentLogs();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the recent log ring buffer', () => {
  it('keeps warnings and errors from every TallyUI logger in order, and no info', () => {
    saleLogger.warn('save failed', { a: 1 });
    saleLogger.info('just info');
    taxLogger.error('tax broke');
    expect(recentLogs().map(({ level, message }) => [level, message])).toEqual([['warn', 'save failed'], ['error', 'tax broke']]);
  });

  it('drops the oldest past the limit; a listener is called per entry until it unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRecentLogs(listener);
    for (let n = 1; n <= RECENT_LOG_LIMIT + 1; n++) saleLogger.warn(`entry ${n}`);
    expect(RECENT_LOG_LIMIT).toBe(200);
    expect(recentLogs()).toHaveLength(200);
    expect(recentLogs()[0]?.message).toBe('entry 2');
    expect(recentLogs()[199]?.message).toBe('entry 201');
    expect(listener).toHaveBeenCalledTimes(201);
    unsubscribe();
    saleLogger.warn('after');
    expect(listener).toHaveBeenCalledTimes(201);
  });

  it('a listener that throws neither throws out of the logger nor stops the next listener', () => {
    const first = subscribeRecentLogs(() => { throw new Error('boom'); });
    const second = vi.fn();
    const off = subscribeRecentLogs(second);
    expect(() => saleLogger.warn('still logs')).not.toThrow();
    expect(second).toHaveBeenCalledOnce();
    expect(recentLogs().at(-1)?.message).toBe('still logs');
    first(); off();
  });
});

describe('formatLogLine', () => {
  const entry = (data?: Record<string, unknown>): LogEntry =>
    ({ level: 'warn', scope: 'sale', message: 'save failed', timestamp: Date.UTC(2026, 10, 26, 9, 30), data });

  it('with data and without', () => {
    expect(formatLogLine(entry({ a: 1 }))).toBe('2026-11-26T09:30:00.000Z WARN [sale] save failed {"a":1}');
    expect(formatLogLine(entry())).toBe('2026-11-26T09:30:00.000Z WARN [sale] save failed');
    expect(formatLogLine(entry({}))).toBe('2026-11-26T09:30:00.000Z WARN [sale] save failed');
  });

  it('cyclic data is unserialisable, and long data is cut to 1000 characters', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatLogLine(entry(cyclic))).toBe('2026-11-26T09:30:00.000Z WARN [sale] save failed [unserialisable data]');
    const head = '2026-11-26T09:30:00.000Z WARN [sale] save failed ';
    const line = formatLogLine(entry({ big: 'x'.repeat(5000) }));
    expect(line.startsWith(`${head}{"big":"xxx`)).toBe(true);
    expect(line.length).toBe(head.length + 1000);
  });
});

describe('storage usage', () => {
  it('formats bytes', () => {
    expect(formatBytes(null)).toBe('Unknown');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(25165824)).toBe('24 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('reads navigator.storage.estimate, and gives null when it is missing, throws or has no usage', async () => {
    vi.stubGlobal('navigator', {});
    expect(await storageUsageBytes()).toBeNull();
    vi.stubGlobal('navigator', { storage: { estimate: async () => { throw new Error('no'); } } });
    expect(await storageUsageBytes()).toBeNull();
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({}) } });
    expect(await storageUsageBytes()).toBeNull();
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ usage: 25165824 }) } });
    expect(formatBytes(await storageUsageBytes())).toBe('24 MB');
  });
});
