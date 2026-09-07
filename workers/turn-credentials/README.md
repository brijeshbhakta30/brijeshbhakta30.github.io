# Scrum Poker TURN Credentials Worker

This Worker issues short-lived Cloudflare Realtime TURN credentials for the browser.

Configure secrets separately:

```sh
wrangler secret put TURN_KEY_ID
wrangler secret put TURN_KEY_API_TOKEN
```

Set `PUBLIC_TURN_CREDENTIALS_URL` in the Astro frontend to the deployed Worker endpoint, for example:

```sh
PUBLIC_TURN_CREDENTIALS_URL=https://scrum-poker-turn-credentials.<account>.workers.dev/credentials
```

The Worker validates `Origin` against `ALLOWED_ORIGINS` in `wrangler.toml` and returns only temporary `iceServers`.

## Local Development

From the repo root:

```sh
pnpm install
pnpm --filter scrum-poker-turn-credentials dev
```

Or from this Worker directory:

```sh
pnpm install
pnpm dev
```

The default local URL is usually:

```text
http://localhost:8787/credentials
```

For local runs, create `workers/turn-credentials/.dev.vars`:

```sh
TURN_KEY_ID=your_cloudflare_turn_key_id
TURN_KEY_API_TOKEN=your_cloudflare_turn_key_api_token
```

Because the Worker requires an allowed `Origin`, test it with one of the origins in `wrangler.toml`:

```sh
curl -i \
  -H "Origin: https://brijeshbhakta.com" \
  http://localhost:8787/credentials
```

For local browser testing, add your Astro dev origin to `ALLOWED_ORIGINS`, for example:

```toml
ALLOWED_ORIGINS = "https://brijeshbhakta.com,https://brijeshbhakta30.github.io,http://localhost:4321"
```

Then point the Astro app at the Worker:

```sh
PUBLIC_TURN_CREDENTIALS_URL=http://localhost:8787/credentials pnpm dev
```
