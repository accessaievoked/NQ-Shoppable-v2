-- Products the merchant has chosen to manage videos for.
--
-- Lets a product appear on the Manage product page screen before it has any
-- videos. Previously rows were derived from videos alone, so a newly added
-- product had nowhere to persist and disappeared on refresh.
CREATE TABLE IF NOT EXISTS "ProductPage" (
  "id"        TEXT NOT NULL,
  "shop"      TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProductPage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProductPage_shop_productId_key"
  ON "ProductPage" ("shop", "productId");

CREATE INDEX IF NOT EXISTS "ProductPage_shop_idx"
  ON "ProductPage" ("shop");
