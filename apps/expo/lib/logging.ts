import { outboxLogger, posOrdersLogger, saleLogger, type LogEntry, type LogSink } from '@tallyui/pos';

/**
 * The money path's log sinks (TallyUI ce184e6): `saleLogger` logs a save that failed for an abandoned attempt,
 * `outboxLogger` a retried order stored under another commandId (warn) and a content mismatch (error),
 * `posOrdersLogger` a migration status or record read or write that TallyUI #155 dropped rather than let reach
 * closed storage. Without a
 * sink those go nowhere. This console sink is the only one for now; a later remote-logging job can add another
 * sink next to it (`addSink`, keyed by id) without touching this one.
 */
export const CONSOLE_SINK_ID = 'medusapos-console';

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

/** Adds the console sink to `saleLogger`, `outboxLogger` and `posOrdersLogger`. Called once at app start
 * (`app/_layout.tsx`); a repeat replaces it. */
export function installLogSinks(): void {
  saleLogger.addSink(consoleLogSink());
  outboxLogger.addSink(consoleLogSink());
  posOrdersLogger.addSink(consoleLogSink());
}
