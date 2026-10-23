import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";
import db from "../db.server";

/**
 * Meta's data deletion request callback.
 *
 * Required for app review. Meta expects a JSON body containing a URL where the
 * user can check the status of their request, plus a confirmation code.
 *
 * What we delete: the connected-account row, which is the only Instagram
 * personal data we hold — the token, the username, the account id and the
 * cached media listing. Imported videos are the merchant's own commercial
 * content living in their store's storage, so they are left alone; removing a
 * store's product videos because someone unlinked an Instagram account would be
 * destructive and is not what the request asks for.
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
  const payload = parseSignedRequest(String(form.get("signed_request") ?? ""));

  if (!payload?.user_id) {
    console.warn("[Instagram] Rejected unsigned data-deletion callback");
    return new Response("Bad signature", { status: 400 });
  }

  const igUserId = String(payload.user_id);
  const deleted = await db.instagramAccount.deleteMany({ where: { igUserId } });

  // Meta requires a stable, user-visible confirmation code. Derived from the
  // user id and the app secret so it can be recomputed if they ask again,
  // without storing anything extra.
  const confirmationCode = crypto
    .createHmac("sha256", process.env.IG_APP_SECRET!)
    .update(`deletion:${igUserId}`)
    .digest("hex")
    .slice(0, 16);

  console.log(
    `[Instagram] Data deletion for ig user ${igUserId}: removed ${deleted.count} account row(s)`
  );

  const origin = new URL(request.url).origin;
  return new Response(
    JSON.stringify({
      url: `${origin}/api/instagram/data-deletion?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

/**
 * Status page for a deletion request. Meta's flow sends the user here with the
 * confirmation code to check on their request; ours completes synchronously, so
 * there is never anything pending to report.
 */
export const loader = ({ request }: { request: Request }) => {
  const code = new URL(request.url).searchParams.get("code") ?? "";
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Data deletion</title>` +
      `<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.6">` +
      `<h1>Data deletion complete</h1>` +
      `<p>Your Instagram account details have been removed from this app.</p>` +
      (code ? `<p>Confirmation code: <code>${code.replace(/[^a-f0-9]/gi, "")}</code></p>` : "") +
      `</body>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
};
