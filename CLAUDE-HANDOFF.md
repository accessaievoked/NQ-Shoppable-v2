# nq-shoppable-v2 — context handoff

Paste this into a new chat, or tell Claude to read it. It covers the system, the
decisions behind it, and the traps that cost real time to find.

---

## What this is

A **multi-tenant Shopify app** that puts shoppable video carousels and a
fullscreen TikTok-style reel player on merchant storefronts. Five production
clients run on it.

**Stack:** React Router (Remix-style) + TypeScript · Prisma + PostgreSQL (Neon) ·
Fly.io · Cloudflare R2 · ffmpeg · Shopify theme app extension (Liquid + vanilla
JS + Swiper.js).

---

## Clients and infrastructure

Every client is **fully isolated**: its own Fly app, Neon database, Cloudflare R2
account, and Shopify app. Only the *source code* is shared.

| Client | Fly app | Notes |
|---|---|---|
| claura (claura.in) | `nq-shoppable-v2` | the original; uses the base `fly.toml` / `shopify.app.toml` |
| lovecovera (lovecovera.com) | `nq-shoppable-lovecovera` | `cf0b27.myshopify.com` |
| queuniverse (Que Universe) | `nq-shoppable-queuniverse` | at Shopify's 250-video cap |
| sumannathwani | `nq-shoppable-sumannathwani` | |
| indethnic | `nq-shoppable-indethnic` | |

Per-client configs (`fly.<client>.toml`, `shopify.app.<client>.toml`) live on the
**`store-deploys`** branch, not necessarily on the working branch.

### Deploying

```bash
# Backend (also runs migrations on boot via docker-start)
fly deploy -c fly.<client>.toml -a nq-shoppable-<client>

# Storefront extension — ALWAYS set the config first or you'll deploy to the wrong client
shopify app config use <client>
shopify app deploy
```

**Critical:** code is shared, deploys are per-client. A change only reaches a
client when *that* client is deployed. Nothing propagates automatically.

---

## Key files

| File | Purpose |
|---|---|
| `extensions/shoppable-videos/assets/shoppable-video.js` | storefront carousel + reel modal (~1200 lines) |
| `extensions/shoppable-videos/blocks/video-carousel.liquid` | main theme block + all merchant settings |
| `extensions/shoppable-videos/blocks/nq-floating-video.liquid` | floating video widget |
| `extensions/shoppable-videos/assets/nq-carousel.css` | tile-type layouts |
| `app/routes/api.videos.tsx` | storefront API (via Shopify app proxy `/apps/nq-videos/api/videos`) |
| `app/routes/app._index.tsx` | video library / homepage carousel manager |
| `app/routes/app.videos.new.tsx` | upload screen |
| `app/routes/app.product-media.tsx` | product-page video manager (~1500 lines) |
| `app/shopifyMedia.server.ts` | Shopify native-gallery push (now opt-in only) |
| `app/ffmpeg.server.ts` | compression, thumbnails, preview clips |
| `scripts/backfill-previews.mjs` | generate preview clips for existing videos |
| `scripts/refresh-prices.mjs` | refresh price/compareAtPrice from Shopify |

---

## Architecture decisions (and why)

**1. Preview clips.** Cards play a tiny ~3s silent 480p MP4 (`previews/{key}.mp4`,
30–300 KB); the modal plays the full `compressed/{key}.mp4`. Stored as
`Video.previewUrl`. This exists because loading full reels on every card
saturated Chrome's ~6-connections-per-origin limit and caused stalled/cancelled
requests on 3G/4G.

**2. MP4, not HLS.** Deliberately migrated off HLS to progressive MP4 with
`+faststart`. For short clips, HLS's manifest/segment handshake was slower.
`streamUrl` is `null` everywhere now.

**3. Product-page videos come from OUR database, not Shopify.** This is the big
one. Shopify's theme renders the product media gallery from `product.media`, and
Shopify **will not reference an external URL for video** — it downloads and
hosts its own copy. Hosted videos are capped **per plan, store-wide** (250 on
Basic; 1,000/week upload limit). Que Universe hit that ceiling.

So `ProductMedia` was repurposed from "pushed to Shopify" into a **curation
table** — "the merchant chose this video for this product's page" — with a
`position` column for ordering. The storefront block reads those rows and streams
from R2. No cap, no transcoding wait, instant changes.

**Tradeoff:** videos appear in the app's own section on the product page, *not*
inside the theme's native image carousel beside the price. That's unavoidable
without giving Shopify a hosted copy.

