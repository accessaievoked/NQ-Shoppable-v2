/**
 * Products with Videos — push a video into the Shopify product's own media
 * gallery (the carousel beside the price and Add to Cart) and control where it
 * sits in that gallery.
 *
 * Distinct from the storefront carousel: that's our section, placed wherever
 * the merchant drops it. This is the theme's native gallery, which only renders
 * media attached to the product in Shopify.
 *
 * Clicking a product row opens a panel with three views:
 *   list    — what's on the product page now, with Remove per item
 *   add     — pick from the whole video library and push several at once
 *   arrange — the full gallery, images included, drag or type a position
 */

import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useFetcher, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  pushVideoToProduct,
  autoAddMissingVideos,
  syncPendingProductMedia,
  getProductGallery,
  getProductGalleries,
  reorderProductMedia,
  detachVideoFromProduct,
  type ProductGallery,
} from "../shopifyMedia.server";

type LinkRow = {
  id: string;
  videoId: string;
  productId: string;
  status: string;
  lastError: string | null;
};

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Push anything tagged to a product that hasn't been sent yet — videos from
  // before this feature existed, or whose upload-time auto-add didn't run.
  // Bounded per load so one visit can't kick off dozens of uploads.
  try {
    await autoAddMissingVideos(admin, shop, 5);
  } catch (err) {
    console.error("[ProductMedia] auto-add on load failed:", err);
  }

  // Advance any in-flight imports before rendering. Transcoding usually
  // finishes in seconds, so doing it on page load avoids needing a scheduler.
  try {
    await syncPendingProductMedia(admin, shop);
  } catch (err) {
    console.error("[ProductMedia] sync on load failed:", err);
  }

  const videos = await db.video.findMany({
    where: { shop },
    // Tie-break on createdAt — see the note in app._index.tsx.
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const links: LinkRow[] = await db.productMedia.findMany({ where: { shop } });

  // A product's media is the union of two things, and missing the second was a
  // bug: videos TAGGED to it (Video.productId), and videos LINKED to it via
  // ProductMedia. Adding a video from another product creates a link without
  // changing its tag — so a tag-only view showed the picker ticking it while
  // the list stayed empty.
  const videoById = new Map(videos.map((v) => [v.id, v]));
  const byProduct = new Map<string, Set<string>>();

  const addTo = (productId: string, videoId: string) => {
    if (!productId) return;
    const set = byProduct.get(productId) ?? new Set<string>();
    set.add(videoId);
    byProduct.set(productId, set);
  };

  for (const v of videos) addTo(v.productId, v.id);
  for (const l of links) {
    if (l.status !== "REMOVED") addTo(l.productId, l.videoId);
  }

  // One batched request per 50 products instead of one per product. Fanning
  // out individually made this page slow enough on a large catalogue that it
  // never finished loading.
  const galleries = await getProductGalleries(admin, Array.from(byProduct.keys()));

  const rows = Array.from(byProduct.entries()).map(([productId, videoIds]) => {
      const vids = Array.from(videoIds)
        .map((id) => videoById.get(id))
        .filter((v): v is (typeof videos)[number] => Boolean(v));

      const gallery: ProductGallery | null = galleries.get(productId) ?? null;

      // REMOVED rows are tombstones recording a deliberate removal — they stop
      // the auto-add putting the video back, but they aren't "on the page".
      const linksHere = links.filter(
        (l) => l.productId === productId && l.status !== "REMOVED"
      );

      return {
        productId,
        // gallery === null means the product was deleted or unpublished after
        // we stored its ID. Surfaced explicitly rather than rendered as a blank
        // row with a NaN price.
        missing: gallery === null,
        title: gallery?.title ?? vids[0]?.productTitle ?? "",
        status: gallery?.status ?? null,
        price: gallery?.price ?? null,
        currency: gallery?.currency ?? null,
        featuredImageUrl: gallery?.featuredImageUrl ?? null,
        galleryCount: gallery?.media.length ?? 0,
        onPageCount: linksHere.filter((l) => l.status === "READY").length,
        pendingCount: linksHere.filter((l) =>
          ["PENDING", "UPLOADED", "PROCESSING"].includes(l.status)
        ).length,
        videos: vids.map((v) => {
          const link = linksHere.find((l) => l.videoId === v.id);
          return {
            id: v.id,
            title: v.title,
            thumbnailUrl: v.thumbnailUrl,
            // previewUrl is the small card clip the pipeline already generates;
            // it's a fraction of the full video's size, so hover playback starts
            // almost immediately. Fall back to the full video when it's absent.
            hoverUrl: v.previewUrl || v.videoUrl || null,
            hasFile: Boolean(v.videoUrl),
            linkId: link?.id ?? null,
            linkStatus: link?.status ?? null,
            linkError: link?.lastError ?? null,
          };
        }),
      };
  });

  // Full library for the "Add media" picker — any video can go on any product.
  const library = videos.map((v) => ({
    id: v.id,
    title: v.title || v.productTitle || "Untitled",
    thumbnailUrl: v.thumbnailUrl,
    hoverUrl: v.previewUrl || v.videoUrl || null,
    productTitle: v.productTitle,
    hasFile: Boolean(v.videoUrl),
  }));

  const linksLite = links
    .filter((l) => l.status !== "REMOVED")
    .map((l) => ({
      id: l.id,
      videoId: l.videoId,
      productId: l.productId,
      status: l.status,
    }));

  return { rows, library, links: linksLite };
};

// ─── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent") as string;

  if (intent === "sync") {
    const productId = form.get("productId") as string;
    const videoIds = JSON.parse((form.get("videoIds") as string) || "[]") as string[];
    const removeLinkIds = JSON.parse((form.get("removeLinkIds") as string) || "[]") as string[];

    // Removals first, so freeing a plan slot can make room for an addition in
    // the same save.
    for (const linkId of removeLinkIds) {
      try {
        await detachVideoFromProduct(admin, shop, linkId);
      } catch (err) {
        console.error(`[ProductMedia] detach failed for ${linkId}:`, err);
      }
    }

    const failures: string[] = [];
    for (const videoId of videoIds) {
      const video = await db.video.findFirst({ where: { id: videoId, shop } });
      if (!video) {
        failures.push("A selected video no longer exists.");
        continue;
      }
      const result = await pushVideoToProduct(admin, shop, video, productId);
      if (!result.ok) failures.push(`${video.title || "Video"}: ${result.error}`);
    }

    // Short clips are often ready immediately — try to finish inline so the
    // merchant sees the result rather than a spinner.
    try {
      await syncPendingProductMedia(admin, shop);
    } catch {
      /* the next poll picks it up */
    }

    return failures.length ? { error: failures.join(" ") } : { ok: true };
  }

  if (intent === "detach") {
    const linkId = form.get("linkId") as string;
    await detachVideoFromProduct(admin, shop, linkId);
    return { ok: true };
  }

  if (intent === "gallery") {
    const productId = form.get("productId") as string;
    const gallery = await getProductGallery(admin, productId);
    if (!gallery) return { error: "That product no longer exists in Shopify." };
    return { gallery };
  }

  if (intent === "reorder") {
    const productId = form.get("productId") as string;
    const ids = JSON.parse((form.get("mediaIds") as string) || "[]") as string[];
    if (!ids.length) return { error: "Nothing to reorder." };
    try {
      const { confirmed } = await reorderProductMedia(admin, productId, ids);
      return confirmed
        ? { ok: true }
        : {
            ok: true,
            warning:
              "Saved, but Shopify is still applying the new order. Give it a minute before checking the storefront.",
          };
    } catch (err: any) {
      return { error: String(err?.message ?? err) };
    }
  }

  return { error: "Unknown action." };
};

