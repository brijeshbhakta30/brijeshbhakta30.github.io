# brijeshbhakta.com

Brijesh Bhakta's static portfolio and writing site, built with [Astro](https://astro.build/), styled with [Tailwind CSS](https://tailwindcss.com/), and deployed to GitHub Pages.

## Requirements

- Node.js 24 or newer
- pnpm 11 or newer

## Local development

```sh
pnpm install
pnpm dev
```

Astro serves the site at `http://localhost:4321` by default.

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

Future standalone tools can be added under `src/pages/tools/`. Tailwind scans files under `src` automatically, so utilities used by a new tool are included without any extra content configuration.

The first tool is available at `/tools/scrum-poker`. It uses WebRTC data channels through PeerJS: the public PeerJS broker is used for signalling, but room actions, presence, and revealed votes are exchanged over encrypted WebRTC connections and are never stored by this site. Participants form a resilient mesh, room actions converge through deterministic operation clocks, and the replaceable discovery peer is not an authoritative host. Hidden estimates remain in the voter's browser until Reveal.

The default development configuration uses one Google STUN endpoint. Override it with comma-separated `PUBLIC_STUN_URLS`. Production deployments that need reliable connectivity across restrictive NATs can provide comma-separated relay URLs through `PUBLIC_TURN_URLS`, with `PUBLIC_TURN_USERNAME` and `PUBLIC_TURN_CREDENTIAL` for authentication. Set `PUBLIC_ICE_TRANSPORT_POLICY=relay` only when testing forced TURN relay, and set `PUBLIC_SCRUM_POKER_DEBUG=true` only for an explicitly internal/debug build. All `PUBLIC_` values are included in the browser bundle, so use short-lived TURN credentials intended for browser clients and never server-side secrets.

Pretty room URLs are dynamic while this site is statically hosted. Astro middleware rewrites them in development; GitHub Pages serves the custom `404.html`, which immediately redirects a valid `/tools/scrum-poker/:roomCode` path to the static tool entry point. The client then restores the canonical uppercase pretty URL without reloading.

## Deployment

The workflow at `.github/workflows/deploy.yml` builds and deploys the static output on pushes to `master` or `main`, and can also be run manually. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.

The site uses the custom domain `brijeshbhakta.com`; keep the existing DNS records and repository Pages domain setting in place.

## Updating professional details

The existing PDF resume was last updated in 2018 and is presented as an archive. Before publishing a new resume, replace `static/resume.pdf` and update the archive language on the resume and work pages. Add a verified LinkedIn URL to the contact page once available.
