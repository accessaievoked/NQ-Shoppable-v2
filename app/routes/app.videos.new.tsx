import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useLoaderData,
  useNavigate,
  useFetcher,
  Form,
  redirect,
} from "react-router";
import { useState, useRef, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { uploadToR2, deleteFromR2ByUrl } from "../r2.server";
import { processVideo } from "../ffmpeg.server";

// ─── Types ────────────────────────────────────────────────────────────────────
type Product = {
  id: string;
  title: string;
  variantId: string;
  variantIdNumeric: string;
  price: string;
  currency: string;
  imageUrl: string;
  productUrl: string;
};

// ─── Loader: product search ───────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q") || "";

  if (query.length < 2) return { products: [], query };

  const response = await admin.graphql(
    `#graphql
    query searchProducts($query: String!) {
      products(first: 10, query: $query, sortKey: RELEVANCE) {
        edges {
          node {
            id
            title
            handle
            onlineStoreUrl
            featuredImage { url }
            priceRangeV2 {
              minVariantPrice { amount currencyCode }
            }
            variants(first: 1) {
              edges {
                node {
                  id
                  price
                  compareAtPrice
                  image { url }
                }
              }
            }
          }
        }
      }
    }`,
    { variables: { query } }
  );

  const json = await response.json();
  const edges = json.data?.products?.edges ?? [];

  const products: Product[] = edges.map((edge: any) => {
    const node = edge.node;
    const variant = node.variants.edges[0]?.node;
    // Strip GID prefix: "gid://shopify/ProductVariant/12345" → "12345"
    const variantIdNumeric = variant?.id?.split("/").pop() ?? "";
    const shopDomain = new URL(request.url).hostname;

    return {
      id: node.id,
      title: node.title,
      variantId: variant?.id ?? "",
      variantIdNumeric,
      price: variant?.price ?? node.priceRangeV2?.minVariantPrice?.amount ?? "0",
      currency: node.priceRangeV2?.minVariantPrice?.currencyCode ?? "INR",
      imageUrl:
        node.featuredImage?.url ?? variant?.image?.url ?? "",
      productUrl: node.onlineStoreUrl ?? `/products/${node.handle}`,
    };
  });

  return { products, query };
};

// ─── Action: save video ───────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const title         = (formData.get("title") as string)?.trim();
  const productId     = formData.get("productId") as string;
  const variantId     = formData.get("variantId") as string;
  const variantIdNum  = formData.get("variantIdNumeric") as string;
  const productTitle  = formData.get("productTitle") as string;
  const price         = formData.get("price") as string;
  const currency      = formData.get("currency") as string;
  const productImageUrl = formData.get("productImageUrl") as string;
  const productUrl    = formData.get("productUrl") as string;
  const videoFile     = formData.get("video") as File | null;
  const existingUrl   = (formData.get("existingUrl") as string)?.trim();

  // ── Validation ────────────────────────────────────────────────────────────
  const hasFile = videoFile && videoFile.size > 0;
  if (!hasFile && !existingUrl) {
    return { error: "Please upload a video file or paste an existing R2 URL." };
  }
  if (!variantIdNum) {
    return { error: "Please search and select a product." };
  }

  // ── Resolve video URL ─────────────────────────────────────────────────────
  let videoUrl = "";
  if (hasFile) {
    // Upload new file to R2
    try {
      const safeName = videoFile.name.replace(/[^a-z0-9._-]/gi, "_");
      const key = `videos/${Date.now()}-${safeName}`;
      const buffer = Buffer.from(await videoFile.arrayBuffer());
      videoUrl = await uploadToR2(key, buffer, videoFile.type || "video/mp4");
    } catch (err) {
      console.error("R2 upload error:", err);
      return { error: "Failed to upload video. Please try again." };
    }
  } else {
    // Use pasted URL
    videoUrl = existingUrl;
  }

  // ── Duplicate check ───────────────────────────────────────────────────────
  const duplicate = await db.video.findFirst({
    where: { shop: session.shop, videoUrl },
  });
  if (duplicate) {
    return { error: "A video with this URL already exists in your store." };
  }

  // ── Generate base key for this video ─────────────────────────────────────
  const slug = (title || productTitle || "video")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
  const baseKey = `${Date.now()}-${slug}`;

  // ── Save to DB immediately so the user isn't blocked ─────────────────────
  // streamUrl / thumbnailUrl are null until background processing finishes.
  const video = await db.video.create({
    data: {
      shop: session.shop,
      title: title || productTitle || "Untitled",
      videoUrl,
      streamUrl: null,
      thumbnailUrl: "",
      productId,
      variantId: variantIdNum,
      productTitle,
      productUrl,
      productImageUrl,
      price: price ? parseFloat(price) : null,
      currency: currency || "INR",
    },
  });

  // ── Process video in background (compress + HLS + thumbnail) ─────────────
  // Do NOT await — this lets the response return immediately, avoiding 502s on large files.
  processVideo(videoUrl, baseKey)
    .then(async (processed) => {
      await db.video.update({
        where: { id: video.id },
        data: {
          videoUrl: processed.compressedUrl,
          streamUrl: processed.streamUrl,
          thumbnailUrl: processed.thumbnailUrl,
        },
      });

      // Clean up the raw original now that the compressed copy is saved — but
      // only if WE uploaded it (not an admin-pasted URL) and it's actually a
      // different object than the compressed result. Done after the DB update
      // so videoUrl never points at a deleted file.
      if (hasFile && videoUrl && videoUrl !== processed.compressedUrl) {
        try {
          await deleteFromR2ByUrl(videoUrl);
          console.log(`[Video] Deleted raw original for video ${video.id}`);
        } catch (cleanupErr) {
          console.warn(`[Video] Could not delete raw original for video ${video.id}:`, cleanupErr);
        }
      }

      console.log(`[Video] Background processing complete for video ${video.id}`);
    })
    .catch((err) => {
      console.error(`[Video] Background processing failed for video ${video.id}:`, err);
    });

  return redirect("/app");
};

