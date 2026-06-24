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
        productId: true,
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
        viewCount: true,
      },
    });

    const origin = new URL(request.url).origin;
    const videosWithAbsoluteUrls = videos.map((v) => ({
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
