-- Add multiple-products support to Video
ALTER TABLE "Video" ADD COLUMN "products" TEXT NOT NULL DEFAULT '[]';
