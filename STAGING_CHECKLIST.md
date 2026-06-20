# Staging & Client Handoff Checklist

Goal: prove the app is production-ready on Neon Postgres **before** installing on the
client's live store. Work through this on a free Shopify **development store** first,
then do the client install as a low-risk pilot.

---

## 0. Prerequisites

- [ ] App deployed to Fly and booting cleanly (`flyctl logs` shows
      `Datasource "db": PostgreSQL database "neondb"` and `react-router-serve http://localhost:3000`,
      with **no** `P1012` / "URL must start with file:" error).
- [ ] `DATABASE_URL` (pooled) and `DIRECT_URL` (direct) set as Fly secrets.
- [ ] Neon password rotated after being shared in chat; `.env` + Fly secrets updated.
- [ ] A free Shopify **development store** created to use as staging.

---

## 1. Functional smoke test (staging dev store)

- [ ] Install the app on the staging store via the custom-distribution link.
- [ ] App admin loads inside Shopify admin with no console/network errors.
- [ ] Upload a video and link it to a product → succeeds, video appears in the list.
- [ ] FFmpeg pipeline works: thumbnail generated, compressed MP4 in R2, row in Neon `Video`.
- [ ] Add the "Shoppable Videos" theme app block to the storefront theme.
- [ ] Storefront carousel renders, video plays, "Add to cart" works.
- [ ] `GET /api/videos?shop=<store>.myshopify.com` returns the uploaded video(s).
- [ ] A storefront view + add-to-cart increments `viewCount` / `atcCount` and writes
      rows to `AnalyticsEvent` in Neon (check Neon → Tables).
- [ ] Analytics page in the app shows the counts.
- [ ] Delete a video → row removed from Neon AND assets removed from R2.

---

## 2. Failure-mode verification (the reasons we left SQLite)

- [ ] **Data survives a deploy.** Note current video/analytics counts, run
      `flyctl deploy`, confirm the data is still there afterward. (This was the #1
      SQLite bug — must pass on Neon.)
- [ ] **Data survives a machine restart.** `flyctl machine restart <id>`, confirm
      data intact and app comes back up.
- [ ] **Connection pooling holds under load.** Run the load test (section 3) and
      confirm **no** `P2024`/"too many connections"/5xx errors. (This is why we use
      the `-pooler` connection string.)
- [ ] **Backups exist.** Confirm Neon point-in-time restore is available
      (Neon → Backup & Restore). SQLite had none.
- [ ] **Scale-to-zero wakes correctly.** Let the Neon compute go idle, then hit
      `/api/videos` — first request may be slightly slow (cold start) but must succeed.

---

## 3. Load test

Use the included script (`scripts/loadtest.mjs`). Run from the `nq-shoppable-v2` folder.

Read load (simulates storefront traffic):

```powershell
node scripts/loadtest.mjs --base https://nq-shoppable-v2.fly.dev --shop your-store.myshopify.com --concurrency 50 --duration 30
```

Mixed read + write (pass a real video id from Neon to also exercise ATC writes):

```powershell
node scripts/loadtest.mjs --base https://nq-shoppable-v2.fly.dev --shop your-store.myshopify.com --videoId <id> --writeRatio 0.2 --concurrency 50 --duration 30
```

Pass criteria:

- [ ] Success rate ~100% (no 5xx, no network errors in the report).
- [ ] No `too many connections` errors in `flyctl logs` during the run.
- [ ] p95 latency reasonable (reads should be well under ~500 ms warm).
- [ ] Neon compute stayed within free CU-hours (check Neon dashboard after).

Tip: start at `--concurrency 25`, then push to 50/100 to find the ceiling. Your
`fly.toml` caps connections at `hard_limit = 25` per machine, so beyond that Fly
will queue or auto-start a second machine — watch how it behaves.

---

## 4. Client install (pilot)

Only after sections 1–3 pass on staging.

- [ ] In the Dev Dashboard → app → Distribution, generate a **custom distribution**
      install link for the client's `.myshopify.com` store.
- [ ] Send the client the link; they approve scopes (`read_products, write_products, write_files`).
- [ ] Help them add the theme app block to their live theme.
- [ ] Soft launch: a few videos first, watch `flyctl logs` for errors during real traffic.
- [ ] Confirm analytics flow with real visitors.

---

## 5. Post-handoff hygiene

- [ ] Delete `prisma/migrations_sqlite_backup/` (old SQLite history, no longer used).
- [ ] Remove the old unused Fly volume if still present: `flyctl volumes list` → `flyctl volumes destroy <id>`.
- [ ] Set a recurring reminder to watch Neon usage for the first few weeks.
- [ ] Consider pruning old `AnalyticsEvent` rows periodically to stay within free storage.

---

## Known watch-items

- **Node 22 deadline:** AWS SDK will require Node ≥22 after early 2027. Bump the
  Dockerfile base image (`node:20-alpine` → `node:22-alpine`) before then.
- **Single Fly machine + ffmpeg:** video processing is memory-hungry on a 512 MB
  box. If uploads of large videos OOM, bump VM memory in `fly.toml`.
- **No proxy signature check:** `/api/videos` and `/api/track` are open (CORS `*`).
  Fine for now, but consider verifying the Shopify app-proxy HMAC before scaling to
  many paying clients.