**4. Shopify gallery push is opt-in only** (`push-shopify` intent). It used to
run automatically on upload *and* on page load, which is what exhausted Que's 250
slots.

---

## Environment traps (these cost hours)

**⚠️ The repo lives in OneDrive.** Edits silently reverted **multiple times**
during a session — whole features vanished and reappeared. Strongly consider
moving the repo out of OneDrive (e.g. `C:\Users\asadb\Github\`). If something
you just wrote is missing, this is why. **Commit often.**

**CRLF line endings.** In Claude's Linux sandbox, `git status` shows *every* file
as modified. Use `git diff --ignore-all-space --stat` to see real changes.

**The Prisma client in `node_modules` is stale** and can't be regenerated inside
Claude's sandbox (engine download returns 403). So `npx tsc --noEmit` reports a
flood of false errors — `previewUrl`, `processingProgress`, `processingError`,
`productMedia`, `productPage` "do not exist". **These are not real.** Filter them
out; real type errors are anything else. The client regenerates correctly at
deploy time (`docker-start` → `prisma generate && prisma migrate deploy`).

**Migration ordering.** `20260620090000_add_video_products` sorts *before*
`20260620160612_init`, so on a fresh database it tried to ALTER a table that
didn't exist (`P3009`). Fixed by guarding it with `ALTER TABLE IF EXISTS … ADD
COLUMN IF NOT EXISTS` and adding `20260801000000_ensure_video_products` after
init. **Any new migration must sort after the existing ones and should be
idempotent.**

**PowerShell, not bash.** Multi-line commands with trailing `\` fail. Give
single-line commands, and quote every `NAME=VALUE` (the `&` in Postgres URLs and
commas in `SCOPES` break otherwise).

---

## Known issues, not yet fixed

1. **Floating-video mobile fixes were lost in a rollback** and need re-applying to
   `nq-floating-video.liquid`: (a) `preload="none"` → `"metadata"`, (b) a
   `tryPlay()` retry on `canplay`/`loadeddata`, (c) an `isStickyOrFixed()` check
   so a sticky mobile Add-to-Cart bar doesn't prevent the widget ever showing.
2. **`shopifyMedia.server.ts` buffers an entire video in RAM twice** (`arrayBuffer`
   then `new Blob`). OOM risk on a 1 GB machine that already OOM-kills ffmpeg.
3. **In-memory throttles are per-machine.** Fly runs multiple machines, so
   `lastBackfillRun` doesn't actually throttle globally.
4. **`Video.duration` is never persisted** — `probeDuration()` runs but its value
   isn't saved, so the 10-minute guard in `pushVideoToProduct` is dead code.
5. **Arrange button** is disabled on `galleryCount === 0`, which counts *Shopify*
   media — so it can stay greyed out even when the product has curated videos.
6. **Prices are snapshots, not live.** Run `scripts/refresh-prices.mjs` after a
   client changes pricing (dry-run with `--dry` first).
7. **Orphan audit script** (find unreferenced Shopify video files to reclaim plan
   slots) was discussed but never written. Relevant for Que Universe.

---

## Recent work (most recent first)

- Product-page manager rebuilt: add a product from the catalogue (new
  `ProductPage` table so empty rows persist), "Manage videos" modal with upload
  (opens the upload screen pre-filled, returns after), add-from-library, and
  Arrange reordering *our* rows via `position`. Buttons renamed to **Manage
  homepage** / **Manage product page**.
- Fixed the Shopify template's public landing page appearing inside the embedded
  admin (`app/routes/_index/route.tsx` now redirects on any embedded signal and
  recovers `shop` from `host`).
- Theme settings added for card title/price **font, size, colour**, and discount
  **style/colour/font/size/weight/uppercase** plus struck-through price styling.
- Fixed `compareAtPrice` never being saved on upload (it was queried from Shopify
  then discarded), so discounts could never render.
- View-count emoji replaced with an inline SVG eye icon.

**Always verify what's actually committed before trusting this list** — see the
OneDrive warning above.

---

## How to work on this

- **Ask before big changes.** The owner prefers a summary of the plan first, and
  isolated commits that are easy to revert.
- **Default settings must preserve existing behaviour** — any new theme setting
  should leave all five clients rendering identically until a merchant opts in.
- **Shared code, per-client deploys.** Say explicitly which clients a change will
  reach and when.
- Be honest about what can't be verified in the sandbox (no DB access, stale
  Prisma client, no live storefront).
