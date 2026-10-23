import type { LoaderFunctionArgs } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";
import { encryptToken, redactSecrets, refreshToken } from "../instagram.server";

/**
 * Extends long-lived Instagram tokens before they expire.
 *
 * Meant to be hit once a day by a scheduled Fly machine or an external cron:
 *
 *   curl -H "x-cron-secret: $IG_CRON_SECRET" \
 *        https://nq-shoppable-<client>.fly.dev/api/instagram/refresh
 *
 * Refreshes anything within 14 days of expiry rather than waiting for the
 * deadline. A token that actually expires cannot be refreshed at all — the
 * merchant has to reconnect — so the headroom means a refresh can fail on
 * twelve consecutive days before anyone has to do anything, and the settings
 * screen has time to show its warning banner.
 */

const HEADROOM_MS = 14 * 24 * 3600 * 1000;

function authorize(request: Request) {
  const expected = process.env.IG_CRON_SECRET;
  // Refuse rather than run unauthenticated: this endpoint touches every token
  // in the database, so a missing secret is a misconfiguration, not a reason
  // to be permissive.
  if (!expected) throw new Response("IG_CRON_SECRET not configured", { status: 503 });

  const given = request.headers.get("x-cron-secret") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Response("Forbidden", { status: 403 });
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  authorize(request);

  const due = await db.instagramAccount.findMany({
    where: {
      revokedAt: null,
      tokenExpiresAt: { lt: new Date(Date.now() + HEADROOM_MS) },
    },
  });

  let refreshed = 0;
  let failed = 0;

  for (const acct of due) {
    // Already dead — refreshing is impossible, so flag it for the merchant
    // instead of burning a call on it.
    if (acct.tokenExpiresAt.getTime() <= Date.now()) {
      await db.instagramAccount.update({
        where: { shop: acct.shop },
        data: { lastError: "Connection expired. Reconnect Instagram to keep importing." },
      });
      failed++;
      continue;
    }

    try {
      const next = await refreshToken(acct.accessToken);
      await db.instagramAccount.update({
        where: { shop: acct.shop },
        data: {
          accessToken: encryptToken(next.token),
          tokenExpiresAt: new Date(Date.now() + next.expiresIn * 1000),
          lastError: null,
        },
      });
      refreshed++;
    } catch (err) {
      const message = redactSecrets(String((err as Error)?.message ?? err)).slice(0, 300);
      console.error(`[Instagram] Token refresh failed for ${acct.shop}:`, message);
      await db.instagramAccount
        .update({ where: { shop: acct.shop }, data: { lastError: message } })
        .catch(() => {});
      failed++;
    }
  }

  console.log(`[Instagram] Token refresh run: ${refreshed} refreshed, ${failed} failed`);
  return { due: due.length, refreshed, failed };
};