// ─── Component ────────────────────────────────────────────────────────────────
export default function NewVideo() {
  const navigate = useNavigate();
  const actionData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof loader>();
  const formRef = useRef<HTMLFormElement>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchResults: Product[] = fetcher.data?.products ?? [];

  // Debounced product search
  useEffect(() => {
    if (searchQuery.length < 2) {
      setShowDropdown(false);
      return;
    }
    const timer = setTimeout(() => {
      fetcher.load(`/app/videos/new?q=${encodeURIComponent(searchQuery)}`);
      setShowDropdown(true);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  function selectProduct(product: Product) {
    setSelectedProduct(product);
    setSearchQuery(product.title);
    setShowDropdown(false);
  }

  function handleVideoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setVideoPreview(url);
  }

  function handleSubmit(e: React.FormEvent) {
    if (!selectedProduct) {
      e.preventDefault();
      setError("Please search and select a product.");
      return;
    }
    setIsSubmitting(true);
  }

  return (
    <s-page heading="Add Shoppable Video">
      {/* Back button */}
      <s-button
        slot="primary-action"
        variant="secondary"
        onClick={() => navigate("/app")}
      >
        ← Back
      </s-button>

      <s-section>
        <Form
          ref={formRef}
          method="post"
          encType="multipart/form-data"
          onSubmit={handleSubmit}
        >
          {/* Hidden product fields — populated when user selects a product */}
          <input type="hidden" name="productId"       value={selectedProduct?.id ?? ""} />
          <input type="hidden" name="variantId"       value={selectedProduct?.variantId ?? ""} />
          <input type="hidden" name="variantIdNumeric" value={selectedProduct?.variantIdNumeric ?? ""} />
          <input type="hidden" name="productTitle"    value={selectedProduct?.title ?? ""} />
          <input type="hidden" name="price"           value={selectedProduct?.price ?? ""} />
          <input type="hidden" name="currency"        value={selectedProduct?.currency ?? ""} />
          <input type="hidden" name="productImageUrl" value={selectedProduct?.imageUrl ?? ""} />
          <input type="hidden" name="productUrl"      value={selectedProduct?.productUrl ?? ""} />

          <div style={styles.form}>

            {/* Error banner */}
            {error && (
              <div style={styles.errorBanner}>⚠️ {error}</div>
            )}

            {/* ── Video upload ───────────────────────────────────────── */}
            <div style={styles.field}>
              <label style={styles.label}>Video file *</label>
              <p style={styles.hint}>MP4 recommended. Max 200MB.</p>

              <label style={styles.uploadBox} htmlFor="video-input">
                {videoPreview ? (
                  <video
                    src={videoPreview}
                    style={styles.preview}
                    muted
                    playsInline
                    controls
                  />
                ) : (
                  <div style={styles.uploadPlaceholder}>
                    <span style={{ fontSize: "36px" }}>📁</span>
                    <span style={{ fontSize: "14px", color: "#6b7280" }}>
                      Click to select a video
                    </span>
                  </div>
                )}
              </label>
              <input
                id="video-input"
                name="video"
                type="file"
                accept="video/mp4,video/quicktime,video/webm"
                style={{ display: "none" }}
                onChange={handleVideoChange}
              />
            </div>

            {/* ── Or paste existing R2 URL ───────────────────────────── */}
            <div style={styles.field}>
              <label style={styles.label}>Or paste an existing R2 URL</label>
              <p style={styles.hint}>
                Already have a video in your R2 bucket? Paste its public URL here instead of uploading.
              </p>
              <input
                type="url"
                name="existingUrl"
                placeholder="https://pub-xxxx.r2.dev/videos/my-video.mp4"
                style={styles.input}
              />
            </div>

            {/* ── Product search ─────────────────────────────────────── */}
            <div style={styles.field}>
              <label style={styles.label}>Link to product *</label>
              <p style={styles.hint}>
                Search your store's products. The "Shop Now" button will link
                to this product's checkout.
              </p>

              <div style={{ position: "relative" }}>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    if (selectedProduct) setSelectedProduct(null);
                  }}
                  placeholder="Search products..."
                  style={styles.input}
                  autoComplete="off"
                />

                {/* Search dropdown */}
                {showDropdown && searchResults.length > 0 && (
                  <div style={styles.dropdown}>
                    {searchResults.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        style={styles.dropdownItem}
                        onClick={() => selectProduct(p)}
                        onMouseEnter={(e) =>
                          ((e.currentTarget as HTMLElement).style.background =
                            "#f3f4f6")
                        }
                        onMouseLeave={(e) =>
                          ((e.currentTarget as HTMLElement).style.background =
                            "#fff")
                        }
                      >
                        {p.imageUrl && (
                          <img
                            src={p.imageUrl}
                            alt={p.title}
                            style={styles.dropdownImg}
                          />
                        )}
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "13px" }}>
                            {p.title}
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280" }}>
                            {p.currency} {p.price}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {showDropdown &&
                  fetcher.state === "loading" && (
                    <div style={styles.dropdown}>
                      <div style={{ padding: "12px", color: "#9ca3af", fontSize: "13px" }}>
                        Searching…
                      </div>
                    </div>
                  )}

                {showDropdown &&
                  fetcher.state === "idle" &&
                  searchResults.length === 0 &&
                  searchQuery.length >= 2 && (
                    <div style={styles.dropdown}>
                      <div style={{ padding: "12px", color: "#9ca3af", fontSize: "13px" }}>
                        No products found for "{searchQuery}"
                      </div>
                    </div>
                  )}
              </div>

              {/* Selected product preview */}
              {selectedProduct && (
                <div style={styles.selectedProduct}>
                  {selectedProduct.imageUrl && (
                    <img
                      src={selectedProduct.imageUrl}
                      alt={selectedProduct.title}
                      style={styles.selectedImg}
                    />
                  )}
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "13px" }}>
                      {selectedProduct.title}
                    </div>
                    <div style={{ fontSize: "12px", color: "#6b7280" }}>
                      {selectedProduct.currency} {selectedProduct.price}
                    </div>
                  </div>
                  <span style={styles.checkmark}>✓ Selected</span>
                </div>
              )}
            </div>

            {/* ── Video title ────────────────────────────────────────── */}
            <div style={styles.field}>
              <label style={styles.label}>Title (optional)</label>
              <p style={styles.hint}>
                Leave blank to use the product name.
              </p>
              <input
                type="text"
                name="title"
                placeholder={selectedProduct?.title ?? "e.g. Summer Collection Look"}
                style={styles.input}
              />
            </div>

            {/* ── Submit ─────────────────────────────────────────────── */}
            <div style={styles.actions}>
              <s-button
                variant="secondary"
                onClick={() => navigate("/app")}
                type="button"
              >
                Cancel
              </s-button>
              <button
                type="submit"
                disabled={isSubmitting}
                style={styles.submitBtn}
              >
                {isSubmitting ? "Uploading…" : "Save Video"}
              </button>
            </div>

          </div>
        </Form>
      </s-section>
    </s-page>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles: Record<string, React.CSSProperties> = {
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "28px",
    maxWidth: "560px",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  label: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#111827",
  },
  hint: {
    fontSize: "12px",
    color: "#6b7280",
    margin: 0,
  },
  input: {
    width: "100%",
    padding: "10px 12px",
    fontSize: "14px",
    border: "1px solid #d1d5db",
    borderRadius: "8px",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  uploadBox: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    minHeight: "180px",
    border: "2px dashed #d1d5db",
    borderRadius: "10px",
    cursor: "pointer",
    overflow: "hidden",
    background: "#f9fafb",
  },
  uploadPlaceholder: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "10px",
    padding: "24px",
  },
  preview: {
    width: "100%",
    maxHeight: "300px",
    objectFit: "contain" as const,
    background: "#000",
  },
  dropdown: {
    position: "absolute" as const,
    top: "calc(100% + 4px)",
    left: 0,
    right: 0,
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: "8px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
    zIndex: 100,
    maxHeight: "260px",
    overflowY: "auto" as const,
  },
  dropdownItem: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    padding: "10px 14px",
    background: "#fff",
    border: "none",
    cursor: "pointer",
    textAlign: "left" as const,
    transition: "background 0.15s",
  },
  dropdownImg: {
    width: "36px",
    height: "36px",
    objectFit: "cover" as const,
    borderRadius: "4px",
    flexShrink: 0,
  },
  selectedProduct: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 14px",
    background: "#f0fdf4",
    border: "1px solid #86efac",
    borderRadius: "8px",
    marginTop: "8px",
  },
  selectedImg: {
    width: "40px",
    height: "40px",
    objectFit: "cover" as const,
    borderRadius: "6px",
  },
  checkmark: {
    marginLeft: "auto",
    fontSize: "12px",
    fontWeight: 700,
    color: "#15803d",
  },
  actions: {
    display: "flex",
    gap: "10px",
    justifyContent: "flex-end",
    paddingTop: "8px",
  },
  submitBtn: {
    padding: "10px 20px",
    background: "#000",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    opacity: 1,
  },
  errorBanner: {
    padding: "12px 16px",
    background: "#fef2f2",
    border: "1px solid #fca5a5",
    borderRadius: "8px",
    fontSize: "13px",
    color: "#991b1b",
  },
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
