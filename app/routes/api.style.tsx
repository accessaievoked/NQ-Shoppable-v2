import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { mergeConfig } from "../styleConfig";

/**
 * App Proxy endpoint — called by the storefront widget to fetch the merchant's
 * saved style configuration. Shopify proxies:
 *   https://{shop}.myshopify.com/apps/nq-videos/api/style
 * to this loader with ?shop={shop}. Returns the merged config (defaults +
 * saved overrides) as JSON.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  };

  if (!shop) {
    return new Response(JSON.stringify({ config: mergeConfig(null) }), { status: 400, headers });
  }

  try {
    const row = await db.styleSetting.findUnique({ where: { shop } });
    let stored: unknown = null;
    if (row?.config) {
      try { stored = JSON.parse(row.config); } catch { stored = null; }
    }
    return new Response(JSON.stringify({ config: mergeConfig(stored) }), { status: 200, headers });
  } catch (err) {
    console.error("[NQ Style API] DB error:", err);
    return new Response(JSON.stringify({ config: mergeConfig(null) }), { status: 200, headers });
  }
}
