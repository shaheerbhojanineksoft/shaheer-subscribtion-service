/** Minimal structured logger used across the service. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const CONSOLE_METHOD: Record<LogLevel, 'log' | 'info' | 'warn' | 'error'> = {
  DEBUG: 'log',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
};

function write(level: LogLevel, message: string, args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  const method = CONSOLE_METHOD[level];
  if (args.length > 0) {
    // eslint-disable-next-line no-console
    console[method](line, ...args);
  } else {
    // eslint-disable-next-line no-console
    console[method](line);
  }
}

export const logger: Logger = {
  debug: (message: string, ...args: unknown[]) => write('DEBUG', message, args),
  info: (message: string, ...args: unknown[]) => write('INFO', message, args),
  warn: (message: string, ...args: unknown[]) => write('WARN', message, args),
  error: (message: string, ...args: unknown[]) => write('ERROR', message, args),
};

/** A logger that swallows everything — useful in tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
