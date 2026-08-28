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

The original résumé remains at `static/resume.pdf`. The preserved custom domain is stored in both the repository-root `CNAME` and `static/CNAME`; Astro copies the latter to the production build.

## Styling and tools

Tailwind is connected through its Vite plugin. Design tokens, local font faces, document defaults, and Markdown-only article styles live in `src/styles/global.css`; page and component styling uses Tailwind utilities directly in Astro templates.

Future standalone tools can be added under `src/pages/tools/`. Tailwind scans files under `src` automatically, so utilities used by a new tool are included without any extra content configuration.

The first tool is available at `/tools/scrum-poker`. It uses WebRTC data channels through PeerJS: the public PeerJS broker is used for signalling, but room state and votes are exchanged over encrypted WebRTC connections and are never stored by this site. The facilitator's browser owns the live room state, so closing that tab ends the current session.

The default development configuration uses one Google STUN endpoint. Production deployments that need reliable connectivity across restrictive NATs can provide up to three comma-separated relay URLs through `PUBLIC_TURN_URLS`, with `PUBLIC_TURN_USERNAME` and `PUBLIC_TURN_CREDENTIAL` for authentication. Use credentials intended for browser clients, because Astro includes `PUBLIC_` values in the client bundle.

## Deployment

The workflow at `.github/workflows/deploy.yml` builds and deploys the static output on pushes to `master` or `main`, and can also be run manually. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions**.

The site uses the custom domain `brijeshbhakta.com`; keep the existing DNS records and repository Pages domain setting in place.

## Updating professional details

The existing PDF résumé was last updated in 2018 and is presented as an archive. Before publishing a new résumé, replace `static/resume.pdf` and update the archive language on the résumé and work pages. Add a verified LinkedIn URL to the contact page once available.
