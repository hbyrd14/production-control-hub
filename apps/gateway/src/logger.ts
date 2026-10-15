export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: Level, sink: (line: string) => void = (l) => console.log(l)): Logger {
  const make = (l: Level) => (msg: string) => {
    if (ORDER[l] >= ORDER[level]) sink(`${new Date().toISOString()} ${l.toUpperCase().padEnd(5)} ${msg}`);
  };
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
