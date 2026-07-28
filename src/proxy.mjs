// §06 — proxy engine. M0 scaffold: the routing table in §04 resolves provider
// and run attribution and hands off here. Forwarding, teeing, and persistence
// land in M1/M2; until then the route answers honestly instead of hanging.

export function createProxy({ providers }) {
  return {
    async handle(req, res, { provider, upstreamPath }) {
      const body = JSON.stringify({
        error: 'proxy not implemented yet',
        hint: `would forward ${req.method} ${providers[provider]}${upstreamPath}`
      });
      res.writeHead(501, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body)
      });
      res.end(body);
    }
  };
}
