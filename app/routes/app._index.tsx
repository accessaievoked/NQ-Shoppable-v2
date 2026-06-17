import { useState, useRef, useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData, useNavigate, Form, useNavigation, useSubmit, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { deleteVideoFromR2 } from "../r2.server";

type Filter = "all" | "active" | "inactive";

// ─── Loader ───────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = (url.searchParams.get("filter") ?? "all") as Filter;
  const q = url.searchParams.get("q") ?? "";

  const where: any = { shop: session.shop };
  if (filter === "active")   where.active = true;
  if (filter === "inactive") where.active = false;
  if (q) {
    where.OR = [
      { title: { contains: q } },
      { productTitle: { contains: q } },
    ];
  }

  const [videos, totalActive, totalInactive] = await Promise.all([
    db.video.findMany({
      where,
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        title: true,
        videoUrl: true,
        streamUrl: true,
        thumbnailUrl: true,
        productTitle: true,
        productImageUrl: true,
        productUrl: true,
        variantId: true,
        price: true,
        compareAtPrice: true,
        currency: true,
        active: true,
        sortOrder: true,
        viewCount: true,
        atcCount: true,
      },
    }),
    db.video.count({ where: { shop: session.shop, active: true } }),
    db.video.count({ where: { shop: session.shop, active: false } }),
  ]);

  return { videos, filter, q, totalActive, totalInactive, total: totalActive + totalInactive };
};

// ─── Action ───────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent  = formData.get("intent") as string;
  const videoId = formData.get("videoId") as string;

  if (intent === "delete") {
    const video = await db.video.findFirst({
      where: { id: videoId, shop: session.shop },
      select: { videoUrl: true, thumbnailUrl: true, streamUrl: true },
    });
    if (video) {
      await deleteVideoFromR2({ videoUrl: video.videoUrl, thumbnailUrl: video.thumbnailUrl, streamUrl: video.streamUrl });
      await db.video.delete({ where: { id: videoId } });
    }
  }

  if (intent === "toggle") {
    const video = await db.video.findFirst({ where: { id: videoId, shop: session.shop } });
    if (video) {
      await db.video.update({ where: { id: videoId }, data: { active: !video.active } });
    }
  }

  if (intent === "attach") {
    await db.video.update({
      where: { id: videoId },
      data: {
        variantId:       (formData.get("variantId") as string) || "",
        productTitle:    (formData.get("productTitle") as string) || "",
        productImageUrl: (formData.get("productImageUrl") as string) || "",
        price:           parseFloat(formData.get("price") as string) || null,
        compareAtPrice:  parseFloat(formData.get("compareAtPrice") as string) || null,
        currency:        (formData.get("currency") as string) || "INR",
        productUrl:      (formData.get("productUrl") as string) || "",
      },
    });
  }

  if (intent === "detach") {
    await db.video.update({
      where: { id: videoId },
      data: {
        variantId: "", productTitle: "", productImageUrl: "",
        price: null, compareAtPrice: null, productUrl: "",
      },
    });
  }

  if (intent === "reorder") {
    const direction = formData.get("direction") as "up" | "down";
    const video = await db.video.findFirst({ where: { id: videoId, shop: session.shop } });
    if (video) {
      const adjacent = await db.video.findFirst({
        where: {
          shop: session.shop,
          sortOrder: direction === "up" ? { lt: video.sortOrder } : { gt: video.sortOrder },
        },
        orderBy: { sortOrder: direction === "up" ? "desc" : "asc" },
      });
      if (adjacent) {
        await db.video.update({ where: { id: video.id },    data: { sortOrder: adjacent.sortOrder } });
        await db.video.update({ where: { id: adjacent.id }, data: { sortOrder: video.sortOrder } });
      }
    }
  }

  return null;
};

