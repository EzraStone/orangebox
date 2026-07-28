// §10.1 — SSE hub. Subscribers get named events with JSON payloads plus a
// heartbeat comment every 15 s. Events are invalidation hints, never the source
// of truth, so a dropped event costs the UI one stale render at worst.
const HEARTBEAT_MS = 15_000;

export function createLiveHub() {
  const clients = new Set();

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    /** Attach an http response as an SSE subscriber. */
    subscribe(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 1000\n\n');
      res.write(': orangebox live feed\n\n');
      res.flushHeaders?.();

      clients.add(res);
      const drop = () => clients.delete(res);
      req.on('close', drop);
      req.on('error', drop);
      res.on('error', drop);
    },

    publish(event, data) {
      if (clients.size === 0) return;
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) {
        try {
          res.write(frame);
        } catch {
          clients.delete(res);
        }
      }
    },

    get size() {
      return clients.size;
    },

    close() {
      clearInterval(heartbeat);
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* client already gone */
        }
      }
      clients.clear();
    }
  };
}
