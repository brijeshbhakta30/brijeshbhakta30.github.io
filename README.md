# brijeshbhakta.com

[![Deploy site](https://github.com/brijeshbhakta30/brijeshbhakta30.github.io/actions/workflows/deploy.yml/badge.svg)](https://github.com/brijeshbhakta30/brijeshbhakta30.github.io/actions/workflows/deploy.yml)
[![Deploy TURN Worker](https://github.com/brijeshbhakta30/brijeshbhakta30.github.io/actions/workflows/deploy-turn.yml/badge.svg)](https://github.com/brijeshbhakta30/brijeshbhakta30.github.io/actions/workflows/deploy-turn.yml)

Brijesh Bhakta's static portfolio, writing site, and collection of browser-based tools, built with [Astro](https://astro.build/), styled with [Tailwind CSS](https://tailwindcss.com/), and deployed to GitHub Pages.

## Requirements

- Node.js 24 or newer
- pnpm 11 or newer

## Local development

```sh
pnpm install
pnpm dev
```

Astro serves the site at `http://localhost:4321` by default.

Copy `.env.example` to `.env` if you need to override the default networking configuration used by Scrum Poker.

## Quality checks

```sh
pnpm check
```

This runs Astro's TypeScript and content validation.

## Production build

```sh
pnpm build
```

The static site is written to `dist/`. The build also creates the XML sitemap.

## Preview the production build

```sh
pnpm preview
```

## Content

Markdown articles live in `src/content/writing/` and are loaded as Astro's typed `writing` content collection. Each post defines its canonical URL, category, and tags in frontmatter. The former `/getting-started-with-es6` address redirects to `/javascript/getting-started-with-es6`.

The original resume remains at `static/resume.pdf`. The preserved custom domain is stored in both the repository-root `CNAME` and `static/CNAME`; Astro copies the latter to the production build.

## Styling and tools

Tailwind is connected through its Vite plugin. Design tokens, local font faces, document defaults, and Markdown-only article styles live in `src/styles/global.css`; page and component styling uses Tailwind utilities directly in Astro templates.

Standalone tools live under `src/pages/tools/`. Tailwind scans files under `src` automatically, so utilities used by a new tool are included without any extra content configuration.

### Scrum Poker

Available at `/tools/scrum-poker`.

Scrum Poker is a real-time estimation tool built around PeerJS and encrypted WebRTC data channels. The public PeerJS broker is used for signalling, while room state is exchanged directly between participants and is not stored by this site.

Participants form a resilient peer-to-peer topology rather than relying on an authoritative room host. Hidden estimates remain in the voter's browser until Reveal.

Detailed diagrams covering the module structure, room lifecycle, voting flow, network topology, and recovery behaviour are available in [`docs/scrumPoker/README.md`](docs/scrumPoker/README.md).

#### Scrum Poker networking configuration

The default development configuration uses both Cloudflare and Google STUN servers:

```env
PUBLIC_STUN_URLS=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302
```

Production deployments that need TURN relay support can provide a credentials endpoint:

```env
PUBLIC_TURN_CREDENTIALS_URL=
```

This is the preferred option for dynamically obtaining Cloudflare TURN credentials.

Static TURN credentials are also supported:

```env
PUBLIC_TURN_URLS=
PUBLIC_TURN_USERNAME=
PUBLIC_TURN_CREDENTIAL=
```

Static credentials are included in the browser bundle, so they should only be used when appropriate for browser clients. Prefer short-lived credentials for production deployments.

The ICE transport policy defaults to:

```env
PUBLIC_ICE_TRANSPORT_POLICY=all
```

Set it to `relay` only when explicitly testing TURN relay behaviour.

Scrum Poker debugging is disabled by default:

```env
PUBLIC_SCRUM_POKER_DEBUG=false
```

Do not enable debug mode in a normal public production build.

Pretty room URLs are dynamic while the site itself is statically hosted. Astro middleware rewrites them during development; on GitHub Pages, the custom `404.html` redirects valid `/tools/scrum-poker/:roomCode` paths to the static Scrum Poker entry point. The client then restores the canonical uppercase room URL without reloading.

### Wheel of Names

Available at `/tools/wheel-of-names`.

Wheel of Names is a private, browser-based random picker for names or other choices. Entries stay in the browser and can be shuffled or sorted before spinning.

The tool also supports automatically removing winners, making it useful when everyone in a list should be selected once.

## Deployment

### Website

The workflow at `.github/workflows/deploy.yml` builds and deploys the Astro static output to GitHub Pages on pushes to `master` or `main`, and can also be run manually.

The workflow excludes changes that only affect the TURN Worker and passes the repository variable `PUBLIC_TURN_CREDENTIALS_URL` into the production Astro build.

In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.

### TURN credentials Worker

The workflow at `.github/workflows/deploy-turn.yml` deploys the Scrum Poker TURN credentials Worker.

It runs when changes are pushed to:

- `workers/turn-credentials/**`
- `.github/workflows/deploy-turn.yml`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`

It can also be run manually through GitHub Actions.

The workflow requires these repository secrets:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
```

The Worker is deployed with:

```sh
pnpm --filter scrum-poker-turn-credentials run deploy
```

Once deployed, configure the Worker's public credentials endpoint as the `PUBLIC_TURN_CREDENTIALS_URL` repository variable used by the website deployment.

The site uses the custom domain `brijeshbhakta.com`; keep the existing DNS records and repository Pages domain setting in place.
