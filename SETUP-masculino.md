# NQ-Shoppable → Masculino — setup runbook

Config files already in the repo:

- `fly.masculino.toml`
- `shopify.app.masculino.toml` (client_id is a placeholder — step 3 fills it)
- `.env.masculino` (empty slots — fill as you go)

Secrets live in `.env.masculino` only. Never paste them into this file.

| Value | Status |
|---|---|
| R2_ACCOUNT_ID | step 1 |
| R2_ACCESS_KEY_ID | step 1 |
| R2_SECRET_ACCESS_KEY | step 1 |
| R2_BUCKET_NAME | `nq-shoppable-masculino` (pre-filled) |
| R2_PUBLIC_URL | step 1 |
| DATABASE_URL (pooled) | step 2 |
| DIRECT_URL | step 2 |
| SHOPIFY_API_KEY | step 3 |
| SHOPIFY_API_SECRET | step 3 |
| SHOPIFY_APP_URL | pre-filled |
| SCOPES | pre-filled |

Eleven values. The `IG_*` block at the bottom of `.env.masculino` is commented
out and not needed — see step 8.

---

## 1. Cloudflare R2 — in Masculino's account

1. If R2 has never been used on this account, you'll hit an **Add R2 subscription**
   screen first. $0 due, free tier is 10 GB / 1M writes / 10M reads per month.
   Needs a payment method on file.
2. R2 → **Create bucket** → `nq-shoppable-masculino`, Location **Automatic**
   (resolves to APAC), Storage class **Standard**.
3. The **Account ID** is the 32-hex string in the dashboard URL:
   `dash.cloudflare.com/<account-id>/r2/overview`. It also appears inside the
   **S3 API** endpoint on the bucket's Settings page. It is NOT the `pub-...`
   id from the public URL.
4. Bucket → **Settings** → **Public Development URL** → **Enable** (type `allow`).
   Gives `https://pub-xxxx.r2.dev` → `R2_PUBLIC_URL`, **no trailing slash**.
5. Back to **R2 Object Storage** → **Manage API tokens** → **Create API token**:
   - Name `nq-shoppable-masculino`
   - **Object Read & Write**
   - **Apply to specific buckets only** → `nq-shoppable-masculino`
     (not "all buckets" — that would reach into their other buckets)
   - TTL Forever, no IP filtering (Fly has no stable outbound IPs)
6. Copy **Access Key ID** and **Secret Access Key**. The secret is shown once.
   The `cfat_...` "Token value" is NOT needed — that's Cloudflare's REST API.

### If you use a custom domain instead of r2.dev

The code stores **absolute** URLs in Postgres (`previewUrl = ${R2_PUBLIC_URL}/${key}`),
and `urlToKey()` matches stored URLs against the current `R2_PUBLIC_URL`. Switching
hosts after videos exist orphans the old rows and breaks deletes. Decide before any
content is uploaded. With a custom domain, also add a CORS rule:

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

New project `nq-shoppable-masculino`, region **AWS Asia Pacific (Singapore)** to
match Fly's `sin`.

- **Pooled** connection string (host contains `-pooler`) → `DATABASE_URL`
- **Direct** (untick *Connection pooling*, or just delete `-pooler` from the host)
  → `DIRECT_URL`

Keep `?sslmode=require&channel_binding=require` on both. `DIRECT_URL` is not
optional — `prisma migrate deploy` refuses to run through the pooler.

No migrations to run by hand; `docker-start` handles it on first boot.

## 3. Shopify app — Dev Dashboard

