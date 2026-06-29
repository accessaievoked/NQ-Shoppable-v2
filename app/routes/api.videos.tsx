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
      orderBy: { sortOrder: "asc" },
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

    // On a PDP, keep only videos matching this product — by id OR handle, since
    // a stored productId can go stale (re-import / other store) while the handle
    // stays stable. Done in JS to keep the matching logic simple and forgiving.
    let scoped = videos;
    if (isPdp) {
      const digits = (s: string) => String(s || "").replace(/\D/g, "");
      const handleOf = (u: string) => {
        const m = String(u || "").match(/\/products\/([^/?#]+)/);
        return m ? m[1].toLowerCase() : "";
      };
      const targetId = digits(productId);
      scoped = videos.filter((v) => {
        const idMatch = !!targetId && digits(v.productId) === targetId;
        const handleMatch = !!productHandle && handleOf(v.productUrl) === productHandle;
        return idMatch || handleMatch;
      });
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
