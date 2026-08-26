-- Links an R2-hosted Video to the copy Shopify hosts in the product's media
-- gallery. Guarded with IF NOT EXISTS so re-running against an already-migrated
-- database (or a partially applied deploy) is a no-op, matching the convention
-- used by the other migrations here.
CREATE TABLE IF NOT EXISTS "ProductMedia" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopifyFileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMedia_pkey" PRIMARY KEY ("id")
);

-- One row per (shop, video, product): stops a second fileCreate from running
-- and uploading a duplicate copy to Shopify if the merchant clicks twice.
CREATE UNIQUE INDEX IF NOT EXISTS "ProductMedia_shop_videoId_productId_key"
    ON "ProductMedia"("shop", "videoId", "productId");

-- Supports the background poller, which scans for rows still PROCESSING.
CREATE INDEX IF NOT EXISTS "ProductMedia_shop_status_idx"
    ON "ProductMedia"("shop", "status");
