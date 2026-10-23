-- Ordering for videos curated onto a product page.
--
-- The product page is now served from our own data rather than Shopify's media
-- gallery, so we own the order. Idempotent so re-running against a database
-- that already has the column is a no-op.
ALTER TABLE "ProductMedia" ADD COLUMN IF NOT EXISTS "position" INTEGER NOT NULL DEFAULT 0;

-- Supports the storefront's per-product lookup: filter by shop + product,
-- ordered by position.
CREATE INDEX IF NOT EXISTS "ProductMedia_shop_productId_position_idx"
  ON "ProductMedia" ("shop", "productId", "position");
