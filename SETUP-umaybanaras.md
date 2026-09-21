# NQ-Shoppable → Umay Banaras — setup runbook

Config files already in the repo:

- `fly.umaybanaras.toml`
- `shopify.app.umaybanaras.toml` (client_id is a placeholder — step 3 fills it)
- `.env.umaybanaras` (empty slots — fill as you go)

Secrets live in `.env.umaybanaras` only. Never paste them into this file.

| Value | Status |
|---|---|
| R2_ACCOUNT_ID | step 1 |
| R2_ACCESS_KEY_ID | step 1 |
| R2_SECRET_ACCESS_KEY | step 1 |
| R2_BUCKET_NAME | `nq-shoppable-umaybanaras` |
| R2_PUBLIC_URL | step 1 |
| DATABASE_URL (pooled) | step 2 |
| DIRECT_URL | step 2 |
| SHOPIFY_API_KEY | step 3 |
| SHOPIFY_API_SECRET | step 3 |

---

## 1. Cloudflare R2 — in Umay Banaras's account

1. If R2 has never been used on the account, you'll hit an **Add R2 subscription**
   screen first. $0 due; free tier is 10 GB / 1M writes / 10M reads per month.
   Needs a payment method on file.
2. R2 → **Create bucket** → `nq-shoppable-umaybanaras`, Location **Automatic**
   (resolves to APAC), Storage class **Standard**. Bucket names are permanent.
3. Bucket → **Settings** → the **Account ID** is the hex string inside the
   **S3 API** URL shown in the General panel.
4. Same Settings page → **Public Development URL** → **Enable** (type `allow`).
   Gives `https://pub-xxxx.r2.dev` → `R2_PUBLIC_URL`, **no trailing slash**.
5. Back to **R2 Object Storage** → **Manage API tokens** → **Create API token**:
   - Name `nq-shoppable-umaybanaras`
   - **Object Read & Write**
   - **Apply to specific buckets only** → this bucket
     (not "all buckets" — that reaches into anything else in her account)
   - TTL Forever, no IP filtering (Fly has no stable outbound IPs)
6. Copy **Access Key ID** and **Secret Access Key**. The secret is shown once.
   The `cfat_...` "Token value" is NOT needed — that's Cloudflare's REST API.

Decide r2.dev vs a custom domain **before** any video is uploaded: the code
stores absolute URLs in Postgres, so changing hosts later orphans every row and
breaks deletes.

## 2. Neon — new database

New project `nq-shoppable-umaybanaras`, region **AWS Asia Pacific (Singapore)**
to match Fly's `sin`.

- **Pooled** string (host contains `-pooler`) → `DATABASE_URL`
- **Direct** (untick *Connection pooling*, or delete `-pooler` from the host)
  → `DIRECT_URL`

Keep `?sslmode=require&channel_binding=require` on both. `DIRECT_URL` is not
optional — `prisma migrate deploy` refuses to run through the pooler, and the
container fails at boot without it.

## 3. Shopify app — Dev Dashboard

