# Neon Postgres Setup

The app was migrated from SQLite to Neon Postgres. Code changes are already done:

- `prisma/schema.prisma` → datasource provider is now `postgresql`
- Old SQLite migrations moved to `prisma/migrations_sqlite_backup/` (safe to delete later)
- `fly.toml` → removed the unused `nq_data` volume mount
- `.env` → `DATABASE_URL` updated to a Neon placeholder

Follow the steps below to finish.

## 1. Create a Neon project

1. Sign up at https://neon.tech (free, no card).
2. Create a project (region close to your Fly region `sin` → e.g. Singapore/AP).
3. Copy the **pooled** connection string (the host contains `-pooler`), it looks like:
   `postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require`

## 2. Set the connection string locally

Edit `.env` and replace the placeholder `DATABASE_URL` with your real Neon pooled string.

## 3. Create the database tables (run once)

```bash
npx prisma generate
npx prisma migrate dev --name init
```

This generates a fresh Postgres migration and creates the `Video`, `AnalyticsEvent`,
and `Session` tables in Neon. Verify with:

```bash
npx prisma studio   # opens a browser UI to confirm the 3 tables exist
```

## 4. Point Fly at Neon

Set the secret on the deployed app (use the SAME pooled string):

```bash
fly secrets set DATABASE_URL="postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require"
```

Your `setup` script (`prisma generate && prisma migrate deploy`) runs on container
start, so the tables are applied automatically on the next deploy.

## 5. (Optional) Remove the now-unused Fly volume

After a successful deploy on Postgres:

```bash
fly volumes list
fly volumes destroy <volume-id>   # the old "nq_data" volume
```

## 6. Deploy

```bash
npm run deploy        # push the Shopify app/extension config
fly deploy            # deploy the backend to Fly
```

## Notes

- Use the **pooled** connection string (host has `-pooler`) so many short serverless
  connections don't exhaust Postgres. Keep `?sslmode=require`.
- Data does NOT migrate automatically from the old SQLite file. If you need the
  existing test-store videos/analytics, export them separately. (Sessions will just
  re-create on next login.)
- Delete `prisma/migrations_sqlite_backup/` once you've confirmed Postgres works.