// ─── Component ────────────────────────────────────────────────────────────────

type LoaderData = Awaited<ReturnType<typeof loader>>;
type Row = LoaderData["rows"][number];

export default function ProductMedia() {
  const { rows, library, links } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [query, setQuery] = useState("");
  const [openProduct, setOpenProduct] = useState<string | null>(null);

  const filtered = rows.filter((r) =>
    r.title.toLowerCase().includes(query.trim().toLowerCase())
  );

  const anyPending = rows.some((r) => r.pendingCount > 0);

  // Shopify transcodes asynchronously, so poll while anything is in flight.
  useEffect(() => {
    if (!anyPending) return;
    const t = setInterval(() => revalidator.revalidate(), 5000);
    return () => clearInterval(t);
  }, [anyPending, revalidator]);

  const active = rows.find((r) => r.productId === openProduct) ?? null;

  return (
    <s-page heading="Product pages">
      <s-button slot="primary-action" variant="secondary" onClick={() => navigate("/app")}>
        Back to videos
      </s-button>

      <s-section>
        <p style={styles.intro}>
          Add a video to the product's own media gallery — the carousel next to the
          price and Add to Cart button. Separate from the storefront carousel
          section. Click a product to manage its media.
        </p>

        <input
          style={styles.search}
          placeholder="Search by product title..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {filtered.length === 0 ? (
          <div style={styles.empty}>
            {rows.length === 0
              ? "No videos are attached to a product yet."
              : "No products match that search."}
          </div>
        ) : (
          <div style={styles.table}>
            <div style={{ ...styles.tr, ...styles.thead }}>
              <div style={styles.tdProduct}>PRODUCT</div>
              <div style={styles.td}>PRICE</div>
              <div style={styles.td}>PRODUCT STATUS</div>
              <div style={styles.tdMedia}>MEDIA</div>
              <div style={styles.tdActions}>ACTIONS</div>
            </div>

            {filtered.map((row) => (
              <ProductRow
                key={row.productId}
                row={row}
                onOpen={() => setOpenProduct(row.productId)}
              />
            ))}
          </div>
        )}
      </s-section>

      {active && (
        <ProductMediaPanel
          row={active}
          library={library}
          links={links}
          onClose={() => {
            setOpenProduct(null);
            revalidator.revalidate();
          }}
        />
      )}
    </s-page>
  );
}

