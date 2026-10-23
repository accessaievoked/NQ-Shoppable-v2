import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { exchangeCode, saveAccount, verifyState, redactSecrets } from "../instagram.server";

/**
 * OAuth redirect target for Instagram Login.
 *
 * Deliberately under `auth.` rather than `app.`: Meta sends the merchant's
 * browser straight here with no Shopify session cookie and no embedded-app
 * context, so calling authenticate.admin() would throw or bounce to a login.
 * The shop identity comes from the HMAC-signed `state` we generated when the
 * flow started — that signature is the only thing preventing someone from
 * binding their own Instagram account to another merchant's shop.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");

  // The merchant pressed Cancel on the consent screen. Not an error worth a
  // stack trace — send them back where they started.
  if (denied || !code || !state) {
    return redirect(`/app/instagram?igError=${encodeURIComponent(denied ?? "cancelled")}`);
  }

  let shop: string;
  try {
    ({ shop } = verifyState(state));
  } catch (err) {
    console.error("[Instagram] Rejected OAuth callback:", (err as Error).message);
    // No trustworthy shop to redirect into, and we will not guess one.
    return new Response("Invalid OAuth state", { status: 400 });
  }

  try {
    const account = await exchangeCode(code);
    await saveAccount(shop, account);
    console.log(`[Instagram] Connected @${account.username} for ${shop}`);
    return redirect(`/app/instagram?connected=${encodeURIComponent(account.username)}`);
  } catch (err) {
    const message = redactSecrets(String((err as Error)?.message ?? err));
    console.error(`[Instagram] Connect failed for ${shop}:`, message);
    return redirect(`/app/instagram?igError=${encodeURIComponent(message.slice(0, 200))}`);
  }
};