Partner Dashboard → Apps → **Create app** (you'll be handed to Dev Dashboard).
Do **not** use the store admin's *Develop apps* page — those are Admin-API-only
apps with no OAuth, app proxy or theme extension.

| Field | Value |
|---|---|
| App name | `NQ-Shoppable-Umay Banaras` |
| App URL | `https://nq-shoppable-umaybanaras.fly.dev` |
| Embed app in Shopify admin | checked |
| Preferences URL | blank |
| Webhooks API version | `2026-07` |
| Scopes | `read_products,write_products,write_files` |
| Optional scopes | blank |
| Use legacy install flow | **unchecked** (app uses `unstable_newEmbeddedAuthStrategy`) |
| Redirect URLs | `https://nq-shoppable-umaybanaras.fly.dev/auth/callback` |
| POS | unchecked |
| App proxy — prefix | `apps` |
| App proxy — subpath | `nq-videos` |
| App proxy — URL | `https://nq-shoppable-umaybanaras.fly.dev` |

**Release**, then copy **Client ID** and **Secret** into `.env.umaybanaras`, and
paste the Client ID over the placeholder in `shopify.app.umaybanaras.toml`.

The App URL 404s until step 4 — expected, Shopify doesn't verify it.

## 4. Fly — new backend app

```powershell
flyctl apps create nq-shoppable-umaybanaras
```

Import secrets from the env file — avoids the `&` quoting problem in the Neon
URLs entirely (unquoted, PowerShell truncates them at `?sslmode=require`):

```powershell
Get-Content .env.umaybanaras | Where-Object { $_ -match '^[A-Z0-9_]+=' } | flyctl secrets import -a nq-shoppable-umaybanaras
flyctl secrets list -a nq-shoppable-umaybanaras
flyctl deploy -c fly.umaybanaras.toml -a nq-shoppable-umaybanaras
flyctl logs -a nq-shoppable-umaybanaras
```

Expect 11 secrets, shown as **Staged** before the first deploy. Always pass
`-c` — without it Fly falls back to `fly.toml`, which is claura's.

Healthy boot, in order: `Generated Prisma Client` → `N migrations found` → all
applied → `[react-router-serve] http://localhost:3000`. The deploy's "not
listening on the expected address" warning and a single `instance refused
connection` are timing artifacts of migrations running before the server binds.

## 5. Point Shopify at the new backend

```powershell
shopify app config use umaybanaras
shopify app deploy
```

The CLI auto-detects `.env.umaybanaras` (filename matches the config name) and
resolves the Org/App from it — check it names **NQ-Shoppable-Umay Banaras**
before releasing. `access_scopes` and `webhooks` showing as *updated* is normal.
**If `app_proxy` shows as removed, stop.**

## 6. Install + add to theme

Dev Dashboard → app → **Distribution** → **Custom distribution** → **Select**.
Permanent and single-store.

Then Overview → **Installs** card → copy icon → custom install link.

**Open an incognito window, sign in to Umay Banaras's admin first, then paste
the link.** The app binds to whatever store that session belongs to and it
cannot be undone — don't do this from a window logged into a dev store.

Theme: **Online Store → Themes → Customize** → **Add section** → **Apps** group
→ **Shoppable Videos** → position → **Save**. Renders empty until step 7.

## 7. Content

Upload videos and attach products in the app admin. Videos tagged to a product
are pushed to that product's Shopify media gallery automatically; the rest is
manual via **Product pages → Manage media**.

---

### Gotchas (learned across lovecovera, sumannathwani, indethnic, queuniverse)

- **R2:** secret shown once; `R2_PUBLIC_URL` must have no trailing slash; scope
  the token to one bucket.
- **Neon:** pooled and direct differ only by `-pooler`; `DIRECT_URL` is required.
- **Quoting:** Neon URLs contain `&`. Use `flyctl secrets import`, not a typed
  `secrets set`.
- **Always `-c fly.umaybanaras.toml`** on deploy.
- **Memory matters.** 512MB gets ffmpeg OOM-killed on 1080x1920 phone video —
  the config is 1GB for that reason. Videos stuck on "Processing..." with
  `Killed process (ffmpeg)` in the logs is this, and there's now a **Retry
  processing** button on the card.
- **Shopify plan video cap.** Basic allows **250 videos + 3D models store-wide**.
  Pushing videos into the product gallery consumes them. Check
  **Content → Files** (filter: Video) before promising the feature — a store
  migrating off another shoppable-video app often has hundreds of its leftovers.
- **Video upload to Shopify needs a staged upload**, not `fileCreate` from a
  URL. That path works for images only; video returns "Invalid video url".
- **flyctl on Windows** can break its own install mid-update (missing
  `wintun.dll`). Fix: `iwr https://fly.io/install.ps1 -useb | iex`, new shell.
- **`.env` and `.env.*` are gitignored and dockerignored.** Nothing is on
  GitHub and nothing is baked into the image — there is no backup, so don't
  delete a client's config files.
