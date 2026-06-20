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
      where: { shop, active: true },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        title: true,
        videoUrl: true,
        streamUrl: true,
        thumbnailUrl: true,
        productTitle: true,
        productUrl: true,
        productImageUrl: true,
        variantId: true,
        price: true,
        compareAtPrice: true,
        currency: true,
        products: true,
        viewCount: true,
      },
    });

    const origin = new URL(request.url).origin;
    const videosWithAbsoluteUrls = videos.map((v) => {
      // Parse the products JSON; fall back to the single legacy product fields
      // so existing videos (saved before multi-product) still work.
      let products: any[] = [];
      try { products = JSON.parse(v.products || "[]"); } catch { products = []; }
      if (!Array.isArray(products) || products.length === 0) {
        if (v.productTitle || v.variantId || v.productUrl) {
          products = [{
            productTitle: v.productTitle,
            productImageUrl: v.productImageUrl,
            productUrl: v.productUrl,
            variantId: v.variantId,
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            currency: v.currency,
          }];
        }
      }
      return {
        ...v,
        videoUrl: v.videoUrl?.startsWith("/") ? `${origin}${v.videoUrl}` : v.videoUrl,
        products, // parsed array overrides the raw JSON string
      };
    });

    return new Response(JSON.stringify({ videos: videosWithAbsoluteUrls }), { status: 200, headers });
  } catch (err) {
    console.error("[NQ Videos API] DB error:", err);
    return new Response(
      JSON.stringify({ error: "Server error", videos: [] }),
      { status: 500, headers }
    );
  }
}
