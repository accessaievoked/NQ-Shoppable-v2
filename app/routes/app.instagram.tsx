import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { buildAuthUrl, getAccount, revokeAccount } from "../instagram.server";

/**
 * Instagram connection settings.
 *
 * The connect button is the whole verification story for reel import: once a
 * merchant has authorised our Meta app, every reel we can see is one they
 * posted. Nothing on this screen asks them to type a handle, because a typed
 * handle is a claim, not evidence.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const account = await getAccount(session.shop);
  const configured = Boolean(
    process.env.IG_APP_ID && process.env.IG_APP_SECRET && process.env.IG_REDIRECT_URI
  );

  // Never send the token to the browser, encrypted or not.
  return {
    // Built here rather than on a form POST because Instagram's consent screen
    // refuses to render inside Shopify's admin iframe. The link carries
    // target="_top" so the whole tab navigates. The signed state inside is
    // meant to travel through the browser and is HMAC'd and time-limited.
    authUrl: configured && !account ? buildAuthUrl(session.shop) : null,
    connected: account
      ? {
          username: account.username,
          connectedAt: account.connectedAt.toISOString(),
          tokenExpiresAt: account.tokenExpiresAt.toISOString(),
          lastError: account.lastError,
        }
      : null,
    importedCount: await db.video.count({
      where: { shop: session.shop, sourceIgShortcode: { not: null } },
    }),
    configured,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const intent = String((await request.formData()).get("intent") ?? "");

  if (intent === "disconnect") {
    await revokeAccount(session.shop);
    return { ok: true };
  }

  return { ok: false };
};

export default function InstagramSettings() {
  const { connected, importedCount, configured, authUrl } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const fetcher = useFetcher<typeof action>();

  const justConnected = params.get("connected");
  const igError = params.get("igError");
  const busy = fetcher.state !== "idle";

  const daysLeft = connected
    ? Math.round((new Date(connected.tokenExpiresAt).getTime() - Date.now()) / 86400000)
    : 0;

  return (
    <s-page heading="Instagram">
      <s-section heading="Connected account">
        {!configured && (
          <div style={{ ...styles.banner, ...styles.bannerWarn }}>
            The Instagram app credentials aren't set on this deployment yet. Add
            <code> IG_APP_ID</code>, <code>IG_APP_SECRET</code>, <code>IG_REDIRECT_URI</code> and
            <code> IG_TOKEN_ENC_KEY</code>, then redeploy.
          </div>
        )}

        {justConnected && (
          <div style={{ ...styles.banner, ...styles.bannerOk }}>
            Connected as @{justConnected}.
          </div>
        )}

        {igError && (
          <div style={{ ...styles.banner, ...styles.bannerError }}>
            Couldn't connect: {igError}
          </div>
        )}

        <p style={styles.intro}>
          Connect the store's Instagram Business or Creator account to import reels
          directly. You can only import reels posted by the connected account —
          that's what proves you own them.
        </p>

        {connected ? (
          <div style={styles.card}>
            <div style={styles.row}>
              <div>
                <div style={styles.handle}>@{connected.username}</div>
                <div style={styles.muted}>
                  Connected {new Date(connected.connectedAt).toLocaleDateString()} ·{" "}
                  {importedCount} reel{importedCount === 1 ? "" : "s"} imported
                </div>
              </div>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="disconnect" />
                <button type="submit" disabled={busy} style={styles.secondaryBtn}>
                  {busy ? "Disconnecting…" : "Disconnect"}
                </button>
              </fetcher.Form>
            </div>

            {daysLeft <= 14 && (
              <div style={{ ...styles.banner, ...styles.bannerWarn, marginTop: "12px" }}>
                This connection expires in {daysLeft} day{daysLeft === 1 ? "" : "s"}.
                It renews automatically, but reconnect if imports start failing.
              </div>
            )}

            {connected.lastError && (
              <div style={{ ...styles.banner, ...styles.bannerError, marginTop: "12px" }}>
                Last error from Instagram: {connected.lastError}
              </div>
            )}
          </div>
        ) : (
          <div style={styles.card}>
            <div style={styles.muted}>No account connected.</div>
            {authUrl ? (
              <a href={authUrl} target="_top" style={styles.primaryLink}>
                Connect Instagram
              </a>
            ) : (
              <span style={{ ...styles.primaryLink, ...styles.disabledLink }}>
                Connect Instagram
              </span>
            )}
            <p style={{ ...styles.muted, marginTop: "10px" }}>
              The account must be a Business or Creator account. You can switch in the
              Instagram app under Settings → Account type and tools.
            </p>
          </div>
        )}
      </s-section>

      <s-section slot="aside" heading="Good to know">
        <s-unordered-list>
          <s-list-item>
            Reels that use licensed audio — including tracks from Instagram's audio
            library — can't be downloaded. Upload those as files instead.
          </s-list-item>
          <s-list-item>
            Disconnecting doesn't remove reels you've already imported. They live in
            your own storage.
          </s-list-item>
          <s-list-item>
            Only one Instagram account can be connected per store.
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

const styles: Record<string, React.CSSProperties> = {
  intro: { fontSize: "13px", color: "#616161", margin: "0 0 14px", lineHeight: 1.5 },
  card: { border: "1px solid #e3e3e3", borderRadius: "10px", padding: "16px" },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
  handle: { fontSize: "15px", fontWeight: 600, marginBottom: "2px" },
  muted: { color: "#8a8a8a", fontSize: "12px" },
  banner: {
    borderRadius: "8px",
    padding: "10px 12px",
    fontSize: "13px",
    marginBottom: "14px",
    lineHeight: 1.5,
  },
  bannerOk: { background: "#f0f9f2", color: "#0c5132", border: "1px solid #cdebd8" },
  bannerWarn: { background: "#fff8eb", color: "#7c4a00", border: "1px solid #ffe0a3" },
  bannerError: { background: "#fff4f4", color: "#8e1f1f", border: "1px solid #f5c2c2" },
  primaryLink: {
    display: "inline-block",
    marginTop: "12px",
    padding: "9px 16px",
    borderRadius: "8px",
    border: "1px solid #1a1a1a",
    background: "#1a1a1a",
    color: "#fff",
    fontSize: "13px",
    textDecoration: "none",
    cursor: "pointer",
  },
  disabledLink: { opacity: 0.4, cursor: "not-allowed" },
  secondaryBtn: {
    padding: "8px 14px",
    borderRadius: "8px",
    border: "1px solid #d0d5dd",
    background: "#fff",
    fontSize: "13px",
    cursor: "pointer",
  },
};

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
