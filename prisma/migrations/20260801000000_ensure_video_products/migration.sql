-- Ensure the "products" column exists on fresh databases. On a fresh DB the
-- original add_video_products migration sorts BEFORE init and no-ops (its table
-- doesn't exist yet), so we add the column here — after init has created the
-- table. Idempotent: on already-migrated databases (e.g. claura) the column
-- already exists, so this is a harmless no-op.
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "products" TEXT NOT NULL DEFAULT '[]';
