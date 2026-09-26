import type { FastifyReply, FastifyRequest } from 'fastify';
import type { StreamEvent } from '@conductor/shared';

export interface SseHub {
  handle(req: FastifyRequest, reply: FastifyReply): void;
  broadcast(e: StreamEvent): void;
  readonly size: number;
  close(): void;
}

/**
 * Server-Sent Events fan-out. Each client gets `event: <type>` + JSON `data:`. A client
 * whose socket buffer backs up past a limit is dropped (it will reconnect and resync)
 * rather than letting a slow tab grow our memory without bound.
 */
export function createSseHub(opts: { snapshot: () => Promise<StreamEvent>; heartbeatMs?: number; maxBufferBytes?: number }): SseHub {
  const clients = new Set<FastifyReply['raw']>();
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const maxBuffer = opts.maxBufferBytes ?? 8 * 1024 * 1024;

  const frame = (e: StreamEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

  function write(res: FastifyReply['raw'], chunk: string): void {
    if (res.destroyed || res.writableEnded) {
      clients.delete(res);
      return;
    }
    if (res.writableLength > maxBuffer) {
      clients.delete(res);
      res.destroy();
      return;
    }
    res.write(chunk);
  }

  const heartbeat = setInterval(() => {
    for (const res of clients) write(res, `: ping ${Date.now()}\n\n`);
  }, heartbeatMs);
  heartbeat.unref();

  return {
    get size() {
      return clients.size;
    },
    handle(req, reply) {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      const drop = () => clients.delete(res);
      req.raw.on('close', drop);
      res.on('close', drop);
      res.on('error', drop);
      opts.snapshot().then((e) => write(res, frame(e)), () => {});
    },
    broadcast(e) {
      if (!clients.size) return;
      const chunk = frame(e);
      for (const res of clients) write(res, chunk);
    },
    close() {
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
