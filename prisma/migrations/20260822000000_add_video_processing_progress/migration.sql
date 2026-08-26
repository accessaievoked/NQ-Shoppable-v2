-- Track background ffmpeg progress and failures on Video.
-- Guarded with IF NOT EXISTS to match the convention used by the other
-- migrations here, so a re-run against an already-migrated database is a no-op.
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "processingProgress" INTEGER;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "processingError" TEXT;
