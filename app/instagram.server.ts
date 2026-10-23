import crypto from "node:crypto";
import db from "./db.server";

/**
 * Instagram reel import.
 *
 * The rule this module exists to enforce: we only ever read media the merchant
 * has granted us access to. An Instagram shortcode carries no owner
 * information, so a pasted link can never be verified by inspecting it — the
 * only way would be to fetch the public page, which is scraping. Instead the
 * merchant authorises our Meta app once, and from then on /me/media returns
 * their account's media and nothing else. A link to any other account simply
 * isn't in that list, and no request is ever made for it.
 *
 * Endpoints per Meta's "Instagram API with Instagram Login". Note that the
 * credentials are the *Instagram* app ID and secret shown under the Instagram
 * product in the app dashboard, NOT the Meta app ID and secret under App
 * settings → Basic. They look interchangeable and are not.
 */

const AUTH_BASE = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";

/**
 * The only scope we ask for. Every additional permission is a separate app
 * review item and a separate chance of rejection, and we genuinely need
 * nothing else — we never publish, read messages, or read insights.
 */
const SCOPES = "instagram_business_basic";

/** Media listing is cached this long before we call Meta again. */
const MEDIA_CACHE_MS = 15 * 60 * 1000;

/** Signed OAuth state is rejected beyond this age. */
const STATE_TTL_MS = 10 * 60 * 1000;

/** Refuse anything larger than this rather than OOM-ing the Fly machine. */
const MAX_IMPORT_BYTES = 300 * 1024 * 1024;

// ─── Errors ───────────────────────────────────────────────────────────────────

export type IgErrorCode =
  | "NOT_CONNECTED"
  | "NOT_A_REEL_LINK"
  | "NOT_YOURS"
  | "LICENSED_AUDIO"
  | "TOKEN_EXPIRED"
  | "RATE_LIMITED"
  | "CDN_FETCH_FAILED"
  | "TOO_LARGE"
  | "API_ERROR";

/**
 * Carries a stable code so routes can map to merchant-facing copy without
 * string-matching on messages that Meta may reword at any time.
 */
export class IgError extends Error {
  code: IgErrorCode;
  constructor(code: IgErrorCode, message?: string) {
    super(message ?? code);
    this.name = "IgError";
    this.code = code;
  }
}

/** Merchant-facing wording for each code. Kept beside the codes so they can't drift apart. */
export const IG_ERROR_MESSAGES: Record<IgErrorCode, string> = {
  NOT_CONNECTED: "Connect your Instagram account first.",
  NOT_A_REEL_LINK: "That doesn't look like an Instagram reel link.",
  NOT_YOURS:
    "That reel isn't on the connected account. You can only import reels you posted yourself.",
  LICENSED_AUDIO:
    "Instagram doesn't allow downloading this reel because of its audio. Upload the file instead.",
  TOKEN_EXPIRED: "Your Instagram connection expired. Reconnect to keep importing.",
  RATE_LIMITED: "Instagram is rate-limiting us. Try again in a few minutes.",
  CDN_FETCH_FAILED: "Couldn't download that reel from Instagram. Try again.",
  TOO_LARGE: "That reel is too large to import.",
  API_ERROR: "Instagram returned an error. Try again in a moment.",
};

// ─── Token encryption ─────────────────────────────────────────────────────────

function encryptionKey(): Buffer {
  const raw = process.env.IG_TOKEN_ENC_KEY;
  if (!raw) throw new Error("IG_TOKEN_ENC_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("IG_TOKEN_ENC_KEY must decode to 32 bytes (openssl rand -base64 32)");
  }
  return key;
}

/**
 * A stolen database dump should not hand over every merchant's Instagram
 * account. AES-256-GCM rather than CBC so tampering is detectable, and the IV
 * is random per call so the same token never encrypts to the same string.
 */
