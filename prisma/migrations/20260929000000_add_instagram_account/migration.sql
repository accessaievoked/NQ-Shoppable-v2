-- Instagram reel import: connected account + per-video provenance.
--
-- Folder name sorts after 20260923130000_add_product_page, which matters
-- because `prisma migrate deploy` applies folders in lexicographic order and
-- is forward-only.
--
-- Idempotent, matching the other migrations in this project: re-running
-- against a database that already has these objects is a no-op rather than a
-- failed migration that blocks every later deploy.

CREATE TABLE IF NOT EXISTS "InstagramAccount" (
  "shop"           TEXT NOT NULL,
  "igUserId"       TEXT NOT NULL,
  "username"       TEXT NOT NULL,
  "accessToken"    TEXT NOT NULL,
  "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
  "mediaCache"     TEXT,
  "mediaCachedAt"  TIMESTAMP(3),
  "revokedAt"      TIMESTAMP(3),
  "lastError"      TEXT,
  "connectedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InstagramAccount_pkey" PRIMARY KEY ("shop")
);

-- Provenance for imported reels. Nullable, so existing rows need no backfill.
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "sourceIgShortcode" TEXT;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "sourceIgPermalink" TEXT;

-- Makes the "already imported?" check on the picker a single indexed lookup.
CREATE INDEX IF NOT EXISTS "Video_shop_sourceIgShortcode_idx"
  ON "Video" ("shop", "sourceIgShortcode");
