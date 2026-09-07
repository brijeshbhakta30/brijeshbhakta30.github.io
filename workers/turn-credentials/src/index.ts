/* eslint-disable unicorn/filename-case */
type Environment = {
  ALLOWED_ORIGINS: string;
  TURN_KEY_ID: string;
  TURN_KEY_API_TOKEN: string;
  TURN_TTL_SECONDS?: string;
};

type TurnIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const allowedOrigins = (env: Environment) =>
  new Set(
    env.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

const corsHeaders = (origin: string) => ({
  'access-control-allow-origin': origin,
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
  vary: 'Origin',
});

const json = (body: unknown, status: number, origin = '') =>
  Response.json(body, {
    status,
    headers: {
      ...JSON_HEADERS,
      ...(origin ? corsHeaders(origin) : { vary: 'Origin' }),
    },
  });

const normalizeIceServers = (body: unknown) => {
  const response = body as { iceServers?: TurnIceServer[] };
  if (!Array.isArray(response.iceServers)) return [];
  return response.iceServers.map((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return {
      ...server,
      urls: urls.filter((url) => typeof url === 'string' && !url.includes(':53')),
    };
  }).filter((server) => server.urls.length > 0);
};

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    const origin = request.headers.get('origin') ?? '';
    if (!origin || !allowedOrigins(env).has(origin))
      return json({ error: 'Origin is not allowed' }, 403);

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const url = new URL(request.url);
    if (
      request.method !== 'GET' ||
      (url.pathname !== '/credentials' && url.pathname !== '/turn')
    )
      return json({ error: 'Not found' }, 404, origin);

    const ttl = Math.max(
      300,
      Math.min(86_400, Number(env.TURN_TTL_SECONDS ?? 86_400) || 86_400),
    );
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ttl }),
      },
    );

    if (!response.ok)
      return json({ error: 'Could not generate TURN credentials' }, 502, origin);

    const iceServers = normalizeIceServers(await response.json());
    if (iceServers.length === 0)
      return json({ error: 'TURN response did not include ICE servers' }, 502, origin);

    return json({ iceServers, ttl }, 200, origin);
  },
};
