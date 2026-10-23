import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

/**
 * Recovers the shop domain from Shopify's `host` parameter.
 *
 * `host` is base64 (url-safe) of either "admin.shopify.com/store/<slug>" for
 * the current admin, or "<shop>.myshopify.com/admin" for the older one. Needed
 * because /app can't resolve a session without a shop.
 */
function shopFromHost(host: string): string | null {
  try {
    const normalised = host.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalised, "base64").toString("utf8");

    const viaStore = decoded.match(/admin\.shopify\.com\/store\/([^/?#]+)/i);
    if (viaStore) return `${viaStore[1]}.myshopify.com`;

    const viaLegacy = decoded.match(/([a-z0-9][a-z0-9-]*\.myshopify\.com)/i);
    if (viaLegacy) return viaLegacy[1].toLowerCase();

    return null;
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const params = url.searchParams;

  // Shopify embeds the app in an iframe, but WHICH parameters arrive is not
  // guaranteed — depending on how the admin navigates, a load can carry only
  // host / embedded / id_token and no shop at all.
  //
  // Redirecting on `shop` alone therefore fell through to the public marketing
  // page below, rendered inside the admin. That's the "A short heading about
  // [your app]" screen that appears intermittently and seems to fix itself
  // after a refresh or two (a refresh often restores the shop param).
  //
  // So: treat ANY embedded signal as "this belongs in /app", and recover the
  // shop from host when it wasn't passed. The marketing page is then only ever
  // shown for a genuine direct visit with no Shopify context at all.
  const isEmbeddedLoad =
    params.has("shop") ||
    params.has("host") ||
    params.has("id_token") ||
    params.has("session") ||
    params.get("embedded") === "1";

  if (isEmbeddedLoad) {
    if (!params.has("shop")) {
      const host = params.get("host");
      const recovered = host ? shopFromHost(host) : null;
      if (recovered) params.set("shop", recovered);
    }
    throw redirect(`/app?${params.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>A short heading about [your app]</h1>
        <p className={styles.text}>
          A tagline about [your app] that describes your value proposition.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Product feature</strong>. Some detail about your feature and
            its benefit to your customer.
          </li>
          <li>
            <strong>Product feature</strong>. Some detail about your feature and
            its benefit to your customer.
          </li>
          <li>
            <strong>Product feature</strong>. Some detail about your feature and
            its benefit to your customer.
          </li>
        </ul>
      </div>
    </div>
  );
}
