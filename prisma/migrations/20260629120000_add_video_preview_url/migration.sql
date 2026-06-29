-- Add tiny card-preview clip URL to Video (nullable: null = card falls back to full video)
ALTER TABLE "Video" ADD COLUMN "previewUrl" TEXT;
