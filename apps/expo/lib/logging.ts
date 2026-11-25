import {
  outboxLogger, posOrdersLogger, registerCommandsLogger, registerFactsLogger, registerSessionsLogger, saleLogger, taxLogger,
  type LogEntry, type LogSink,
} from '@tallyui/pos';

/**
 * The money path's log sinks (TallyUI ce184e6): `saleLogger` logs a save that failed for an abandoned attempt,
 * `outboxLogger` a retried order stored under another commandId (warn) and a content mismatch (error),
 * `posOrdersLogger` a migration status or record read or write that TallyUI #155 dropped rather than let reach
 * closed storage. Without a sink those go nowhere. The console sink writes them to the console; the recent sink keeps
 * them for Settings › Health. A later remote-logging job can add another sink next to them (`addSink`, keyed by id)
 * without touching these.
 */
export const CONSOLE_SINK_ID = 'medusapos-console';
export const RECENT_SINK_ID = 'medusapos-recent';
// Settings › Health's log view: a shift's warnings and errors fit in 200 lines, and 200 small entries keep the memory
// held well under a megabyte.
export const RECENT_LOG_LIMIT = 200;
// The data part of a log line is cut here, so one large payload cannot swamp a support message.
const DATA_TEXT_LIMIT = 1000;

/** Warn to `console.warn` and error to `console.error`, with the scope, message and data. Never throws. */
export function consoleLogSink(): LogSink {
  return {
    id: CONSOLE_SINK_ID,
    levels: ['warn', 'error'],
    write(entry: LogEntry) {
      // TallyUI's logger calls its sinks unguarded, from inside complete() and record(): a sink that
      // threw there would fail the sale it is logging about.
      try {
        const write = entry.level === 'error' ? console.error : console.warn;
        write(`[${entry.scope}] ${entry.message}`, entry.data ?? {});
      } catch {
        // Logging must never break a sale.
      }
    },
  };
}

const recent: LogEntry[] = [];
const listeners = new Set<() => void>();

/** Keeps the last RECENT_LOG_LIMIT warnings and errors in memory, oldest dropped first. Never throws. */
export function recentLogSink(): LogSink {
  return {
    id: RECENT_SINK_ID,
    levels: ['warn', 'error'],
    write(entry: LogEntry) {
      // Called unguarded inside the sale save, as above: nothing here may throw out.
      try {
        recent.push(entry);
        if (recent.length > RECENT_LOG_LIMIT) recent.splice(0, recent.length - RECENT_LOG_LIMIT);
      } catch {
        return;
      }
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* one listener's failure stops neither the sink nor the others */ }
      }
    },
  };
}

/** The kept warnings and errors, oldest first; a copy. */
export function recentLogs(): readonly LogEntry[] {
  return recent.slice();
}

/** Calls `listener` after each new kept entry; the return unsubscribes. */
export function subscribeRecentLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test only: forgets the kept entries. */
export function clearRecentLogs(): void {
  recent.length = 0;
}

/** `<ISO time> <LEVEL> [<scope>] <message>`, plus ` <data as JSON>` (cut to 1000 characters) when `data` has keys. */
export function formatLogLine(entry: LogEntry): string {
  const head = `${new Date(entry.timestamp).toISOString()} ${entry.level.toUpperCase()} [${entry.scope}] ${entry.message}`;
  if (!entry.data || Object.keys(entry.data).length === 0) return head;
  let text: string;
  try {
    text = JSON.stringify(entry.data);
  } catch {
    text = '[unserialisable data]';
  }
  return `${head} ${text.slice(0, DATA_TEXT_LIMIT)}`;
}

/** Adds the console sink to `saleLogger`, `outboxLogger` and `posOrdersLogger`, and the recent sink to every TallyUI
 * logger. Called once at app start (`app/_layout.tsx`); a repeat replaces them. */
export function installLogSinks(): void {
  saleLogger.addSink(consoleLogSink());
  outboxLogger.addSink(consoleLogSink());
  posOrdersLogger.addSink(consoleLogSink());
  for (const logger of [saleLogger, outboxLogger, posOrdersLogger, registerCommandsLogger, registerFactsLogger,
    registerSessionsLogger, taxLogger]) logger.addSink(recentLogSink());
}
