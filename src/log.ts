import { config } from './config';

const ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = ORDER[config.logLevel] ?? 1;

function enabled(level: string): boolean {
  return (ORDER[level] ?? 1) >= threshold;
}

function stamp(): string {
  return new Date().toISOString();
}

export const log = {
  debug(msg: string): void {
    if (enabled('debug')) console.log(`${stamp()} [debug] ${msg}`);
  },
  info(msg: string): void {
    if (enabled('info')) console.log(`${stamp()} [info]  ${msg}`);
  },
  warn(msg: string): void {
    if (enabled('warn')) console.warn(`${stamp()} [warn]  ${msg}`);
  },
  error(msg: string): void {
    console.error(`${stamp()} [error] ${msg}`);
  },
};
