/**
 * Import from Instagram — pick reels from the merchant's own connected account
 * and pull them into the library.
 *
 * Ownership is settled before this screen is ever useful: everything listed
 * here came from /me/media on an account the merchant authorised, so there is
 * no handle to type and no link to validate. The paste-a-link box at the bottom
 * is a convenience that resolves against that same list — it never fetches the
 * pasted URL.
 *
 * Once a reel's bytes are in R2 the flow is identical to a browser upload:
 * same Video row, same ffmpeg pass, same storefront block. Product-page
 * placement is deliberately NOT handled here — videos reach product pages
 * through the Product pages screen, and pushing to Shopify's gallery stays an
 * opt-in choice per that screen.
 */

import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  useLoaderData,
  useNavigate,
  useFetcher,
  useRouteError,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { uploadToR2, deleteFromR2ByUrl } from "../r2.server";
import { processVideo } from "../ffmpeg.server";
import {
  getAccount,
  listReels,
  resolveByLink,
  fetchReelBuffer,
  extractShortcode,
  titleFromCaption,
  IgError,
  IG_ERROR_MESSAGES,
  type IgMedia,
  type IgErrorCode,
} from "../instagram.server";

type ReelCard = {
  id: string;
  shortcode: string;
  title: string;
  thumbnailUrl: string | null;
  permalink: string;
  timestamp: string;
  /** False when Instagram withheld media_url — licensed or copyrighted audio. */
  importable: boolean;
  /** Already in the library; shows as imported rather than selectable. */
  imported: boolean;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const account = await getAccount(shop);
  if (!account) {
    return { connected: null, reels: [] as ReelCard[], loadError: null, counts: null };
  }

  const force = new URL(request.url).searchParams.get("refresh") === "1";

  let reels: ReelCard[] = [];
  let loadError: string | null = null;

  try {
    const media = await listReels(shop, { force });

    // One query for every shortcode we're about to show, rather than one per
    // card. The [shop, sourceIgShortcode] index makes this cheap.
    const shortcodes = media
      .map((m) => extractShortcode(m.permalink))
      .filter((s): s is string => Boolean(s));
    const existing = await db.video.findMany({
      where: { shop, sourceIgShortcode: { in: shortcodes } },
      select: { sourceIgShortcode: true },
    });
    const importedSet = new Set(existing.map((v) => v.sourceIgShortcode));

    reels = media
      .map((m: IgMedia): ReelCard | null => {
        const shortcode = extractShortcode(m.permalink);
        if (!shortcode) return null;
        return {
          id: m.id,
          shortcode,
          title: titleFromCaption(m.caption) || "Untitled reel",
          thumbnailUrl: m.thumbnail_url ?? null,
          permalink: m.permalink,
          timestamp: m.timestamp,
          importable: Boolean(m.media_url),
          imported: importedSet.has(shortcode),
        };
      })
      .filter((r): r is ReelCard => r !== null);
  } catch (err) {
    loadError =
      err instanceof IgError
        ? IG_ERROR_MESSAGES[err.code]
        : "Couldn't read your Instagram reels. Try again in a moment.";
  }

  return {
    connected: { username: account.username },
    reels,
    loadError,
    counts: {
      total: reels.length,
      blocked: reels.filter((r) => !r.importable).length,
      imported: reels.filter((r) => r.imported).length,
    },
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

/** Shared tail: everything after the bytes are in R2 is a normal upload. */
async function createVideoFromBuffer(params: {
  shop: string;
  buffer: Buffer;
  media: IgMedia;
  shortcode: string;
}): Promise<{ ok: true; videoId: string } | { ok: false; error: string }> {
  const { shop, buffer, media, shortcode } = params;

  // Provenance, not URL, is the duplicate key here. Every import writes a fresh
  // R2 object, so the videoUrl check the upload path uses would never match.
  const dupe = await db.video.findFirst({
    where: { shop, sourceIgShortcode: shortcode },
    select: { id: true },
  });
  if (dupe) return { ok: false, error: "That reel has already been imported." };

  const videoUrl = await uploadToR2(
    `videos/${Date.now()}-ig-${shortcode}.mp4`,
    buffer,
    "video/mp4"
  );

  const title = titleFromCaption(media.caption) || "Instagram reel";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
  const baseKey = `${Date.now()}-${slug || "reel"}`;

  const video = await db.video.create({
    data: {
      shop,
      title,
      videoUrl,
      streamUrl: null,
      thumbnailUrl: "",
      sourceIgShortcode: shortcode,
      sourceIgPermalink: media.permalink,
    },
  });

  // Background processing, deliberately not awaited — same reasoning as the
  // upload route: holding the response open for a long encode returns a 502
  // through Fly's proxy.
  let lastWrite = 0;
  const onProgress = (pct: number) => {
    const now = Date.now();
    if (now - lastWrite < 2000) return;
    lastWrite = now;
    db.video
      .update({ where: { id: video.id }, data: { processingProgress: pct } })
      .catch(() => {});
  };

  processVideo(videoUrl, baseKey, onProgress)
    .then(async (processed) => {
      await db.video.update({
        where: { id: video.id },
        data: {
          videoUrl: processed.compressedUrl,
          streamUrl: processed.streamUrl,
          previewUrl: processed.previewUrl,
          thumbnailUrl: processed.thumbnailUrl,
          duration: processed.durationSeconds,
          processingProgress: 100,
          processingError: null,
        },
      });

      // We wrote the raw object ourselves, so it's ours to remove once the
      // compressed copy is recorded. After the DB update, never before.
      if (videoUrl && videoUrl !== processed.compressedUrl) {
        try {
          await deleteFromR2ByUrl(videoUrl);
        } catch (cleanupErr) {
          console.warn(`[Instagram] Could not delete raw import for ${video.id}:`, cleanupErr);
        }
      }

      console.log(`[Instagram] Imported ${shortcode} as video ${video.id}`);
    })
    .catch(async (err) => {
      console.error(`[Instagram] Processing failed for ${video.id}:`, err);
      await db.video
        .update({
          where: { id: video.id },
          data: { processingError: String(err?.message ?? err).slice(0, 300) },
        })
        .catch(() => {});
    });

  return { ok: true, videoId: video.id };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "import") {
      const ids = JSON.parse(String(form.get("mediaIds") ?? "[]")) as string[];
      if (!ids.length) return { error: "Select at least one reel." };

      const failures: string[] = [];
      let imported = 0;

      // Sequential on purpose. Each import downloads a video and then hands it
      // to ffmpeg; five at once is what saturated a 1GB machine last time.
      for (const mediaId of ids) {
        try {
          const { media, buffer } = await fetchReelBuffer(shop, mediaId);
          const shortcode = extractShortcode(media.permalink);
          if (!shortcode) {
            failures.push("A reel had an unreadable permalink.");
            continue;
          }
          const result = await createVideoFromBuffer({ shop, buffer, media, shortcode });
          if (result.ok) imported++;
          else failures.push(result.error);
        } catch (err) {
          failures.push(
            err instanceof IgError
              ? IG_ERROR_MESSAGES[err.code]
              : `Import failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`
          );
        }
      }

      if (imported === 0) return { error: failures.join(" ") || "Nothing imported." };
      return {
        ok: true,
        imported,
        // Partial success is still success — say what got through and what didn't.
        warning: failures.length ? failures.join(" ") : null,
      };
    }

    if (intent === "importLink") {
      const link = String(form.get("link") ?? "").trim();
      const resolved = await resolveByLink(shop, link);

      if (!resolved.ok) {
        const code: IgErrorCode = resolved.code;
        // NOT_YOURS is worth naming the account in — "that isn't yours" reads
        // as an accusation unless we say which account we checked.
        const account = await getAccount(shop);
        const message =
          code === "NOT_YOURS" && account
            ? `That reel isn't on @${account.username}. You can only import reels posted by the connected account.`
            : IG_ERROR_MESSAGES[code];
        return { error: message };
      }

      const shortcode = extractShortcode(resolved.media.permalink)!;
      const { media, buffer } = await fetchReelBuffer(shop, resolved.media.id);
      const result = await createVideoFromBuffer({ shop, buffer, media, shortcode });
      if (!result.ok) return { error: result.error };
      return { ok: true, imported: 1, warning: null };
    }
  } catch (err) {
    if (err instanceof IgError) return { error: IG_ERROR_MESSAGES[err.code] };
    console.error("[Instagram] Import action failed:", err);
    return { error: "Something went wrong. Try again." };
  }

  return { error: "Unknown action." };
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function InstagramImport() {
  const { connected, reels, loadError, counts } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [link, setLink] = useState("");
  const linkRef = useRef<HTMLInputElement>(null);

  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  // Refresh the grid after an import so the newly-imported reels flip to their
  // "Imported" state instead of inviting a second click.
  useEffect(() => {
    if (result && "ok" in result && result.ok) {
      setSelected(new Set());
      setLink("");
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submitImport = () => {
    fetcher.submit(
      { intent: "import", mediaIds: JSON.stringify(Array.from(selected)) },
      { method: "post" }
    );
  };

  const submitLink = () => {
    if (!link.trim()) {
      linkRef.current?.focus();
      return;
    }
    fetcher.submit({ intent: "importLink", link }, { method: "post" });
  };

  // ── Not connected ────────────────────────────────────────────────────────
  if (!connected) {
    return (
      <s-page heading="Import from Instagram">
        <s-section>
          <div style={styles.empty}>
            <p style={styles.emptyText}>
              Connect an Instagram Business or Creator account to import reels.
            </p>
            <s-button variant="primary" onClick={() => navigate("/app/instagram")}>
              Go to Instagram settings
            </s-button>
          </div>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Import from Instagram">
      <s-button slot="secondary-actions" variant="secondary" onClick={() => navigate("/app")}>
        Back to videos
      </s-button>

      <s-section>
        <div style={styles.headerRow}>
          <div>
            <div style={styles.handle}>@{connected.username}</div>
            {counts && (
              <div style={styles.muted}>
                {counts.total} reel{counts.total === 1 ? "" : "s"}
                {counts.imported > 0 && ` · ${counts.imported} already imported`}
                {counts.blocked > 0 && ` · ${counts.blocked} can't be imported`}
              </div>
            )}
          </div>
          <button
            type="button"
            style={styles.secondaryBtn}
            disabled={busy}
            onClick={() => navigate("/app/videos/instagram?refresh=1", { replace: true })}
          >
            Refresh
          </button>
        </div>

        {loadError && <div style={{ ...styles.banner, ...styles.bannerError }}>{loadError}</div>}

        {result && "error" in result && result.error && (
          <div style={{ ...styles.banner, ...styles.bannerError }}>{result.error}</div>
        )}

        {result && "ok" in result && result.ok && (
          <div style={{ ...styles.banner, ...styles.bannerOk }}>
            Importing {result.imported} reel{result.imported === 1 ? "" : "s"}. They'll appear in
            your library and finish processing in the background.
            {result.warning ? ` ${result.warning}` : ""}
          </div>
        )}

        {counts && counts.blocked > 0 && (
          <div style={{ ...styles.banner, ...styles.bannerWarn }}>
            {counts.blocked} reel{counts.blocked === 1 ? "" : "s"} can't be downloaded because
            Instagram doesn't allow it for videos using licensed audio — including tracks from
            Instagram's own audio library. Upload those as files instead.
          </div>
        )}

        {reels.length === 0 && !loadError ? (
          <div style={styles.empty}>
            <p style={styles.emptyText}>No reels found on this account.</p>
          </div>
        ) : (
          <div style={styles.grid}>
            {reels.map((reel) => {
              const isSelected = selected.has(reel.id);
              const disabled = !reel.importable || reel.imported;
              return (
                <div
                  key={reel.id}
                  style={{
                    ...styles.card,
                    ...(isSelected ? styles.cardSelected : null),
                    ...(disabled ? styles.cardDisabled : null),
                  }}
                  onClick={() => !disabled && toggle(reel.id)}
                  role="button"
                  tabIndex={disabled ? -1 : 0}
                  aria-disabled={disabled}
                >
                  <div style={styles.thumbWrap}>
                    {reel.thumbnailUrl ? (
                      <img src={reel.thumbnailUrl} alt="" style={styles.thumb} />
                    ) : (
                      <div style={styles.thumbPlaceholder} />
                    )}
                    {isSelected && <span style={styles.tick}>✓</span>}
                    {reel.imported && <span style={styles.chipDone}>Imported</span>}
                    {!reel.importable && !reel.imported && (
                      <span style={styles.chipBlocked}>Licensed audio</span>
                    )}
                  </div>
                  <div style={styles.cardTitle}>{reel.title}</div>
                  <div style={styles.cardMeta}>
                    {new Date(reel.timestamp).toLocaleDateString()}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div style={styles.footer}>
          <button
            type="button"
            style={styles.primaryBtn}
            disabled={busy || selected.size === 0}
            onClick={submitImport}
          >
            {busy
              ? "Importing…"
              : `Import ${selected.size || ""} ${selected.size === 1 ? "reel" : "reels"}`.trim()}
          </button>
          {selected.size > 0 && (
            <button type="button" style={styles.linkBtn} onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          )}
        </div>
      </s-section>

      <s-section heading="Or paste a reel link">
        <p style={styles.muted}>
          Only reels posted by @{connected.username} can be imported. We check the link against
          that account rather than opening it.
        </p>
        <div style={styles.linkRow}>
          <input
            ref={linkRef}
            type="url"
            value={link}
            placeholder="https://www.instagram.com/reel/..."
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitLink()}
            style={styles.input}
          />
          <button type="button" style={styles.secondaryBtn} disabled={busy} onClick={submitLink}>
            Import
          </button>
        </div>
      </s-section>
    </s-page>
  );
}

const styles: Record<string, React.CSSProperties> = {
  headerRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "12px",
    marginBottom: "14px",
  },
  handle: { fontSize: "15px", fontWeight: 600, marginBottom: "2px" },
  muted: { color: "#8a8a8a", fontSize: "12px", lineHeight: 1.5 },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))",
    gap: "12px",
    marginBottom: "16px",
  },
  card: {
    border: "1px solid #e3e3e3",
    borderRadius: "10px",
    padding: "8px",
    cursor: "pointer",
    background: "#fff",
  },
  cardSelected: { border: "2px solid #1a1a1a", padding: "7px" },
  cardDisabled: { opacity: 0.45, cursor: "not-allowed" },
  thumbWrap: {
    position: "relative",
    width: "100%",
    aspectRatio: "9 / 16",
    borderRadius: "6px",
    overflow: "hidden",
    background: "#f1f1f1",
    marginBottom: "6px",
  },
  thumb: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  thumbPlaceholder: { width: "100%", height: "100%", background: "#ececec" },
  tick: {
    position: "absolute",
    top: "6px",
    right: "6px",
    background: "#1a1a1a",
    color: "#fff",
    borderRadius: "50%",
    width: "22px",
    height: "22px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "13px",
  },
  chipDone: {
    position: "absolute",
    bottom: "6px",
    left: "6px",
    background: "rgba(12,81,50,0.9)",
    color: "#fff",
    fontSize: "10px",
    padding: "2px 7px",
    borderRadius: "10px",
  },
  chipBlocked: {
    position: "absolute",
    bottom: "6px",
    left: "6px",
    background: "rgba(124,74,0,0.9)",
    color: "#fff",
    fontSize: "10px",
    padding: "2px 7px",
    borderRadius: "10px",
  },
  cardTitle: {
    fontSize: "12px",
    lineHeight: 1.35,
    maxHeight: "32px",
    overflow: "hidden",
    marginBottom: "2px",
  },
  cardMeta: { fontSize: "11px", color: "#8a8a8a" },
  footer: { display: "flex", alignItems: "center", gap: "12px" },
  linkRow: { display: "flex", gap: "8px", marginTop: "10px" },
  input: {
    flex: 1,
    padding: "9px 12px",
    borderRadius: "8px",
    border: "1px solid #d0d5dd",
    fontSize: "13px",
  },
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
  primaryBtn: {
    padding: "9px 16px",
    borderRadius: "8px",
    border: "1px solid #1a1a1a",
    background: "#1a1a1a",
    color: "#fff",
    fontSize: "13px",
    cursor: "pointer",
  },
  secondaryBtn: {
    padding: "8px 14px",
    borderRadius: "8px",
    border: "1px solid #d0d5dd",
    background: "#fff",
    fontSize: "13px",
    cursor: "pointer",
  },
  linkBtn: {
    border: "none",
    background: "none",
    color: "#5f5e5a",
    fontSize: "12px",
    cursor: "pointer",
    textDecoration: "underline",
  },
  empty: { padding: "40px", textAlign: "center", color: "#8a8a8a", fontSize: "14px" },
  emptyText: { marginBottom: "14px" },
};

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
