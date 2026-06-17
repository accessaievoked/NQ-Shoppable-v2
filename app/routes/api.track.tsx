import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";

/**
 * Tracks video events (VIEW, ATC) from the storefront widget.
 * POST /apps/nq-videos/api/track
 */
export async function action({ request }: ActionFunctionArgs) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const { type, videoId } = await request.json();

    if (!videoId || !["VIEW", "ATC"].includes(type)) {
      return new Response(JSON.stringify({ ok: false }), { status: 400, headers });
    }

    // Look up shop from the video
    const video = await db.video.findUnique({ where: { id: videoId }, select: { shop: true } });
    if (!video) return new Response(JSON.stringify({ ok: false }), { status: 400, headers });

    if (type === "VIEW") {
      await Promise.all([
        db.video.update({ where: { id: videoId }, data: { viewCount: { increment: 1 } } }),
        db.analyticsEvent.create({ data: { shop: video.shop, videoId, type: "VIEW" } }),
      ]);
    }

    if (type === "ATC") {
      await Promise.all([
        db.video.update({ where: { id: videoId }, data: { atcCount: { increment: 1 } } }),
        db.analyticsEvent.create({ data: { shop: video.shop, videoId, type: "ATC" } }),
      ]);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  } catch (err) {
    // Don't let tracking errors break anything
    return new Response(JSON.stringify({ ok: false }), { status: 200, headers });
  }
}
