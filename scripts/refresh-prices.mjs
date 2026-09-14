/**
 * Refresh price + compareAtPrice on existing videos, straight from Shopify.
 *
 * WHY: price and compareAtPrice are snapshots taken when a product was attached
 * to a video. Until the upload-page fix, compareAtPrice was never saved at all,
 * so the storefront could not calculate a discount. This re-reads the live
 * variant from Shopify and updates the two fields.
 *
 * NOTHING IS RE-UPLOADED OR RE-ENCODED. Videos, previews and thumbnails are
 * untouched; this only writes Video.price and Video.compareAtPrice.
 *
 * SAFETY
 *  - Writes ONLY those two fields. Product links, sortOrder, viewCount, URLs
 *    and every other column are never touched.
 *  - Skips videos with no variantId, and any variant Shopify no longer returns.
 *  - Idempotent: rows already matching Shopify are left alone. Re-run anytime.
 *  - --dry prints what WOULD change and writes nothing.
 *
 * USAGE (on the Fly machine, which already has DATABASE_URL):
 *   fly ssh console -a nq-shoppable-lovecovera
 *   cd /app
 *   node scripts/refresh-prices.mjs --dry     # preview first
 *   node scripts/refresh-prices.mjs           # apply
 *
 * Optional: --shop=cf0b27.myshopify.com to limit to one store.
 */

import { PrismaClient } from "@prisma/client";

const API_VERSION = "2026-07";
const BATCH_SIZE = 50; // variants per GraphQL call — well inside the cost limit

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry");
const shopArg = (args.find((a) => a.startsWith("--shop=")) || "").split("=")[1];

const prisma = new PrismaClient();

/** Variant ids are stored inconsistently (bare numeric or already a gid). */
function toVariantGid(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("gid://")) return s;
  const digits = s.replace(/\D/g, "");
  return digits ? `gid://shopify/ProductVariant/${digits}` : null;
}

async function shopifyGraphQL(shop, token, query, variables) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

const VARIANTS_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        price
        compareAtPrice
      }
    }
  }`;

/** The app's offline session holds the Admin API token for a shop. */
async function getToken(shop) {
  const session =
    (await prisma.session.findFirst({ where: { shop, isOnline: false } })) ||
    (await prisma.session.findFirst({ where: { shop } }));
  return session?.accessToken || null;
}

const num = (v) => (v === null || v === undefined || v === "" ? null : parseFloat(v));

async function processShop(shop) {
  console.log(`\n=== ${shop} ===`);

  const token = await getToken(shop);
  if (!token) {
    console.warn(`[skip] no access token stored for ${shop} — is the app still installed?`);
    return { updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  }

  const videos = await prisma.video.findMany({
    where: { shop },
    select: { id: true, variantId: true, price: true, compareAtPrice: true, productTitle: true },
  });

  let updated = 0, unchanged = 0, skipped = 0, failed = 0;

  // Build the id -> videos map (several videos can share one variant).
  const byGid = new Map();
  for (const v of videos) {
    const gid = toVariantGid(v.variantId);
    if (!gid) { skipped++; continue; }
    if (!byGid.has(gid)) byGid.set(gid, []);
    byGid.get(gid).push(v);
  }

  const allGids = [...byGid.keys()];
  console.log(`${videos.length} video(s), ${allGids.length} distinct variant(s)`);

  for (let i = 0; i < allGids.length; i += BATCH_SIZE) {
    const chunk = allGids.slice(i, i + BATCH_SIZE);
    let nodes;
    try {
      const data = await shopifyGraphQL(shop, token, VARIANTS_QUERY, { ids: chunk });
      nodes = data.nodes || [];
    } catch (err) {
      console.warn(`[fail] batch ${i / BATCH_SIZE + 1}: ${err.message}`);
      failed += chunk.reduce((n, g) => n + byGid.get(g).length, 0);
      continue;
    }

    for (const node of nodes) {
      if (!node || !node.id) continue;
      const rows = byGid.get(node.id) || [];
      const newPrice = num(node.price);
      const newCompare = num(node.compareAtPrice);

      for (const row of rows) {
        if (row.price === newPrice && row.compareAtPrice === newCompare) { unchanged++; continue; }

        const label = `${row.productTitle || row.id}`;
        const before = `price=${row.price} compare=${row.compareAtPrice}`;
        const after = `price=${newPrice} compare=${newCompare}`;

        if (DRY_RUN) {
          console.log(`[dry ] ${label}: ${before} -> ${after}`);
          updated++;
          continue;
        }

        try {
          // ONLY these two fields.
          await prisma.video.update({
            where: { id: row.id },
            data: { price: newPrice, compareAtPrice: newCompare },
          });
          console.log(`[ok  ] ${label}: ${before} -> ${after}`);
          updated++;
        } catch (err) {
          console.warn(`[fail] ${label}: ${err.message}`);
          failed++;
        }
      }
    }

    // Variants Shopify didn't return (deleted product/variant) stay as-is.
    const returned = new Set(nodes.filter(Boolean).map((n) => n.id));
    for (const gid of chunk) {
      if (!returned.has(gid)) {
        const n = (byGid.get(gid) || []).length;
        if (n) { console.warn(`[skip] variant not found in Shopify: ${gid}`); skipped += n; }
      }
    }
  }

  console.log(`${shop}: ${updated} updated, ${unchanged} unchanged, ${skipped} skipped, ${failed} failed`);
  return { updated, unchanged, skipped, failed };
}

async function run() {
  if (DRY_RUN) console.log("DRY RUN — no changes will be written.\n");

  const shops = shopArg
    ? [shopArg]
    : (await prisma.video.findMany({ distinct: ["shop"], select: { shop: true } })).map((r) => r.shop);

  if (!shops.length) { console.log("No shops found."); return; }

  const total = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const shop of shops) {
    const r = await processShop(shop);
    for (const k of Object.keys(total)) total[k] += r[k];
  }

  console.log(
    `\n[refresh-prices] complete — ${total.updated} updated, ${total.unchanged} unchanged, ` +
    `${total.skipped} skipped, ${total.failed} failed`
  );
  if (DRY_RUN) console.log("Re-run without --dry to apply.");
}

run()
  .catch((e) => {
    console.error("[refresh-prices] fatal:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
