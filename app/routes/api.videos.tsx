import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";

/**
 * App Proxy endpoint — called by the storefront widget.
 * Shopify proxies: https://{shop}.myshopify.com/apps/nq-videos/api/videos
 * to:             https://{our-backend}/api/videos?shop={shop}
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  // Product context — present only on a product page (PDP). When set, we return
  // videos linked to THIS product regardless of active state (so deactivated
  // videos still show on their product page); otherwise (home/collection) we
  // return only active videos. Filtering here keeps deactivated videos out of
  // the home payload entirely, so they never affect page load.
  const productId = url.searchParams.get("product_id") || "";
  const productHandle = (url.searchParams.get("product_handle") || "").toLowerCase();
  const isPdp = !!(productId || productHandle);

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    // Tell Shopify's proxy not to cache (for dynamic data)
    "Cache-Control": "no-cache",
  };

  if (!shop) {
    return new Response(
      JSON.stringify({ error: "Missing shop param", videos: [] }),
      { status: 400, headers }
    );
  }

  try {
    const videos = await db.video.findMany({
      // Home/collection: active only. PDP: all (active + inactive), filtered to
      // the product below.
      where: isPdp ? { shop } : { shop, active: true },
      // Tie-break on createdAt — see the note in app._index.tsx. Matters more
      // here: api.track increments viewCount on every storefront view, so with
      // a single tied sort key the carousel reordered itself as shoppers watched.
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        productId: true,
        videoUrl: true,
        streamUrl: true,
        previewUrl: true,
        thumbnailUrl: true,
        productTitle: true,
        productUrl: true,
        productImageUrl: true,
        variantId: true,
        price: true,
        compareAtPrice: true,
        currency: true,
        viewCount: true,
      },
    });

    // On a PDP, keep only videos for this product.
    //
    // Two sources, in priority order:
    //
    //  1. CURATED — rows in ProductMedia, which is what the merchant picks on
    //     the Product pages screen. When a product has any, those are exactly
    //     what shows, in their chosen order. This is what lets a merchant
    //     remove a video from a product page without untagging it, and it needs
    //     nothing stored in Shopify, so the plan's video cap never applies.
    //
    //  2. TAGGED — videos whose Video.productId points at this product. Used
    //     when nothing has been curated, so stores that never touch the new
    //     screen keep behaving exactly as before.
    //
    // Matching is by id OR handle because a stored productId goes stale when a
    // product is re-created (new id, same handle), and forgiving matching beats
    // a silently empty product page.
    let scoped = videos;
    if (isPdp) {
      const digits = (s: string) => String(s || "").replace(/\D/g, "");
      const handleOf = (u: string) => {
        const m = String(u || "").match(/\/products\/([^/?#]+)/);
        return m ? m[1].toLowerCase() : "";
      };
      const targetId = digits(productId);

      const matchesProduct = (v: { productId: string; productUrl: string }) => {
        const idMatch = !!targetId && digits(v.productId) === targetId;
        const handleMatch = !!productHandle && handleOf(v.productUrl) === productHandle;
        return idMatch || handleMatch;
      };

      // Resolve the product's GID. ProductMedia stores the full
      // gid://shopify/Product/... form while the storefront only gives us a
      // numeric id, so build it directly — deriving it from whichever video
      // happened to match would miss the important case of a product that has
      // curated videos but none of its own tagged to it.
      const productGids = new Set<string>();
      if (targetId) productGids.add(`gid://shopify/Product/${targetId}`);
      // Belt and braces for any row stored in a different shape.
      for (const v of videos) {
        if (matchesProduct(v) && v.productId) productGids.add(v.productId);
      }

      let curated: Array<{ videoId: string; position: number }> = [];
      if (productGids.size) {
        curated = await db.productMedia.findMany({
          where: {
            shop,
            productId: { in: Array.from(productGids) },
            status: { not: "REMOVED" },
          },
          orderBy: { position: "asc" },
          select: { videoId: true, position: true },
        });
      }

      if (curated.length) {
        const order = new Map(curated.map((c, i) => [c.videoId, c.position * 1000 + i]));
        scoped = videos
          .filter((v) => order.has(v.id))
          .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      } else {
        scoped = videos.filter(matchesProduct);
      }
    }

    const origin = new URL(request.url).origin;
    const videosWithAbsoluteUrls = scoped.map((v) => ({
      ...v,
      videoUrl: v.videoUrl?.startsWith("/") ? `${origin}${v.videoUrl}` : v.videoUrl,
    }));

    return new Response(JSON.stringify({ videos: videosWithAbsoluteUrls }), { status: 200, headers });
  } catch (err) {
    console.error("[NQ Videos API] DB error:", err);
    return new Response(
      JSON.stringify({ error: "Server error", videos: [] }),
      { status: 500, headers }
    );
  }
}
