/**
 * Server logging: one JSON object per line (time, level, message, details),
 * which hosting dashboards can search and filter. LOG_LEVEL=debug|info|warn|error.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;

function write(level: Level, msg: string, details?: unknown) {
  if (ORDER[level] < min) return;
  const line: Record<string, unknown> = { t: new Date().toISOString(), level, msg };
  if (details instanceof Error) line.error = { message: details.message, stack: details.stack };
  else if (details !== undefined) line.details = details;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (msg: string, d?: unknown) => write('debug', msg, d),
  info: (msg: string, d?: unknown) => write('info', msg, d),
  warn: (msg: string, d?: unknown) => write('warn', msg, d),
  error: (msg: string, d?: unknown) => write('error', msg, d),
};

/** Request and message counters for /metrics. */
export const counters = { requests: 0, errors: 0, messages: 0, signups: 0, gamesFinished: 0 };
