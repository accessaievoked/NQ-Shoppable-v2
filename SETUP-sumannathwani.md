# NQ-Shoppable → Suman Nathwani — setup runbook

Config files already created in the repo:
- `fly.sumannathwani.toml`
- `shopify.app.sumannathwani.toml` (client_id is a placeholder — step 3 fills it)

Actual values live in **`.env.sumannathwani`** (gitignored). Don't paste secrets into this file.

Progress:

| Value | Status |
|---|---|
| R2_ACCOUNT_ID | done |
| R2_ACCESS_KEY_ID | done |
| R2_SECRET_ACCESS_KEY | done |
| R2_BUCKET_NAME | done — `nq-shoppable-sumannathwani` |
| R2_PUBLIC_URL | done — r2.dev public dev URL |
| DATABASE_URL (pooled) | done — Neon, ap-southeast-1 |
| DIRECT_URL | done — same host minus `-pooler` |
| SHOPIFY_API_KEY | done — app created in Dev Dashboard |
| SHOPIFY_API_SECRET | done |

Steps 1–3 complete. Remaining: **step 4 (Fly)** onward.

> **Quoting:** the Neon URLs contain `&`. In bash and PowerShell an unquoted `&`
> truncates the value at `?sslmode=require`. Wrap every `KEY=value` in quotes
> when running `fly secrets set`, or Prisma will fail at boot.

---

## 1. Cloudflare R2 — in Suman Nathwani's account

1. R2 → **Create bucket** → `nq-shoppable-sumannathwani` (region: APAC to match `sin`).
2. R2 → **Manage R2 API Tokens** → Create API token, permission **Object Read & Write**, scoped to that bucket. Save **Account ID**, **Access Key ID**, **Secret Access Key** — the secret is shown once.
3. Bucket → **Settings → Public access**:
   - Quick: enable **r2.dev subdomain** → `R2_PUBLIC_URL = https://pub-xxxx.r2.dev`
   - Or custom domain (e.g. `cdn.<store-domain>`) → `R2_PUBLIC_URL = https://cdn.<store-domain>`
4. **If using a custom domain**, add a CORS rule on the bucket:

```json
[
  {
    "AllowedOrigins": ["https://<store-domain>", "https://<shop>.myshopify.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

## 2. Neon — new database

New Neon project (name it `nq-shoppable-sumannathwani`, region closest to `sin`). From the dashboard grab:
- **Pooled** connection string → `DATABASE_URL`
- **Direct** connection string → `DIRECT_URL`

No migrations to run by hand — `docker-start` runs `prisma migrate deploy` on first boot.

## 3. Shopify Partner Dashboard — new app entry

From the repo root:

```bash
shopify app config link
```

Choose **Create a new app**, name it `NQ-Shoppable-Suman Nathwani`, and when asked for the config name enter `sumannathwani` so it writes to `shopify.app.sumannathwani.toml`.

If the CLI overwrites the file, re-apply these (or just copy the `client_id` it generated into the existing file):

```toml
application_url = "https://nq-shoppable-sumannathwani.fly.dev"
[access_scopes]
scopes = "read_products,write_products,write_files"
[app_proxy]
url = "https://nq-shoppable-sumannathwani.fly.dev"
subpath = "nq-videos"
prefix = "apps"
[auth]
redirect_urls = [ "https://nq-shoppable-sumannathwani.fly.dev/auth/callback" ]
```

Then copy the **Client ID / Client secret** from the app's Partner Dashboard page → `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`.

## 4. Fly — new backend app

```bash
fly apps create nq-shoppable-sumannathwani
```

Set secrets (one command, values from the table above):

```bash
fly secrets set -a nq-shoppable-sumannathwani \
  SHOPIFY_API_KEY=... \
  SHOPIFY_API_SECRET=... \
  SHOPIFY_APP_URL=https://nq-shoppable-sumannathwani.fly.dev \
  SCOPES=read_products,write_products,write_files \
  DATABASE_URL=... \
  DIRECT_URL=... \
  R2_ACCOUNT_ID=... \
  R2_ACCESS_KEY_ID=... \
  R2_SECRET_ACCESS_KEY=... \
  R2_BUCKET_NAME=nq-shoppable-sumannathwani \
  R2_PUBLIC_URL=...
```

Deploy:

```bash
fly deploy -c fly.sumannathwani.toml -a nq-shoppable-sumannathwani
```

`docker-start` runs `prisma migrate deploy`, so the schema (including `previewUrl`) is created in the fresh Neon DB automatically.

Sanity check:

```bash
fly logs -a nq-shoppable-sumannathwani
curl -I https://nq-shoppable-sumannathwani.fly.dev
```

## 5. Point Shopify at the new backend

```bash
shopify app config use sumannathwani
shopify app deploy
```

Pushes the theme extension + config to the new app. App-proxy subpath `apps/nq-videos` stays the same — it's scoped per app/store.

## 6. Install + add to theme

1. Partner Dashboard → the new app → **Test on development store / Select store** → install on Suman Nathwani's store.
2. Store admin → **Online Store → Themes → Customize** → add the **"Shoppable Videos"** section where it should appear → Save.

## 7. Content

Upload videos and attach products in the app admin. New uploads auto-generate preview clips straight into Suman Nathwani's R2 — no backfill needed on a fresh store.

---

### Gotchas from the lovecovera run
- Secret Access Key is shown **once** in Cloudflare — copy it before closing.
- `R2_PUBLIC_URL` must have **no trailing slash**.
- If `shopify app config link` rewrites the toml, re-add `[app_proxy]` — the CLI doesn't carry it over.
- Always pass `-c fly.sumannathwani.toml` on deploy, or Fly picks up the default `fly.toml` (claura's app).
