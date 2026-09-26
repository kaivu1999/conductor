import { ZodError } from 'zod';
import { SupervisorError } from '../supervisor/errors.ts';
import { VoiceError } from '../voice/live.ts';

const STATUS = { bad_request: 400, not_found: 404, conflict: 409, failed: 500 } as const;

/** Map a thrown value to an HTTP status + message a human can act on. */
export function toHttpError(err: unknown): { status: number; error: string; expected: boolean } {
  if (err instanceof SupervisorError) return { status: STATUS[err.code], error: err.message, expected: err.code !== 'failed' };
  if (err instanceof VoiceError) return { status: err.status, error: err.message, expected: err.status < 500 };
  if (err instanceof ZodError) {
    const error = err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
    return { status: 400, error, expected: true };
  }
  const e = err as { statusCode?: number; message?: string; validation?: unknown };
  // Fastify's own errors (malformed JSON, body too large, ...) carry a 4xx statusCode.
  if (typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    return { status: e.statusCode, error: e.message ?? 'bad request', expected: true };
  }
  return { status: 500, error: `Internal error: ${e?.message ?? String(err)}`, expected: false };
}
