/**
 * Errors the supervisor throws on purpose. `code` maps 1:1 to an HTTP status in api/;
 * `message` is written for the human reading the UI, so it should say what to do next.
 */
export type SupervisorErrorCode = 'bad_request' | 'not_found' | 'conflict' | 'failed';

export class SupervisorError extends Error {
  constructor(readonly code: SupervisorErrorCode, message: string) {
    super(message);
    this.name = 'SupervisorError';
  }
}

export const badRequest = (msg: string) => new SupervisorError('bad_request', msg);
export const notFound = (msg: string) => new SupervisorError('not_found', msg);
export const conflict = (msg: string) => new SupervisorError('conflict', msg);

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

export interface Logger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}

export const consoleLogger: Logger = {
  info: (m, ...r) => console.log(`[supervisor] ${m}`, ...r),
  warn: (m, ...r) => console.warn(`[supervisor] ${m}`, ...r),
  error: (m, ...r) => console.error(`[supervisor] ${m}`, ...r),
};