function ProductRow({ row, onOpen }: { row: Row; onOpen: () => void }) {
  const fetcher = useFetcher<{ error?: string; ok?: boolean }>();

  if (row.missing) {
    return (
      <div style={{ ...styles.tr, ...styles.trMissing }}>
        <div style={styles.tdProduct}>
          <div style={styles.thumbPlaceholder} />
          <div>
            <div style={styles.productTitle}>{row.title || "Unknown product"}</div>
            <div style={styles.missingNote}>
              No longer in Shopify — deleted or unpublished
            </div>
          </div>
        </div>
        <div style={styles.td}>—</div>
        <div style={styles.td}>—</div>
        <div style={styles.tdMedia}>—</div>
        <div style={styles.tdActions}>
          {row.videos
            .filter((v) => v.linkId)
            .map((v) => (
              <fetcher.Form method="post" key={v.id}>
                <input type="hidden" name="intent" value="detach" />
                <input type="hidden" name="linkId" value={v.linkId!} />
                <button type="submit" style={styles.btnGhost} disabled={fetcher.state !== "idle"}>
                  Remove entry
                </button>
              </fetcher.Form>
            ))}
        </div>
      </div>
    );
  }

  const price =
    row.price != null
      ? new Intl.NumberFormat("en-IN", {
          style: "currency",
          currency: row.currency || "INR",
          maximumFractionDigits: 0,
        }).format(Number(row.price))
      : "—";

  // Only videos actually on the product page belong in the MEDIA column.
  const onPage = row.videos.filter((v) => v.linkStatus === "READY");

  return (
    <div style={{ ...styles.tr, ...styles.trClickable }} onClick={onOpen} role="button" tabIndex={0}>
      <div style={styles.tdProduct}>
        {row.featuredImageUrl ? (
          <img src={row.featuredImageUrl} alt="" style={styles.thumb} />
        ) : (
          <div style={styles.thumbPlaceholder} />
        )}
        <div style={styles.productTitle}>{row.title}</div>
      </div>

      <div style={styles.td}>{price}</div>

      <div style={styles.td}>
        <span
          style={{
            ...styles.badge,
            ...(row.status === "ACTIVE" ? styles.badgeActive : styles.badgeMuted),
          }}
        >
          {row.status === "ACTIVE" ? "Active" : row.status ?? "—"}
        </span>
      </div>

      <div style={styles.tdMedia}>
        {onPage.length > 0 ? (
          <div style={styles.mediaStrip}>
            {onPage.slice(0, 4).map((v) => (
              <HoverPreview
                key={v.id}
                thumbnailUrl={v.thumbnailUrl}
                hoverUrl={v.hoverUrl}
                alt={v.title}
                width={44}
                height={58}
              />
            ))}
            {onPage.length > 4 && (
              <span style={styles.moreChip}>+{onPage.length - 4}</span>
            )}
          </div>
        ) : row.pendingCount > 0 ? (
          <span style={styles.stateBusy}>Processing…</span>
        ) : (
          <span style={styles.muted}>—</span>
        )}
      </div>

      <div style={styles.tdActions}>
        <button type="button" style={styles.btnPrimary} onClick={onOpen}>
          Manage media
        </button>
      </div>
    </div>
  );
}

// ─── Product media panel (list / add / arrange) ───────────────────────────────

type PanelView = "list" | "add" | "arrange";

