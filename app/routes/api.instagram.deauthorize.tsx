import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";

/**
 * Meta's deauthorize callback.
 *
 * Fires when a merchant removes our app from inside Instagram. Required for app
 * review, and reviewers do test it. We mark the row revoked rather than
 * deleting it so already-imported videos keep their provenance — they live in
 * our own storage and go on working.
 *
 * The body is a signed request: "<base64url signature>.<base64url payload>",
 * signed with the app secret. An unsigned POST to this URL must not be able to
 * disconnect anybody.
 */

function parseSignedRequest(signed: string): { user_id?: string } | null {
  const [sigPart, payloadPart] = signed.split(".");
  if (!sigPart || !payloadPart) return null;

  const expected = crypto
    .createHmac("sha256", process.env.IG_APP_SECRET!)
    .update(payloadPart)
    .digest();
  const given = Buffer.from(sigPart, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payloadPart, "base64url").toString());
  } catch {
    return null;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const signed = String(form.get("signed_request") ?? "");

  const payload = parseSignedRequest(signed);
  if (!payload?.user_id) {
    console.warn("[Instagram] Rejected unsigned deauthorize callback");
    return new Response("Bad signature", { status: 400 });
  }

  const result = await db.instagramAccount.updateMany({
    where: { igUserId: String(payload.user_id) },
    data: {
      revokedAt: new Date(),
      accessToken: "",
      mediaCache: null,
      mediaCachedAt: null,
      lastError: "Disconnected from Instagram",
    },
  });

  console.log(
    `[Instagram] Deauthorized ig user ${payload.user_id} (${result.count} account row(s))`
  );
  return new Response(null, { status: 200 });
};

/** Meta only ever POSTs here; a GET is almost certainly someone poking around. */
export const loader = () => new Response("Method not allowed", { status: 405 });
