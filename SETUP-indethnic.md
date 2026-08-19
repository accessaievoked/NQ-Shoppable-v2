# NQ-Shoppable → Indethnic — setup runbook

Config files already in the repo:

- `fly.indethnic.toml`
- `shopify.app.indethnic.toml` (client_id is a placeholder — step 3 fills it)
- `.env.indethnic` (empty slots — fill as you go)

Secrets live in `.env.indethnic` only. Never paste them into this file.

| Value | Status |
|---|---|
| R2_ACCOUNT_ID | step 1 |
| R2_ACCESS_KEY_ID | step 1 |
| R2_SECRET_ACCESS_KEY | step 1 |
| R2_BUCKET_NAME | `nq-shoppable-indethnic` |
| R2_PUBLIC_URL | step 1 |
| DATABASE_URL (pooled) | step 2 |
| DIRECT_URL | step 2 |
| SHOPIFY_API_KEY | step 3 |
| SHOPIFY_API_SECRET | step 3 |

---

## 1. Cloudflare R2 — in Indethnic's account

1. If R2 has never been used on this account, you'll hit an **Add R2 subscription**
   screen first. $0 due, free tier is 10 GB / 1M writes / 10M reads per month.
   Needs a payment method on file.
2. R2 → **Create bucket** → `nq-shoppable-indethnic`, Location **Automatic**
   (resolves to APAC), Storage class **Standard**.
3. Bucket → **Settings** → the **Account ID** is the hex string inside the
   **S3 API** URL shown in the General panel.
4. Same Settings page → **Public Development URL** → **Enable** (type `allow`).
   Gives `https://pub-xxxx.r2.dev` → `R2_PUBLIC_URL`, **no trailing slash**.
5. Back to **R2 Object Storage** → **Manage API tokens** → **Create API token**:
   - Name `nq-shoppable-indethnic`
   - **Object Read & Write**
   - **Apply to specific buckets only** → `nq-shoppable-indethnic`
     (not "all buckets" — that would reach into her other buckets)
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

New project `nq-shoppable-indethnic`, region **AWS Asia Pacific (Singapore)** to
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
| App name | `NQ-Shoppable-Indethnic` |
| App URL | `https://nq-shoppable-indethnic.fly.dev` |
| Embed app in Shopify admin | checked |
| Preferences URL | blank |
| Webhooks API version | `2026-07` |
| Scopes | `read_products,write_products,write_files` |
| Optional scopes | blank |
| Use legacy install flow | **unchecked** (the app uses `unstable_newEmbeddedAuthStrategy`) |
| Redirect URLs | `https://nq-shoppable-indethnic.fly.dev/auth/callback` |
| POS | unchecked |
| App proxy — prefix | `apps` |
| App proxy — subpath | `nq-videos` |
| App proxy — URL | `https://nq-shoppable-indethnic.fly.dev` |

**Release**, then copy **Client ID** and **Secret** from the app's credentials page
into `.env.indethnic`, and paste the Client ID over the placeholder `client_id` in
`shopify.app.indethnic.toml`.

## 4. Fly — new backend app

```powershell
fly apps create nq-shoppable-indethnic
```

Import the secrets straight from the env file — avoids the `&` quoting problem in
the Neon URLs entirely:

```powershell
Get-Content .env.indethnic | Where-Object { $_ -match '^[A-Z0-9_]+=' } | fly secrets import -a nq-shoppable-indethnic
```

Verify 11 names (values are never displayed). "Staged" is expected before the
first deploy:

```powershell
fly secrets list -a nq-shoppable-indethnic
fly deploy -c fly.indethnic.toml -a nq-shoppable-indethnic
```

Always pass `-c` — without it Fly falls back to `fly.toml`, which is claura's.

Watch the boot:

```powershell
fly logs -a nq-shoppable-indethnic
```

Expected, in order: `Generated Prisma Client` → `4 migrations found` → the four
migrations applied → `All migrations have been successfully applied.` →
`[react-router-serve] http://localhost:3000`.

The deploy prints a **"not listening on the expected address"** warning and the
proxy may log one `instance refused connection` — both are timing artifacts of
migrations running before the server binds. Harmless if the log sequence above
completes.

Fly creates **2 machines** by default. `fly scale count 1 -a nq-shoppable-indethnic`
if you want to match a single-machine setup.

## 5. Point Shopify at the new backend

`application_url`, `[app_proxy] url` and `[auth] redirect_urls` are already set in
`shopify.app.indethnic.toml`.

```powershell
shopify app config use indethnic
shopify app deploy
```

The CLI auto-detects `.env.indethnic` (it matches the config name) and resolves the
Org/App from it. Review the diff before releasing — `access_scopes` and `webhooks`
showing as *updated* is normal. **If `app_proxy` shows as removed, stop.**

## 6. Install + add to theme

Dev Dashboard → app → **Distribution** → **Custom distribution** → **Select**.
This is permanent and locks the app to a single store.

Then Overview → **Installs** card → copy icon → custom install link.

**Open an incognito window, sign in to Indethnic's admin first, then paste the
link.** The app binds to whatever store the session belongs to, and it can't be
undone — don't do this from a window logged into `testing-dev-store`.

After install: Installs flips to 1, a row lands in the `Session` table, and her
admin shows the embedded app.

Theme: **Online Store → Themes → Customize** → **Add section** → **Apps** group →
**Shoppable Videos** → position → **Save**. It renders empty until step 7.

## 7. Content

Upload videos and attach products in the app admin. Preview clips generate
automatically into Indethnic's R2. No backfill — fresh store.

---

### Gotchas (learned on lovecovera + sumannathwani)

- R2 Secret Access Key is shown **once**.
- `R2_PUBLIC_URL` must have **no trailing slash**.
- Neon URLs contain `&`; unquoted in bash/PowerShell they truncate at
  `?sslmode=require`. Use `fly secrets import` and sidestep it.
- Always `-c fly.indethnic.toml` on deploy.
- `automatically_update_urls_on_dev = true` in the toml means `shopify app dev`
  will silently repoint the live app at a tunnel URL. Consider `false` on client
  configs.
- flyctl's Windows auto-updater can fail with a missing `wintun.dll` and refuse to
  run. Fix: `iwr https://fly.io/install.ps1 -useb | iex`, then a new shell.
- `.env` and `.env.*` are gitignored **and** dockerignored, so none of these files
  are tracked in git or baked into the image. There is no backup — don't delete them.