function ProductMediaPanel({
  row,
  library,
  links,
  onClose,
}: {
  row: Row;
  library: LoaderData["library"];
  links: LoaderData["links"];
  onClose: () => void;
}) {
  const [view, setView] = useState<PanelView>("list");

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHead}>
          <div>
            <div style={styles.modalTitle}>
              {view === "add"
                ? "Add media"
                : view === "arrange"
                  ? "Arrange media"
                  : "Product page media"}
            </div>
            <div style={styles.modalSub}>{row.title}</div>
          </div>

          <div style={styles.modalHeadActions}>
            {view === "list" ? (
              <>
                <button type="button" style={styles.btnPrimary} onClick={() => setView("add")}>
                  + Add another media
                </button>
                <button
                  type="button"
                  style={styles.btnGhost}
                  onClick={() => setView("arrange")}
                  disabled={row.galleryCount === 0}
                  title={row.galleryCount === 0 ? "This product has no media yet" : undefined}
                >
                  Arrange media
                </button>
              </>
            ) : (
              <button type="button" style={styles.btnGhost} onClick={() => setView("list")}>
                ← Back
              </button>
            )}
            <button type="button" onClick={onClose} style={styles.close} aria-label="Close">
              ✕
            </button>
          </div>
        </div>

        {view === "list" && <MediaListView row={row} />}
        {view === "add" && (
          <AddMediaView
            row={row}
            library={library}
            links={links}
            onDone={() => setView("list")}
          />
        )}
        {view === "arrange" && <ArrangeView productId={row.productId} onDone={() => setView("list")} />}
      </div>
    </div>
  );
}