export function encryptToken(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

export function decryptToken(stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed encrypted token");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Strips anything token-shaped out of text bound for a log or the database.
 *
 * Meta echoes the access token back inside some error payloads. Writing one of
 * those verbatim into InstagramAccount.lastError would put a live credential in
 * plain text where the settings screen renders it.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/access_token=[^&\s"]+/gi, "access_token=[redacted]")
    .replace(/IG[A-Za-z0-9_-]{20,}/g, "[redacted-token]");
}

// ─── OAuth state ──────────────────────────────────────────────────────────────

type StatePayload = { shop: string; nonce: string; ts: number };

function signState(payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", process.env.IG_APP_SECRET!)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Verifies the state parameter Meta hands back.
 *
 * This is the only thing standing between the callback and an attacker binding
 * their own Instagram account to someone else's shop: the callback arrives with
 * no Shopify session, so the shop identity comes entirely from here.
 */
export function verifyState(state: string): StatePayload {
  const [body, sig] = state.split(".");
  if (!body || !sig) throw new Error("Malformed OAuth state");

  const expected = crypto
    .createHmac("sha256", process.env.IG_APP_SECRET!)
    .update(body)
    .digest("base64url");

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so check that first.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Bad OAuth state signature");
  }

  const parsed = JSON.parse(Buffer.from(body, "base64url").toString()) as StatePayload;
  if (!parsed.shop) throw new Error("OAuth state carries no shop");
  if (Date.now() - parsed.ts > STATE_TTL_MS) throw new Error("OAuth state expired");
  return parsed;
}

export function buildAuthUrl(shop: string): string {
  const qs = new URLSearchParams({
    client_id: process.env.IG_APP_ID!,
    redirect_uri: process.env.IG_REDIRECT_URI!,
    scope: SCOPES,
    response_type: "code",
    state: signState({ shop, nonce: crypto.randomBytes(16).toString("hex"), ts: Date.now() }),
  });
  return `${AUTH_BASE}?${qs}`;
}

// ─── Token exchange ───────────────────────────────────────────────────────────

export type ExchangedAccount = {
  igUserId: string;
  username: string;
  token: string;
  expiresIn: number; // seconds
};

/**
 * Trades the authorization code for a token we can keep.
 *
 * Two hops: the code buys a short-lived token good for an hour, which is no use
 * to a background job, so it is immediately swapped for a 60-day one. Both
 * calls carry the app secret and must stay server-side.
 */
export async function exchangeCode(code: string): Promise<ExchangedAccount> {
  const form = new URLSearchParams({
    client_id: process.env.IG_APP_ID!,
    client_secret: process.env.IG_APP_SECRET!,
    grant_type: "authorization_code",
    redirect_uri: process.env.IG_REDIRECT_URI!,
    code,
  });

  const short: any = await fetch(TOKEN_URL, { method: "POST", body: form }).then((r) => r.json());
  if (!short?.access_token) {
    throw new IgError("API_ERROR", redactSecrets(short?.error_message ?? "Token exchange failed"));
  }

  const longUrl = new URL(`${GRAPH}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", process.env.IG_APP_SECRET!);
  longUrl.searchParams.set("access_token", short.access_token);

  const long: any = await fetch(longUrl).then((r) => r.json());
  if (!long?.access_token) {
    throw new IgError("API_ERROR", redactSecrets(long?.error?.message ?? "Long-lived exchange failed"));
  }

  const me: any = await fetch(
    `${GRAPH}/me?fields=id,username,account_type&access_token=${long.access_token}`
  ).then((r) => r.json());
  if (!me?.id) {
    throw new IgError("API_ERROR", redactSecrets(me?.error?.message ?? "Could not read account"));
  }

  return {
    igUserId: String(me.id),
    username: String(me.username ?? ""),
    // ~60 days. Meta has changed this constant before; trust the response.
    token: long.access_token as string,
    expiresIn: Number(long.expires_in ?? 5184000),
  };
}

/**
 * Extends a long-lived token by another 60 days.
 *
 * A token that actually reaches expiry cannot be refreshed — the merchant has
 * to reconnect — so the caller runs this well ahead of the deadline rather than
 * at it. Meta also requires the token to be at least 24 hours old.
 */
export async function refreshToken(stored: string): Promise<{ token: string; expiresIn: number }> {
  const url = new URL(`${GRAPH}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", decryptToken(stored));

  const res: any = await fetch(url).then((r) => r.json());
  if (!res?.access_token) {
    throw new IgError("API_ERROR", redactSecrets(res?.error?.message ?? "Refresh failed"));
  }
  return { token: res.access_token, expiresIn: Number(res.expires_in ?? 5184000) };
}

// ─── Account access ───────────────────────────────────────────────────────────

export async function getAccount(shop: string) {
  const acct = await db.instagramAccount.findUnique({ where: { shop } });
  if (!acct || acct.revokedAt) return null;
  return acct;
}

async function requireAccount(shop: string) {
  const acct = await getAccount(shop);
  if (!acct) throw new IgError("NOT_CONNECTED");
  if (acct.tokenExpiresAt.getTime() <= Date.now()) throw new IgError("TOKEN_EXPIRED");
  return acct;
}

/** Stores a freshly exchanged account, clearing any previous revocation. */
export async function saveAccount(shop: string, account: ExchangedAccount) {
  const data = {
    igUserId: account.igUserId,
    username: account.username,
    accessToken: encryptToken(account.token),
    tokenExpiresAt: new Date(Date.now() + account.expiresIn * 1000),
    revokedAt: null,
    lastError: null,
    // A new connection may be a different account, so the old listing is junk.
    mediaCache: null,
    mediaCachedAt: null,
  };
  return db.instagramAccount.upsert({ where: { shop }, create: { shop, ...data }, update: data });
}

/**
 * Marks an account disconnected without deleting the row.
 *
 * Imported videos keep their sourceIgShortcode, so the admin can still see
 * where they came from after the merchant unlinks.
 */
export async function revokeAccount(shop: string) {
  await db.instagramAccount.updateMany({
    where: { shop },
    data: { revokedAt: new Date(), accessToken: "", mediaCache: null, mediaCachedAt: null },
  });
}

// ─── Media ────────────────────────────────────────────────────────────────────

export type IgMedia = {
  id: string;
  caption?: string;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  media_product_type?: "FEED" | "REELS" | "STORY" | "AD";
  /**
   * ABSENT when the video's audio is copyrighted or licensed — including any
   * track from Instagram's own audio library — or when the post has been
   * flagged for a copyright violation. Its absence is the signal that a reel
   * cannot be imported; there is no workaround and we do not look for one.
   */
  media_url?: string;
  thumbnail_url?: string;
  permalink: string;
  timestamp: string;
};

const MEDIA_FIELDS = [
  "id",
  "caption",
  "media_type",
  "media_product_type",
  "media_url",
  "thumbnail_url",
  "permalink",
  "timestamp",
].join(",");

/** Maps a Meta error payload onto our codes. */
function throwApiError(error: any): never {
  const code = Number(error?.code);
  // 4 = application request limit, 17 = user request limit, 32 = page limit.
  if (code === 4 || code === 17 || code === 32) throw new IgError("RATE_LIMITED");
  // 190 = invalid or expired access token.
  if (code === 190) throw new IgError("TOKEN_EXPIRED");
  throw new IgError("API_ERROR", redactSecrets(String(error?.message ?? "Instagram API error")));
}

/**
 * Lists the connected account's reels, newest first.
 *
 * Cached because Meta allows roughly 200 calls per hour per account and the
 * picker would otherwise spend that budget on page renders. The walk is capped
 * at four pages — a merchant with two thousand posts should not cost forty
 * calls to show a grid.
 */
export async function listReels(
  shop: string,
  opts: { force?: boolean } = {}
): Promise<IgMedia[]> {
  const acct = await requireAccount(shop);

  const fresh =
    acct.mediaCachedAt && Date.now() - acct.mediaCachedAt.getTime() < MEDIA_CACHE_MS;
  if (fresh && !opts.force && acct.mediaCache) {
    try {
      return JSON.parse(acct.mediaCache) as IgMedia[];
    } catch {
      // Corrupt cache is not worth failing over — fall through and refetch.
    }
  }

  const token = decryptToken(acct.accessToken);
  const items: IgMedia[] = [];
  let next: string | null = `${GRAPH}/me/media?fields=${MEDIA_FIELDS}&limit=50&access_token=${token}`;

  for (let page = 0; next && page < 4; page++) {
    const res: any = await fetch(next).then((r) => r.json());
    if (res?.error) throwApiError(res.error);
    items.push(...((res?.data ?? []) as IgMedia[]));
    next = res?.paging?.next ?? null;
  }

  // /me/media returns everything on the account. Reels are the point, but a
  // plain feed video is importable too and merchants expect to see it.
  const reels = items.filter(
    (m) => m.media_product_type === "REELS" || m.media_type === "VIDEO"
  );

  await db.instagramAccount.update({
    where: { shop },
    data: { mediaCache: JSON.stringify(reels), mediaCachedAt: new Date() },
  });

  return reels;
}

/** Pulls the shortcode out of any Instagram post, reel or TV URL. */
export function extractShortcode(input: string): string | null {
  const m = String(input).match(/instagram\.com\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

export type ResolveResult =
  | { ok: true; media: IgMedia }
  | { ok: false; code: IgErrorCode; media?: IgMedia };

/**
 * Resolves a pasted link against the connected account.
 *
 * Match, never fetch. NOT_YOURS is a plain negative result: we failed to find
 * the shortcode in a list we were authorised to read. No request is issued for
 * the pasted URL itself, which is what keeps this on the right side of
 * Instagram's terms regardless of what the merchant pastes.
 */
export async function resolveByLink(shop: string, link: string): Promise<ResolveResult> {
  const shortcode = extractShortcode(link);
  if (!shortcode) return { ok: false, code: "NOT_A_REEL_LINK" };

  const find = (list: IgMedia[]) =>
    list.find((m) => extractShortcode(m.permalink) === shortcode);

  let hit = find(await listReels(shop));

  // A reel posted in the last few minutes won't be in a 15-minute-old cache.
  if (!hit) hit = find(await listReels(shop, { force: true }));

  if (!hit) return { ok: false, code: "NOT_YOURS" };
  if (!hit.media_url) return { ok: false, code: "LICENSED_AUDIO", media: hit };
  return { ok: true, media: hit };
}

/**
 * Downloads one reel into memory, ready for uploadToR2.
 *
 * Re-reads the media from Meta rather than trusting a cached media_url: those
 * CDN links expire within hours and the cache can be fifteen minutes old.
 */
export async function fetchReelBuffer(
  shop: string,
  mediaId: string
): Promise<{ media: IgMedia; buffer: Buffer }> {
  const acct = await requireAccount(shop);

  const media: any = await fetch(
    `${GRAPH}/${encodeURIComponent(mediaId)}?fields=${MEDIA_FIELDS}` +
      `&access_token=${decryptToken(acct.accessToken)}`
  ).then((r) => r.json());
  if (media?.error) throwApiError(media.error);
  if (!media?.media_url) throw new IgError("LICENSED_AUDIO");

  const res = await fetch(media.media_url);
  if (!res.ok) throw new IgError("CDN_FETCH_FAILED", `HTTP ${res.status}`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_IMPORT_BYTES) throw new IgError("TOO_LARGE");

  const buffer = Buffer.from(await res.arrayBuffer());
  // Content-length is advisory; check what actually arrived too.
  if (buffer.byteLength > MAX_IMPORT_BYTES) throw new IgError("TOO_LARGE");

  return { media: media as IgMedia, buffer };
}

/** First line of the caption, trimmed to something usable as a video title. */
export function titleFromCaption(caption?: string): string {
  return (caption ?? "").split("\n")[0].trim().slice(0, 80);
}