// ─── Component ────────────────────────────────────────────────────────────────
export default function Index() {
  const { videos, filter, q, total, totalActive, totalInactive } = useLoaderData<typeof loader>();
  const navigate    = useNavigate();
  const navigation  = useNavigation();
  const submit      = useSubmit();
  const shopify     = useAppBridge();
  const isSubmitting = navigation.state === "submitting";

  const [search, setSearch] = useState(q);
  const [playingVideo, setPlayingVideo] = useState<{ streamUrl: string | null; videoUrl: string; title: string } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Play video whenever modal opens
  useEffect(() => {
    if (!playingVideo || !videoRef.current) return;
    const vid = videoRef.current;
    vid.src = playingVideo.videoUrl;
    vid.play().catch(() => {});
    return () => { vid.pause(); vid.src = ""; };
  }, [playingVideo]);

  const tabs: { label: string; value: Filter; count: number }[] = [
    { label: "All",      value: "all",      count: total },
    { label: "Active",   value: "active",   count: totalActive },
    { label: "Inactive", value: "inactive", count: totalInactive },
  ];

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    navigate(`?filter=${filter}&q=${encodeURIComponent(search)}`);
  }

  async function handleAttachProduct(videoId: string) {
    try {
      const selected = await (shopify as any).resourcePicker({
        type: "product",
        action: "select",
        multiple: false,
      });
      if (!selected || selected.length === 0) return;

      const product = selected[0];
      const variant = product.variants[0];

      const fd = new FormData();
      fd.set("intent",          "attach");
      fd.set("videoId",         videoId);
      fd.set("variantId",       String(variant.id));
      fd.set("productTitle",    product.title);
      fd.set("productImageUrl", product.images?.[0]?.originalSrc ?? "");
      fd.set("price",           String(variant.price ?? ""));
      fd.set("compareAtPrice",  String(variant.compareAtPrice ?? ""));
      fd.set("currency",        "INR");
      fd.set("productUrl",      `/products/${product.handle}`);
      submit(fd, { method: "post" });
    } catch {
      // user cancelled picker
    }
  }

  function handleDetach(videoId: string) {
    const fd = new FormData();
    fd.set("intent",  "detach");
    fd.set("videoId", videoId);
    submit(fd, { method: "post" });
  }

  function handleDelete(videoId: string) {
    if (!confirm("Delete this video? This cannot be undone.")) return;
    const fd = new FormData();
    fd.set("intent",  "delete");
    fd.set("videoId", videoId);
    submit(fd, { method: "post" });
  }

  function handleToggle(videoId: string) {
    const fd = new FormData();
    fd.set("intent",  "toggle");
    fd.set("videoId", videoId);
    submit(fd, { method: "post" });
  }

  return (
    <s-page heading="Video library">
      {/* ── Video preview modal ─────────────────────────────── */}
      {playingVideo && (
        <div style={styles.previewOverlay} onClick={() => setPlayingVideo(null)}>
          <div style={styles.previewBox} onClick={(e) => e.stopPropagation()}>
            <button style={styles.previewClose} onClick={() => setPlayingVideo(null)}>✕</button>
            <video
              ref={videoRef}
              style={styles.previewVideo}
              controls
              playsInline
              loop
            />
            {playingVideo.title && (
              <p style={styles.previewTitle}>{playingVideo.title}</p>
            )}
          </div>
        </div>
      )}
      {/* Upload button */}
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => navigate("/app/videos/new")}
      >
        Upload videos
      </s-button>

      {total === 0 && !q ? (
        <s-section>
          <div style={styles.emptyState}>
            <div style={styles.emptyIcon}>🎬</div>
            <h2 style={styles.emptyTitle}>No videos yet</h2>
            <p style={styles.emptyText}>Upload your first shoppable video to get started.</p>
            <s-button variant="primary" onClick={() => navigate("/app/videos/new")}>
              Upload videos
            </s-button>
          </div>
        </s-section>
      ) : (
        <s-section>
          {/* ── Toolbar ──────────────────────────────────────────── */}
          <div style={styles.toolbar}>
            <form onSubmit={handleSearch} style={styles.searchWrap}>
              <input
                style={styles.searchInput}
                type="text"
                placeholder="Search videos by tagged product name"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button type="submit" style={styles.searchBtn}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2" strokeLinecap="round">
                  <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
                </svg>
              </button>
            </form>

            {/* Filter tabs as pill buttons */}
            <div style={styles.filterTabs}>
              {tabs.map((tab) => (
                <Link
                  key={tab.value}
                  to={`?filter=${tab.value}&q=${encodeURIComponent(search)}`}
                  style={{
                    ...styles.filterTab,
                    ...(filter === tab.value ? styles.filterTabActive : {}),
                  }}
                >
                  {tab.label} ({tab.count})
                </Link>
              ))}
            </div>
          </div>

          {/* ── Grid ─────────────────────────────────────────────── */}
          {videos.length === 0 ? (
            <p style={{ color: "#6b7280", fontSize: "14px", padding: "24px 0" }}>
              No {filter === "all" ? "" : filter} videos{q ? ` matching "${q}"` : ""}.
            </p>
          ) : (
            <div style={styles.grid}>
              {videos.map((video) => (
                <div key={video.id} style={styles.card}>

                  {/* Thumbnail */}
                  <div
                    style={{ ...styles.thumbWrap, cursor: "pointer" }}
                    onClick={() => setPlayingVideo({ streamUrl: video.streamUrl ?? null, videoUrl: video.videoUrl, title: video.title })}
                  >
                    {video.thumbnailUrl
                      ? <img src={video.thumbnailUrl} alt={video.title} style={styles.thumbImg} />
                      : <div style={styles.thumbPlaceholder}>🎬</div>
                    }
                    {/* Play icon */}
                    <div style={styles.playIcon}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                        <path d="M8 5v14l11-7z"/>
                      </svg>
                    </div>
                    {/* Status badge */}
                    <span style={{
                      ...styles.statusBadge,
                      background: video.active ? "rgba(34,197,94,0.9)" : "rgba(0,0,0,0.55)",
                    }}>
                      {video.active ? "Active" : "Inactive"}
                    </span>
                    {/* Stats badge */}
                    <span style={styles.viewsBadge}>
                      👁 {video.viewCount}
                    </span>
                  </div>

                  {/* Product row */}
                  <div style={styles.productRow}>
                    {video.productImageUrl
                      ? <img src={video.productImageUrl} alt="" style={styles.productThumb} />
                      : <div style={styles.productThumbEmpty}>🛍</div>
                    }
                    <p style={styles.productName}>
                      {video.productTitle || video.title || "Untitled"}
                    </p>
                  </div>

                  {/* Attach / Detach */}
                  <button
                    style={styles.attachBtn}
                    onClick={() => video.variantId && video.variantId !== "" ? handleDetach(video.id) : handleAttachProduct(video.id)}
                    disabled={isSubmitting}
                  >
                    {video.variantId && video.variantId !== "" ? "✕ Detach product" : "+ Attach products"}
                  </button>

                  {/* Actions row */}
                  <div style={styles.actionsRow}>
                    <button
                      style={{
                        ...styles.actionBtn,
                        ...(video.active ? styles.actionBtnActive : {}),
                      }}
                      onClick={() => handleToggle(video.id)}
                      disabled={isSubmitting}
                    >
                      {video.active ? "Deactivate" : "Activate"}
                    </button>

                    <button
                      style={styles.deleteBtn}
                      onClick={() => handleDelete(video.id)}
                      disabled={isSubmitting}
                      title="Delete video"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14H6L5 6"/>
                        <path d="M10 11v6M14 11v6"/>
                        <path d="M9 6V4h6v2"/>
                      </svg>
                    </button>
                  </div>

                </div>
              ))}
            </div>
          )}
        </s-section>
      )}
    </s-page>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  emptyState: {
    display: "flex", flexDirection: "column", alignItems: "center",
    gap: "12px", padding: "48px 24px", textAlign: "center",
  },
  emptyIcon:  { fontSize: "48px" },
  emptyTitle: { fontSize: "18px", fontWeight: 700, margin: 0 },
  emptyText:  { fontSize: "14px", color: "#6b7280", margin: 0, maxWidth: "360px" },

  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    marginBottom: "20px",
    flexWrap: "wrap",
  },

  searchWrap: {
    flex: 1,
    minWidth: "240px",
    display: "flex",
    alignItems: "center",
    border: "1px solid #d1d5db",
    borderRadius: "8px",
    background: "#fff",
    overflow: "hidden",
    height: "38px",
  },

  searchInput: {
    flex: 1,
    border: "none",
    outline: "none",
    padding: "0 12px",
    fontSize: "14px",
    height: "100%",
    background: "transparent",
  },

  searchBtn: {
    border: "none",
    background: "transparent",
    padding: "0 10px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
  },

  filterTabs: {
    display: "flex",
    gap: "6px",
  },

  filterTab: {
    padding: "7px 14px",
    borderRadius: "20px",
    fontSize: "13px",
    fontWeight: 500,
    color: "#6b7280",
    textDecoration: "none",
    background: "#f3f4f6",
    border: "1px solid transparent",
    whiteSpace: "nowrap" as const,
  },

  filterTabActive: {
    background: "#111827",
    color: "#fff",
  },

  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
    gap: "16px",
  },

  card: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },

  thumbWrap: {
    position: "relative",
    width: "100%",
    aspectRatio: "9/16" as any,
    background: "#111",
    overflow: "hidden",
    maxHeight: "300px",
  },

  thumbImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },

  thumbPlaceholder: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "32px",
    background: "#1f2937",
  },

  playIcon: {
    position: "absolute",
    bottom: "10px",
    left: "10px",
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  statusBadge: {
    position: "absolute",
    top: "8px",
    left: "8px",
    color: "#fff",
    fontSize: "10px",
    fontWeight: 700,
    padding: "3px 7px",
    borderRadius: "20px",
  },

  viewsBadge: {
    position: "absolute",
    top: "8px",
    right: "8px",
    background: "rgba(0,0,0,0.55)",
    color: "#fff",
    fontSize: "10px",
    fontWeight: 600,
    padding: "3px 7px",
    borderRadius: "20px",
  },

  productRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "10px 12px 8px",
    borderBottom: "1px solid #f3f4f6",
  },

  productThumb: {
    width: "32px",
    height: "32px",
    borderRadius: "4px",
    objectFit: "cover",
    flexShrink: 0,
    background: "#f3f4f6",
  },

  productThumbEmpty: {
    width: "32px",
    height: "32px",
    borderRadius: "4px",
    background: "#f3f4f6",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "14px",
    flexShrink: 0,
  },

  productName: {
    fontSize: "12px",
    fontWeight: 600,
    color: "#374151",
    margin: 0,
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },

  attachBtn: {
    margin: "8px 12px",
    padding: "8px 0",
    background: "#fff",
    border: "1.5px dashed #d1d5db",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 600,
    color: "#6b7280",
    cursor: "pointer",
    width: "calc(100% - 24px)",
    textAlign: "center",
    transition: "border-color 0.15s, color 0.15s",
  },

  actionsRow: {
    display: "flex",
    gap: "6px",
    padding: "0 12px 12px",
    marginTop: "auto",
  },

  actionBtn: {
    flex: 1,
    padding: "7px 0",
    border: "1px solid #d1d5db",
    borderRadius: "6px",
    background: "#fff",
    color: "#374151",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
  },

  actionBtnActive: {
    background: "#f0fdf4",
    borderColor: "#86efac",
    color: "#166534",
  },

  deleteBtn: {
    padding: "7px 10px",
    border: "1px solid #fca5a5",
    borderRadius: "6px",
    background: "#fff",
    color: "#dc2626",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  previewOverlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(0,0,0,0.8)",
    zIndex: 9999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  previewBox: {
    position: "relative" as const,
    background: "#000",
    borderRadius: "12px",
    overflow: "hidden",
    width: "min(360px, 90vw)",
    display: "flex",
    flexDirection: "column" as const,
  },

  previewClose: {
    position: "absolute" as const,
    top: "10px",
    right: "10px",
    zIndex: 1,
    background: "rgba(0,0,0,0.6)",
    border: "none",
    color: "#fff",
    fontSize: "16px",
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  previewVideo: {
    width: "100%",
    aspectRatio: "9/16" as any,
    display: "block",
    background: "#000",
    maxHeight: "80vh",
    objectFit: "contain" as const,
  },

  previewTitle: {
    color: "#fff",
    fontSize: "13px",
    fontWeight: 600,
    padding: "10px 14px",
    margin: 0,
    background: "#111",
  },
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