/** What's currently on the product page, with Remove per item. */
function MediaListView({ row }: { row: Row }) {
  const onPage = row.videos.filter((v) => v.linkStatus);

  return (
    <div style={styles.modalBody}>
      {onPage.length === 0 ? (
        <div style={styles.empty}>
          No videos on this product page yet. Videos are added here automatically
          when you upload them against this product — or use the button above to
          add one from your library.
        </div>
      ) : (
        <div style={styles.grid}>
          {onPage.map((v) => (
            <div key={v.id} style={styles.tile}>
              <HoverPreview
                thumbnailUrl={v.thumbnailUrl}
                hoverUrl={v.hoverUrl}
                alt={v.title}
              />
              <div style={styles.tileBody}>
                {v.linkStatus === "READY" && <span style={styles.stateOk}>On page</span>}
                {["PENDING", "UPLOADED", "PROCESSING"].includes(v.linkStatus ?? "") && (
                  <>
                    <span style={styles.stateBusy}>Processing…</span>
                    {/* A row can sit on PROCESSING because Shopify is still
                        transcoding, or because our status check keeps failing.
                        Those look identical without this. */}
                    {v.linkError && (
                      <span style={styles.stateFail} title={v.linkError}>
                        Last check failed — {v.linkError.slice(0, 60)}
                        {v.linkError.length > 60 ? "…" : ""}
                      </span>
                    )}
                  </>
                )}
                {v.linkStatus === "FAILED" && (
                  <>
                    <span style={styles.stateFail}>Failed</span>
                    {/* Show the reason inline. It was tooltip-only, which meant
                        the card said "Failed" with no way to find out why
                        without knowing to hover. */}
                    {v.linkError && (
                      <span style={styles.failReason} title={v.linkError}>
                        {v.linkError}
                      </span>
                    )}
                    <RetryButton videoId={v.id} productId={row.productId} />
                  </>
                )}
                {v.linkId && <RemoveButton linkId={v.linkId} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Thumbnail that plays its clip on hover.
 *
 * The <video> sits on top of the thumbnail and only becomes visible once it's
 * actually playing — otherwise you get a black flash while the first frame
 * loads. `preload="none"` keeps a grid of these from firing a request each on
 * page load; the source is only set on first hover.
 */
function HoverPreview({
  thumbnailUrl,
  hoverUrl,
  alt,
  width,
  height,
}: {
  thumbnailUrl: string | null;
  hoverUrl: string | null;
  alt?: string;
  width?: number;
  height?: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);

  function onEnter() {
    const el = videoRef.current;
    if (!el || !hoverUrl) return;
    if (!el.src) el.src = hoverUrl; // lazy: first hover only
    const p = el.play();
    if (p && p.catch) p.catch(() => {});
  }

  function onLeave() {
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = 0;
    setPlaying(false);
  }

  const box: React.CSSProperties = {
    ...styles.previewWrap,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
  const media: React.CSSProperties = {
    ...styles.tileImg,
    ...(height ? { height } : {}),
  };

  return (
    <div style={box} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt={alt ?? ""} style={media} />
      ) : (
        <div style={{ ...styles.tileImgPlaceholder, ...(height ? { height } : {}) }} />
      )}
      {hoverUrl && (
        <video
          ref={videoRef}
          muted
          loop
          playsInline
          preload="none"
          onPlaying={() => setPlaying(true)}
          style={{ ...styles.previewVideo, opacity: playing ? 1 : 0 }}
        />
      )}
    </div>
  );
}

/** Re-attempts a push that previously failed. */
function RetryButton({ videoId, productId }: { videoId: string; productId: string }) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (fetcher.data?.ok) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="sync" />
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="videoIds" value={JSON.stringify([videoId])} />
      <input type="hidden" name="removeLinkIds" value="[]" />
      <button type="submit" style={styles.btnGhostSm} disabled={fetcher.state !== "idle"}>
        {fetcher.state !== "idle" ? "Retrying…" : "Retry"}
      </button>
    </fetcher.Form>
  );
}

function RemoveButton({ linkId }: { linkId: string }) {
  const fetcher = useFetcher<{ ok?: boolean }>();
  const revalidator = useRevalidator();

  // Same staleness problem as adding: the panel renders from loader data, so a
  // removal wouldn't visibly do anything until the panel was reopened.
  useEffect(() => {
    if (fetcher.data?.ok) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="detach" />
      <input type="hidden" name="linkId" value={linkId} />
      <button type="submit" style={styles.btnDanger} disabled={fetcher.state !== "idle"}>
        {fetcher.state !== "idle" ? "Removing…" : "Remove"}
      </button>
    </fetcher.Form>
  );
}

/** Pick from the whole video library and push several at once. */
function AddMediaView({
  row,
  library,
  links,
  onDone,
}: {
  row: Row;
  library: LoaderData["library"];
  links: LoaderData["links"];
  onDone: () => void;
}) {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const [query, setQuery] = useState("");

  // Videos currently on this product, keyed by video id -> link id so we can
  // detach the ones that get unticked.
  const hereById = new Map(
    links.filter((l) => l.productId === row.productId).map((l) => [l.videoId, l.id])
  );

  // The grid is a live picture of what's on the page: pre-ticked for anything
  // already there. Ticking adds, unticking removes.
  const [selected, setSelected] = useState<string[]>(() => Array.from(hereById.keys()));

  const alreadyHere = new Set(hereById.keys());

  const options = library
    .filter((v) => v.hasFile)
    .filter((v) =>
      (v.title + " " + v.productTitle).toLowerCase().includes(query.trim().toLowerCase())
    );

  const revalidator = useRevalidator();

  useEffect(() => {
    if (!fetcher.data?.ok) return;
    // Refetch before switching back. The list view renders from the loader's
    // data, so without this the video you just added wouldn't appear until the
    // whole panel was closed and reopened — which reads as "it didn't work".
    revalidator.revalidate();
    onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // Diff against what was on the page when the panel opened.
  const toAdd = selected.filter((id) => !alreadyHere.has(id));
  const toRemoveLinkIds = Array.from(hereById.entries())
    .filter(([videoId]) => !selected.includes(videoId))
    .map(([, linkId]) => linkId);
  const dirty = toAdd.length > 0 || toRemoveLinkIds.length > 0;

  function submit() {
    const fd = new FormData();
    fd.append("intent", "sync");
    fd.append("productId", row.productId);
    fd.append("videoIds", JSON.stringify(toAdd));
    fd.append("removeLinkIds", JSON.stringify(toRemoveLinkIds));
    fetcher.submit(fd, { method: "post" });
  }

  return (
    <>
      <div style={styles.modalBody}>
        <input
          style={styles.search}
          placeholder="Search by video or product title..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {options.length === 0 ? (
          <div style={styles.empty}>
            No videos available yet. Videos still processing don't appear here.
          </div>
        ) : (
          <div style={styles.grid}>
            {options.map((v) => {
              const onThisProduct = alreadyHere.has(v.id);
              const isSelected = selected.includes(v.id);
              return (
                <div
                  key={v.id}
                  onClick={() => toggle(v.id)}
                  title={
                    onThisProduct
                      ? "Already on this product page — selecting it again is harmless"
                      : undefined
                  }
                  style={{
                    ...styles.tile,
                    ...(isSelected ? styles.tileSelected : {}),
                    cursor: "pointer",
                  }}
                >
                  {/* The badge is informational only. Everything stays
                      selectable: any video can go on any product, and pushing
                      one that's already attached returns the existing link
                      without re-uploading, so a wrong badge can never block a
                      legitimate add. */}
                  {onThisProduct && <div style={styles.tileBadge}>On this page</div>}
                  <div
                    style={{
                      ...styles.checkbox,
                      ...(onThisProduct ? { top: "30px" } : {}),
                    }}
                  >
                    {isSelected ? "✓" : ""}
                  </div>
                  <HoverPreview
                    thumbnailUrl={v.thumbnailUrl}
                    hoverUrl={v.hoverUrl}
                    alt={v.title}
                  />
                  <div style={styles.tileCaption}>{v.title}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={styles.modalFoot}>
        {fetcher.data?.error && <span style={styles.stateFail}>{fetcher.data.error}</span>}
        <span style={styles.muted}>
          {toAdd.length > 0 && `${toAdd.length} to add`}
          {toAdd.length > 0 && toRemoveLinkIds.length > 0 && " · "}
          {toRemoveLinkIds.length > 0 && `${toRemoveLinkIds.length} to remove`}
          {!dirty && "No changes"}
        </span>
        <button
          type="button"
          style={styles.btnPrimary}
          onClick={submit}
          disabled={!dirty || fetcher.state !== "idle"}
        >
          {fetcher.state !== "idle" ? "Saving…" : "Save changes"}
        </button>
      </div>
    </>
  );
}

/** Full gallery — images and videos — drag to reorder or type a position. */
function ArrangeView({ productId, onDone }: { productId: string; onDone: () => void }) {
  const load = useFetcher<{ gallery?: ProductGallery; error?: string }>();
  const save = useFetcher<{ ok?: boolean; error?: string; warning?: string }>();
  const [items, setItems] = useState<ProductGallery["media"]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Videos-only by default: a product typically has a dozen near-identical
  // photos and one or two videos, and ordering the videos is the actual job.
  // "All media" is there for when the video's position among the photos matters.
  const [videosOnly, setVideosOnly] = useState(true);

  useEffect(() => {
    const fd = new FormData();
    fd.append("intent", "gallery");
    fd.append("productId", productId);
    load.submit(fd, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  useEffect(() => {
    if (load.data?.gallery) setItems(load.data.gallery.media);
  }, [load.data]);

  useEffect(() => {
    if (save.data?.ok && !save.data.warning) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save.data]);

  // What's shown and dragged. In videos-only mode this is a subset, so moves
  // have to be mapped back onto the full gallery before saving.
  const visible = videosOnly ? items.filter((i) => i.type === "VIDEO") : items;

  function move(from: number, to: number) {
    const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));

    if (!videosOnly) {
      setItems((prev) => {
        const next = [...prev];
        const [item] = next.splice(from, 1);
        next.splice(clamp(to, next.length), 0, item);
        return next;
      });
      return;
    }

    // Videos-only: reorder the videos among themselves, then drop them back
    // into the exact slots videos already occupied in the full gallery. Photos
    // never move, so the merchant can't accidentally reshuffle their product
    // shots while arranging videos.
    setItems((prev) => {
      const slots = prev.map((m, i) => (m.type === "VIDEO" ? i : -1)).filter((i) => i >= 0);
      const vids = slots.map((i) => prev[i]);
      const [moved] = vids.splice(from, 1);
      vids.splice(clamp(to, vids.length), 0, moved);

      const next = [...prev];
      slots.forEach((slot, n) => {
        next[slot] = vids[n];
      });
      return next;
    });
  }

  function handleSave() {
    const fd = new FormData();
    fd.append("intent", "reorder");
    fd.append("productId", productId);
    // Always send the full gallery order — productReorderMedia positions are
    // absolute across all media, not per type.
    fd.append("mediaIds", JSON.stringify(items.map((i) => i.id)));
    save.submit(fd, { method: "post" });
  }

  // Position 1 isn't only the gallery — it becomes the product's primary image
  // on collection pages, search results and cart thumbnails.
  const videoFirst = items[0]?.type === "VIDEO";

  return (
    <>
      <div style={styles.modalBody}>
        {load.state !== "idle" && !items.length && <p>Loading gallery…</p>}
        {load.data?.error && <p style={styles.stateFail}>{load.data.error}</p>}

        {items.length > 0 && (
          <>
            <div style={styles.arrangeBar}>
              <div style={styles.toggle}>
                <button
                  type="button"
                  onClick={() => setVideosOnly(true)}
                  style={videosOnly ? styles.toggleOn : styles.toggleOff}
                >
                  Videos ({items.filter((i) => i.type === "VIDEO").length})
                </button>
                <button
                  type="button"
                  onClick={() => setVideosOnly(false)}
                  style={!videosOnly ? styles.toggleOn : styles.toggleOff}
                >
                  All media ({items.length})
                </button>
              </div>
            </div>

            <p style={styles.modalHint}>
              {videosOnly
                ? "Drag a tile, or type a number, to set the order the videos appear in. Photos stay where they are."
                : "Drag a tile, or type a number to move it there. Position 1 is the product's main media everywhere — collection pages, search results and cart thumbnails."}
            </p>

            {videosOnly && visible.length === 0 && (
              <div style={styles.empty}>
                No videos on this product page yet. Add one from “+ Add another
                media”, then come back here to order them.
              </div>
            )}

            {!videosOnly && videoFirst && (
              <div style={styles.warn}>
                A video is in position 1, so it replaces the product photo as the
                thumbnail across the storefront. Move an image first if that isn't
                what you want.
              </div>
            )}

            <div style={styles.grid}>
              {visible.map((item, index) => (
                <div
                  key={item.id}
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIndex !== null && dragIndex !== index) move(dragIndex, index);
                    setDragIndex(null);
                  }}
                  style={{ ...styles.tile, opacity: dragIndex === index ? 0.4 : 1 }}
                >
                  <div style={styles.dragHandle}>⠿</div>
                  <HoverPreview
                    thumbnailUrl={item.previewUrl}
                    hoverUrl={item.hoverUrl}
                    alt={item.alt ?? ""}
                  />
                  {/* Videos are easy to lose in a long gallery of product
                      shots, and new media lands at the end — so mark them
                      clearly on the tile itself, not just in the footer. */}
                  {item.type === "VIDEO" && <div style={styles.videoBadge}>▶ Video</div>}
                  <div style={styles.tileFoot}>
                    <input
                      type="number"
                      min={1}
                      max={visible.length}
                      value={index + 1}
                      onChange={(e) => {
                        const to = Number(e.target.value) - 1;
                        if (!Number.isNaN(to) && to !== index) move(index, to);
                      }}
                      style={styles.posInput}
                      aria-label="Position"
                    />
                    {item.type === "VIDEO" && <span style={styles.tileTag}>Video</span>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div style={styles.modalFoot}>
        {save.data?.error && <span style={styles.stateFail}>{save.data.error}</span>}
        {save.data?.warning && <span style={styles.stateBusy}>{save.data.warning}</span>}
        <button type="button" onClick={onDone} style={styles.btnGhost}>
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          style={styles.btnPrimary}
          disabled={save.state !== "idle" || items.length === 0}
        >
          {save.state !== "idle" ? "Saving…" : "Save order"}
        </button>
      </div>
    </>
  );
}

export const headers: any = (headersArgs: any) => boundary.headers(headersArgs);

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  intro: { fontSize: "13px", color: "#616161", margin: "0 0 14px", lineHeight: 1.5 },
  search: {
    width: "100%",
    padding: "9px 12px",
    borderRadius: "8px",
    border: "1px solid #d0d5dd",
    fontSize: "13px",
    marginBottom: "16px",
  },
  empty: { padding: "40px", textAlign: "center", color: "#8a8a8a", fontSize: "14px" },
  muted: { color: "#8a8a8a", fontSize: "12px" },
  table: { border: "1px solid #e3e3e3", borderRadius: "10px", overflow: "hidden" },
  tr: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px 14px",
    borderBottom: "1px solid #f0f0f0",
    fontSize: "13px",
  },
  trClickable: { cursor: "pointer" },
  trMissing: { background: "#fff8f8" },
  thead: {
    background: "#f7f9fb",
    fontSize: "11px",
    letterSpacing: "0.04em",
    color: "#6b7280",
    fontWeight: 600,
  },
  tdProduct: { flex: "2 1 220px", display: "flex", alignItems: "center", gap: "10px", minWidth: 0 },
  td: { flex: "1 1 90px", minWidth: 0 },
  tdMedia: { flex: "1 1 150px", minWidth: 0 },
  mediaStrip: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
  moreChip: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "34px",
    height: "34px",
    borderRadius: "50%",
    background: "#fdeef2",
    color: "#c2185b",
    fontSize: "12px",
    fontWeight: 700,
    flexShrink: 0,
  },
  arrangeBar: { display: "flex", justifyContent: "flex-start", marginBottom: "10px" },
  toggle: {
    display: "inline-flex",
    background: "#f1f3f6",
    borderRadius: "999px",
    padding: "3px",
    gap: "2px",
  },
  toggleOn: {
    border: "none",
    borderRadius: "999px",
    padding: "6px 14px",
    fontSize: "12px",
    fontWeight: 600,
    background: "#1a1a1a",
    color: "#fff",
    cursor: "pointer",
  },
  toggleOff: {
    border: "none",
    borderRadius: "999px",
    padding: "6px 14px",
    fontSize: "12px",
    fontWeight: 600,
    background: "transparent",
    color: "#4b5563",
    cursor: "pointer",
  },
  tdActions: { flex: "0 0 150px", display: "flex", justifyContent: "flex-end", gap: "6px" },
  thumb: { width: "40px", height: "40px", objectFit: "cover", borderRadius: "6px", background: "#f0f0f0" },
  thumbPlaceholder: { width: "40px", height: "40px", borderRadius: "6px", background: "#eceff3" },
  productTitle: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  missingNote: { fontSize: "11px", color: "#b42318", marginTop: "2px" },
  badge: { padding: "3px 9px", borderRadius: "999px", fontSize: "11px", fontWeight: 600 },
  badgeActive: { background: "#e7f7ed", color: "#1a7f45" },
  badgeMuted: { background: "#fdf2e3", color: "#a5620a" },
  stateOk: { fontSize: "11px", color: "#1a7f45", fontWeight: 600 },
  stateBusy: { fontSize: "11px", color: "#a5620a", fontWeight: 600 },
  stateFail: { fontSize: "11px", color: "#b42318", fontWeight: 600 },
  failReason: {
    fontSize: "10.5px",
    color: "#b42318",
    lineHeight: 1.35,
    display: "block",
    // Long plan-cap messages shouldn't stretch the tile.
    maxHeight: "58px",
    overflow: "hidden",
  },
  btnPrimary: {
    padding: "7px 14px",
    borderRadius: "8px",
    border: "none",
    background: "#1a1a1a",
    color: "#fff",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
  },
  btnGhost: {
    padding: "7px 14px",
    borderRadius: "8px",
    border: "1px solid #d0d5dd",
    background: "#fff",
    fontSize: "12px",
    cursor: "pointer",
  },
  btnDanger: {
    padding: "5px 12px",
    borderRadius: "6px",
    border: "1px solid #f1c4c0",
    background: "#fff5f4",
    color: "#b42318",
    fontSize: "11px",
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 999,
  },
  modal: {
    background: "#fff",
    borderRadius: "12px",
    width: "min(1000px, 94vw)",
    maxHeight: "88vh",
    display: "flex",
    flexDirection: "column",
  },
  modalHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 18px",
    borderBottom: "1px solid #ececec",
    gap: "12px",
  },
  modalTitle: { fontWeight: 700, fontSize: "15px" },
  modalSub: { fontSize: "12px", color: "#6b7280", marginTop: "2px" },
  modalHeadActions: { display: "flex", alignItems: "center", gap: "8px" },
  modalBody: { padding: "18px", overflowY: "auto", flex: 1 },
  modalFoot: {
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: "10px",
    padding: "12px 18px",
    borderTop: "1px solid #ececec",
  },
  modalHint: { fontSize: "12px", color: "#616161", margin: "0 0 10px" },
  warn: {
    background: "#fff6e8",
    border: "1px solid #e0a048",
    borderRadius: "8px",
    padding: "9px 12px",
    fontSize: "12px",
    marginBottom: "12px",
  },
  close: { border: "none", background: "none", fontSize: "16px", cursor: "pointer" },
  grid: { display: "flex", flexWrap: "wrap", gap: "12px" },
  tile: {
    width: "190px",
    borderRadius: "10px",
    border: "1px solid #e3e3e3",
    overflow: "hidden",
    background: "#fff",
    position: "relative",
  },
  tileSelected: { border: "2px solid #1a1a1a", boxShadow: "0 0 0 3px rgba(0,0,0,0.06)" },
  tileDisabled: { opacity: 0.55 },
  videoBadge: {
    position: "absolute",
    top: "6px",
    right: "6px",
    zIndex: 2,
    background: "#1a1a1a",
    color: "#fff",
    borderRadius: "999px",
    padding: "2px 9px",
    fontSize: "10px",
    fontWeight: 700,
  },
  tileBadge: {
    position: "absolute",
    top: "6px",
    left: "6px",
    zIndex: 2,
    background: "#e7f7ed",
    color: "#1a7f45",
    borderRadius: "999px",
    padding: "2px 8px",
    fontSize: "10px",
    fontWeight: 700,
  },
  tileImg: { width: "100%", height: "250px", objectFit: "cover", display: "block" },
  tileImgPlaceholder: { width: "100%", height: "250px", background: "#eceff3" },
  // Positioning context so the hover <video> can sit exactly over the thumbnail.
  previewWrap: { position: "relative", width: "100%", overflow: "hidden", background: "#eceff3" },
  previewVideo: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
    // Faded in only once playback actually starts, so there's no black frame
    // while the clip loads.
    transition: "opacity 160ms ease",
    pointerEvents: "none",
  },
  tileBody: { padding: "8px", display: "flex", flexDirection: "column", gap: "6px", alignItems: "flex-start" },
  tileCaption: {
    padding: "6px 8px",
    fontSize: "11px",
    color: "#4b5563",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  tileFoot: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 8px",
    gap: "6px",
  },
  tileTag: { fontSize: "10px", color: "#5c6672" },
  posInput: {
    width: "46px",
    padding: "3px 6px",
    borderRadius: "6px",
    border: "1px solid #d0d5dd",
    fontSize: "12px",
    textAlign: "center",
  },
  dragHandle: {
    position: "absolute",
    top: "6px",
    left: "6px",
    background: "rgba(255,255,255,0.9)",
    borderRadius: "6px",
    padding: "1px 5px",
    fontSize: "12px",
    cursor: "grab",
    zIndex: 2,
  },
  checkbox: {
    position: "absolute",
    top: "6px",
    left: "6px",
    width: "18px",
    height: "18px",
    borderRadius: "4px",
    background: "#fff",
    border: "1px solid #c9ced6",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "12px",
    fontWeight: 700,
    zIndex: 2,
  },
};
