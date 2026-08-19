-- Add multiple-products support to Video.
-- Guarded: on a FRESH database this migration sorts before the init migration
-- that creates the table, so "IF EXISTS" makes it a safe no-op there. The
-- products column is (re)ensured after init by 20260801000000_ensure_video_products.
-- On already-migrated databases (e.g. claura) the column already exists, so
-- "IF NOT EXISTS" keeps this a no-op if it is ever re-run.
ALTER TABLE IF EXISTS "Video" ADD COLUMN IF NOT EXISTS "products" TEXT NOT NULL DEFAULT '[]';