Partner Dashboard → Apps → **Create app** (you'll be handed to Dev Dashboard), or
create it directly in Dev Dashboard. Then fill the **version editor**:

| Field | Value |
|---|---|
| App name | `NQ-Shoppable-Masculino` |
| App URL | `https://nq-shoppable-masculino.fly.dev` |
| Embed app in Shopify admin | checked |
| Preferences URL | blank |
| Webhooks API version | `2026-07` |
| Scopes | `read_products,write_products,write_files` |
| Optional scopes | blank |
| Use legacy install flow | **unchecked** (the app uses `unstable_newEmbeddedAuthStrategy`) |
| Redirect URLs | `https://nq-shoppable-masculino.fly.dev/auth/callback` |
| POS | unchecked |
| App proxy — prefix | `apps` |
| App proxy — subpath | `nq-videos` |
| App proxy — URL | `https://nq-shoppable-masculino.fly.dev` |

**The App URL field defaults to `https://example.com`.** Change it before
releasing or the embedded app won't load. Scroll to the bottom for the App
proxy section — it's easy to miss, and without it the storefront carousel
renders empty with no visible error.

**Release**, then copy **Client ID** and **Secret** from the app's credentials page
into `.env.masculino`, and paste the Client ID over the placeholder `client_id` in
`shopify.app.masculino.toml`.

## 4. Fly — new backend app

```powershell
fly apps create nq-shoppable-masculino
```

Then set the secrets. `fly secrets set` with each pair single-quoted is the
reliable route — the Neon URLs contain `&`, which unquoted PowerShell treats as
a command separator, silently truncating the value at `?sslmode=require`:

```powershell
$secrets = @(
  'R2_ACCOUNT_ID=...'
  'R2_ACCESS_KEY_ID=...'
  'R2_SECRET_ACCESS_KEY=...'
  'R2_BUCKET_NAME=nq-shoppable-masculino'
  'R2_PUBLIC_URL=https://pub-....r2.dev'
  'DATABASE_URL=postgresql://...-pooler.../neondb?sslmode=require&channel_binding=require'
  'DIRECT_URL=postgresql://.../neondb?sslmode=require&channel_binding=require'
  'SHOPIFY_API_KEY=...'
  'SHOPIFY_API_SECRET=...'
  'SHOPIFY_APP_URL=https://nq-shoppable-masculino.fly.dev'
  'SCOPES=read_products,write_products,write_files'
)
fly secrets set -a nq-shoppable-masculino @secrets
```

The array form avoids backtick line-continuations, which break on a trailing
space. Verify 11 names (values are never displayed); "Staged" is expected before
the first deploy:

```powershell
fly secrets list -a nq-shoppable-masculino
fly deploy -c fly.masculino.toml -a nq-shoppable-masculino
```

Always pass `-c` — without it Fly falls back to `fly.toml`, which is claura's.
Passing the wrong `-c` with the right `-a` deploys one client's config to
another client's app.

Watch the boot:

```powershell
fly logs -a nq-shoppable-masculino
```

Expected, in order: `Generated Prisma Client` → `9 migrations found` → the nine
migrations applied → `All migrations have been successfully applied.` →
`[react-router-serve] http://localhost:3000`.

Nine, not four — the count has grown with `add_product_media`,
`add_video_processing_progress`, `add_product_media_position`, `add_product_page`
and `add_instagram_account`. A fresh database applies all of them in one pass.
If you see a different number, stop before step 5.

The deploy prints a **"not listening on the expected address"** warning and the
proxy may log one `instance refused connection` — both are timing artifacts of
migrations running before the server binds. Harmless if the log sequence above
completes.

Fly creates **2 machines** by default. Drop to one unless you want the second:

```powershell
fly status -a nq-shoppable-masculino
fly scale count 1 -a nq-shoppable-masculino
```

At Fly's current rates a second `shared-cpu-4x`/1GB machine is about $8.78/month
doing nothing.

## 5. Point Shopify at the new backend

`application_url`, `[app_proxy] url` and `[auth] redirect_urls` are already set in
`shopify.app.masculino.toml`.

```powershell
shopify app config use masculino
shopify app deploy
```

The CLI auto-detects `.env.masculino` (it matches the config name) and resolves the
Org/App from it. Review the diff before releasing — `access_scopes` and `webhooks`
showing as *updated* is normal. **If `app_proxy` shows as removed, stop.**

Confirm the new version is marked **released** in the Dev Dashboard. `shopify app
deploy` creates a version; a store keeps serving the previous one until the new
one is released.

## 6. Install + add to theme

Dev Dashboard → app → **Distribution** → **Custom distribution** → **Select**.
This is permanent and locks the app to a single store.

Then Overview → **Installs** card → copy icon → custom install link.

**Open an incognito window, sign in to Masculino's admin first, then paste the
link.** The app binds to whatever store the session belongs to, and it can't be
undone — don't do this from a window logged into `testing-dev-store`.

After install: Installs flips to 1, a row lands in the `Session` table, and the
admin shows the embedded app.

Theme: **Online Store → Themes → Customize** → **Add section** → **Apps** group →
**Shoppable Videos** → position → **Save**. It renders empty until step 7.

Two block settings worth setting now:

- **Heading** defaults to "Watch And Buy". Clear it if they don't want a heading.
- **Show On Product Pages** defaults to **Mobile only**, so desktop product
  pages show nothing until you change it. Set it to *Mobile and desktop* if
  they want both.

## 7. Content

Upload videos and attach products in the app admin. Preview clips generate
automatically into Masculino's R2. No backfill — fresh store.

**Tell them the upload size ceiling.** The upload route buffers the whole file
in memory, so on a 1GB machine anything much past ~70MB fails. Reels of 60–90
seconds are well inside it; long-form video is not. Either keep uploads small or
raise `memory` to `"2gb"` in `fly.masculino.toml` (+$6/month).

## 8. Instagram import — not enabled

The Instagram code ships with the app but its entry points are commented out,
so nothing appears in the admin. It stays that way until the Meta app exists.

To enable later: uncomment the nav link in `app/routes/app.tsx` and the button in
`app/routes/app._index.tsx`, add
`https://nq-shoppable-masculino.fly.dev/auth/instagram/callback` to the Meta
app's valid OAuth redirect URIs, fill the `IG_*` block in `.env.masculino`,
re-run the secrets step, and redeploy. Full detail in
`NQ-Shoppable-Instagram-Import.pdf`.

---

### Gotchas (learned on the earlier six deployments)

- R2 Secret Access Key is shown **once**.
- `R2_PUBLIC_URL` must have **no trailing slash**.
- Neon URLs contain `&`; unquoted in bash/PowerShell they truncate at
  `?sslmode=require`. Single-quote every pair.
- `fly secrets list` never shows values, so a truncated URL looks correct there
  and only fails at runtime.
- Always `-c fly.masculino.toml` on deploy.
- `automatically_update_urls_on_dev = true` in the toml means `shopify app dev`
  will silently repoint the live app at a tunnel URL. Consider `false` on client
  configs.
- flyctl's Windows auto-updater can fail with a missing `wintun.dll` and refuse to
  run. Fix: `iwr https://fly.io/install.ps1 -useb | iex`, then a new shell.
- `.env` and `.env.*` are gitignored **and** dockerignored, so none of these files
  are tracked in git or baked into the image. There is no backup — don't delete them.
- Shopify's plan cap is **250 videos and 3D models store-wide**, separate from the
  storage limit. It only applies to the opt-in "push into Shopify's gallery"
  action — normal product-page videos play from R2 and have no cap.
