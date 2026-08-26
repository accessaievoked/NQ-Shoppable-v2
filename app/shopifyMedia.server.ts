/**
 * Pushes our R2-hosted videos into Shopify's native product media gallery.
 *
 * Why this exists: the storefront carousel is our own markup, placed wherever
 * the merchant drops the section. The product page's media gallery — the
 * carousel next to the price and Add to Cart — is owned by the theme and only
 * renders media attached to the product in Shopify. To get a video in there we
 * have to hand Shopify the file.
 *
 * Shopify will NOT reference an external URL for video the way it can for a
 * collection image. It downloads the file, transcodes it to 480p/720p/1080p,
 * and serves its own HLS + MP4 copies. So a video shown in the gallery exists
 * twice: our R2 object and Shopify's file. That duplication is inherent to this
 * approach.
 *
 * The one nice surprise: because the file is already at a public URL, we can
 * skip stagedUploadsCreate entirely and let fileCreate fetch it server-side.
 */

import db from "./db.server";

// Shopify's own limits on product video, from the Admin API docs.
const MAX_DURATION_SECONDS = 10 * 60;

/** Loose shape of the admin client returned by authenticate.admin(). */
type AdminClient = {
  graphql: (query: string, options?: { variables?: Record<string, any> }) => Promise<Response>;
};

async function gql<T = any>(
  admin: AdminClient,
  query: string,
  variables?: Record<string, any>
): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) throw new Error("Shopify returned no data.");
  return json.data;
}

/** Collapses Shopify's userErrors / mediaUserErrors arrays into one throw. */
function throwUserErrors(errors: Array<{ message: string; field?: string[] | null }> | undefined) {
  if (errors?.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

// ─── Step 1: hand the R2 URL to Shopify ───────────────────────────────────────

const FILE_CREATE = `#graphql
  mutation nqFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus alt }
      userErrors { field message }
    }
  }
`;

const STAGED_UPLOADS = `#graphql
  mutation nqStagedUploads($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }
`;

/**
 * Starts the import of one video into the shop's files.
 *
 * NOTE ON APPROACH. The docs present fileCreate-from-URL as generic across
 * content types, and for images it is — hand it a public URL and Shopify
 * fetches the file. Video is different: passing an external URL comes back as
 * "Invalid video url". Video has to go through a staged upload, which is also
 * why the docs describe that path as "recommended for large files like videos".
 *
 * So: pull the bytes from R2, POST them to the staged target Shopify hands us,
 * then register the result with fileCreate.
 *
 * Returns the new file's GID. The file is NOT usable yet — Shopify transcodes
 * asynchronously and the status will be UPLOADED or PROCESSING. Associating it
 * with a product before it reaches READY fails, which is why this is split from
 * associateFileWithProduct().
 */
export async function createShopifyFileFromUrl(
  admin: AdminClient,
  publicUrl: string,
  alt: string
): Promise<{ id: string; fileStatus: string }> {
  // 1. Fetch the video out of our bucket.
  const res = await fetch(publicUrl, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    throw new Error(
      `Could not read the video from storage (HTTP ${res.status}). ` +
        `Check the file still exists in R2.`
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw new Error("The video file in storage is empty.");

  const filename = decodeURIComponent(new URL(publicUrl).pathname.split("/").pop() || "video.mp4");
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "video/mp4";

  // 2. Ask Shopify where to put it. fileSize is required for video.
  const staged = await gql(admin, STAGED_UPLOADS, {
    input: [
      {
        filename,
        mimeType,
        resource: "VIDEO",
        fileSize: String(bytes.length),
        httpMethod: "POST",
      },
    ],
  });
  throwUserErrors(staged.stagedUploadsCreate?.userErrors);

  const target = staged.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) {
    throw new Error("Shopify did not return an upload target for this video.");
  }

  // 3. POST as multipart form data. Every parameter Shopify returns has to be
  // included, in order, BEFORE the file field — the storage backend rejects the
  // upload otherwise.
  const form = new FormData();
  for (const param of target.parameters as Array<{ name: string; value: string }>) {
    form.append(param.name, param.value);
  }
  form.append("file", new Blob([bytes], { type: mimeType }), filename);

  const upload = await fetch(target.url, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  if (!upload.ok) {
    const detail = await upload.text().catch(() => "");
    throw new Error(
      `Upload to Shopify failed (HTTP ${upload.status}). ${detail.slice(0, 200)}`
    );
  }

  // 4. Register the uploaded object as a file on the shop.
  const data = await gql(admin, FILE_CREATE, {
    files: [{ originalSource: target.resourceUrl, contentType: "VIDEO", alt: alt.slice(0, 512) }],
  });
  throwUserErrors(data.fileCreate?.userErrors);

  const file = data.fileCreate?.files?.[0];
  if (!file?.id) throw new Error("Shopify accepted the upload but returned no file.");
  return { id: file.id, fileStatus: file.fileStatus };
}

// ─── Step 2: poll until Shopify has finished transcoding ──────────────────────

// Spread the CONCRETE type rather than the File interface. `... on File` is
// valid GraphQL but brittle across API versions, and when it fails the whole
// query throws — which syncPendingProductMedia catches per row, leaving the
// status stuck on PROCESSING and looking to the merchant like Shopify is slow.
const FILE_STATUS = `#graphql
  query nqFileStatus($id: ID!) {
    node(id: $id) {
      __typename
      ... on Video {
        fileStatus
        fileErrors { code details message }
      }
      ... on MediaImage {
        fileStatus
      }
      ... on GenericFile {
        fileStatus
      }
    }
  }
`;

export type ShopifyFileStatus = "UPLOADED" | "PROCESSING" | "READY" | "FAILED";

export async function getShopifyFileStatus(
  admin: AdminClient,
  fileId: string
): Promise<{ status: ShopifyFileStatus; error?: string }> {
  const data = await gql(admin, FILE_STATUS, { id: fileId });
  const node = data.node;
  if (!node) {
    // The file was deleted in the Shopify admin behind our back.
    return { status: "FAILED", error: "File no longer exists in Shopify." };
  }
  if (!node.fileStatus) {
    // Node resolved but isn't a media type we recognise. Report it rather than
    // silently reporting PROCESSING forever.
    return {
      status: "FAILED",
      error: `Unexpected Shopify object type: ${node.__typename ?? "unknown"}`,
    };
  }
  const status = node.fileStatus as ShopifyFileStatus;
  const error = node.fileErrors?.map((e: any) => e.message).join("; ") || undefined;
  return { status, error };
}

// ─── Step 3: attach the finished file to the product ──────────────────────────

const FILE_ATTACH = `#graphql
  mutation nqAttachMedia($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files { id }
      userErrors { field message }
    }
  }
`;

/**
 * Attaches an already-READY file to a product.
 *
 * Uses fileUpdate/referencesToAdd rather than productSet. The docs show
 * productSet with the file's GID in `originalSource`, and that works for
 * images — but for video Shopify rejects a GID there with "Invalid video url",
 * because it expects that field to be an actual URL. referencesToAdd is the
 * documented way to manage which products reference a file and sidesteps the
 * problem entirely. It's also symmetric with how detach works.
 */
export async function associateFileWithProduct(
  admin: AdminClient,
  productGid: string,
  fileId: string
): Promise<void> {
  const data = await gql(admin, FILE_ATTACH, {
    files: [{ id: fileId, referencesToAdd: [productGid] }],
  });
  throwUserErrors(data.fileUpdate?.userErrors);
}

// ─── Public entry point: push a video to a product ────────────────────────────

export type PushResult =
  | { ok: true; productMediaId: string; status: string }
  | { ok: false; error: string };

/**
 * Idempotent. If this video has already been pushed to this product the
 * existing row is returned rather than importing a second copy — the unique
 * index on (shop, videoId, productId) is the backstop for concurrent clicks.
 */
export async function pushVideoToProduct(
  admin: AdminClient,
  shop: string,
  video: { id: string; videoUrl: string; title: string; duration: number | null },
  productGid: string
): Promise<PushResult> {
  const existing = await db.productMedia.findUnique({
    where: { shop_videoId_productId: { shop, videoId: video.id, productId: productGid } },
  });
  // FAILED and REMOVED are both re-pushable: FAILED because the merchant may be
  // retrying after fixing the cause, REMOVED because they've deliberately asked
  // for it back. Any other status means it's already on its way or there.
  if (existing && !["FAILED", "REMOVED"].includes(existing.status)) {
    return { ok: true, productMediaId: existing.id, status: existing.status };
  }

  // Reuse an upload we've already made of this same video.
  //
  // Shopify's file system is deliberately unified: one file can be referenced
  // by many products. Uploading the same video again would create a second file
  // object and burn another slot against the store's plan allowance (250 videos
  // on Basic, store-wide) for no benefit. So if this video is already in the
  // shop's files from a previous push, just point the new product at it.
  const alreadyUploaded = await db.productMedia.findFirst({
    where: {
      shop,
      videoId: video.id,
      shopifyFileId: { not: "" },
      status: { notIn: ["FAILED", "REMOVED"] },
    },
  });

  if (alreadyUploaded) {
    try {
      const { status } = await getShopifyFileStatus(admin, alreadyUploaded.shopifyFileId);

      if (status !== "FAILED") {
        // Only attach once Shopify has finished with it; otherwise record the
        // link and let syncPendingProductMedia attach it when it turns READY.
        if (status === "READY") {
          await associateFileWithProduct(admin, productGid, alreadyUploaded.shopifyFileId);
        }

        const row = existing
          ? await db.productMedia.update({
              where: { id: existing.id },
              data: { shopifyFileId: alreadyUploaded.shopifyFileId, status, lastError: null },
            })
          : await db.productMedia.create({
              data: {
                shop,
                videoId: video.id,
                productId: productGid,
                shopifyFileId: alreadyUploaded.shopifyFileId,
                status,
              },
            });

        return { ok: true, productMediaId: row.id, status };
      }
      // Existing file is gone or broken — fall through and upload a fresh copy.
    } catch (err) {
      console.warn(`[ProductMedia] could not reuse existing file for video ${video.id}:`, err);
    }
  }

  // Cheap client-side checks first, so we fail with something readable instead
  // of a generic Shopify error after the upload has already started.
  if (!video.videoUrl) {
    return { ok: false, error: "This video has no file yet — wait for processing to finish." };
  }
  if (video.duration && video.duration > MAX_DURATION_SECONDS) {
    return {
      ok: false,
      error: `Shopify caps product videos at 10 minutes; this one is ${Math.round(video.duration / 60)} minutes.`,
    };
  }

  try {
    const file = await createShopifyFileFromUrl(admin, video.videoUrl, video.title || "Product video");

    const row = existing
      ? await db.productMedia.update({
          where: { id: existing.id },
          data: { shopifyFileId: file.id, status: file.fileStatus, lastError: null },
        })
      : await db.productMedia.create({
          data: {
            shop,
            videoId: video.id,
            productId: productGid,
            shopifyFileId: file.id,
            status: file.fileStatus,
          },
        });

    return { ok: true, productMediaId: row.id, status: file.fileStatus };
  } catch (err: any) {
    const message = String(err?.message ?? err);
    // Shopify allows an app 1,000 new videos per store per week. Worth its own
    // message because retrying is pointless until the window rolls over.
    if (message.includes("VIDEO_THROTTLE_EXCEEDED")) {
      return {
        ok: false,
        error: "Shopify's weekly limit of 1,000 videos for this store has been reached. Try again in a few days.",
      };
    }
    // Store-wide cap tied to the Shopify plan (250 videos + 3D models on Basic),
    // separate from storage. Nothing in the API gets around it, so say what the
    // actual options are instead of repeating Shopify's "upgrade your plan".
    if (/does not permit more than \d+ videos/i.test(message)) {
      return {
        ok: false,
        error:
          "This store has used all the videos its Shopify plan allows (250 on Basic, store-wide). " +
          "Free a slot by deleting unused videos in Shopify admin > Content > Files, or upgrade the plan. " +
          "The storefront carousel is unaffected — it plays from our own storage and has no such limit.",
      };
    }
    return { ok: false, error: message };
  }
}

/**
 * Pushes any video that's tagged to a product but has never been sent to that
 * product's page.
 *
 * Covers videos that already existed before this feature, and anything whose
 * upload-time auto-add didn't run. The intent is that tagging a video to a
 * product is the only action needed — the merchant shouldn't also have to add
 * it by hand.
 *
 * Two things keep this from misbehaving on a page load:
 *   - `limit` bounds how many uploads one request can trigger.
 *   - A failure records a FAILED row rather than leaving no row at all. Without
 *     that, a video that can't be pushed (plan cap, bad file) would be retried
 *     on every single page load, forever.
 */
/**
 * Last time the backfill actually ran, per shop.
 *
 * The media screen revalidates every 5s while anything is processing, and this
 * runs in its loader — so without a throttle every poll started another batch of
 * uploads. Each push downloads from R2 and re-uploads to Shopify, which on a
 * single shared CPU starved unrelated requests (uploads would hang) and chewed
 * through the store's video allowance unattended.
 */
const lastBackfillRun = new Map<string, number>();
const BACKFILL_MIN_INTERVAL_MS = 5 * 60 * 1000;

export async function autoAddMissingVideos(
  admin: AdminClient,
  shop: string,
  limit = 5
): Promise<void> {
  const last = lastBackfillRun.get(shop) ?? 0;
  if (Date.now() - last < BACKFILL_MIN_INTERVAL_MS) return;

  // Never start new uploads while earlier ones are still in flight. This is the
  // real guard: the poll only runs at all because something is pending, so
  // waiting for it to finish keeps the two from compounding.
  const inFlight = await db.productMedia.count({
    where: { shop, status: { in: ["PENDING", "UPLOADED", "PROCESSING"] } },
  });
  if (inFlight > 0) return;

  lastBackfillRun.set(shop, Date.now());

  const candidates = await db.video.findMany({
    where: { shop, productId: { not: "" }, videoUrl: { not: "" } },
    orderBy: { createdAt: "asc" },
  });
  if (!candidates.length) return;

  const links = await db.productMedia.findMany({
    where: { shop },
    select: { videoId: true, productId: true },
  });
  const linked = new Set(links.map((l) => `${l.videoId}::${l.productId}`));

  const missing = candidates
    .filter((v) => !linked.has(`${v.id}::${v.productId}`))
    .slice(0, limit);

  for (const video of missing) {
    try {
      const result = await pushVideoToProduct(admin, shop, video, video.productId);
      if (!result.ok) {
        // Record the failure so it shows in the UI and isn't retried endlessly.
        await db.productMedia.upsert({
          where: {
            shop_videoId_productId: { shop, videoId: video.id, productId: video.productId },
          },
          create: {
            shop,
            videoId: video.id,
            productId: video.productId,
            shopifyFileId: "",
            status: "FAILED",
            lastError: result.error,
          },
          update: { status: "FAILED", lastError: result.error },
        });
        console.warn(`[ProductMedia] auto-add failed for video ${video.id}: ${result.error}`);
      } else {
        console.log(`[ProductMedia] auto-added video ${video.id} to ${video.productId}`);
      }
    } catch (err) {
      console.error(`[ProductMedia] auto-add threw for video ${video.id}:`, err);
    }
  }
}

/**
 * Advances every in-flight row for a shop: polls Shopify, and attaches the file
 * to its product once it turns READY. Safe to call repeatedly — it only acts on
 * rows that aren't finished.
 *
 * Called opportunistically when the merchant loads the media screen, which
 * avoids needing a scheduler for what is usually a few seconds of transcoding.
 */
export async function syncPendingProductMedia(admin: AdminClient, shop: string): Promise<void> {
  const pending = await db.productMedia.findMany({
    where: { shop, status: { in: ["PENDING", "UPLOADED", "PROCESSING"] } },
    take: 50,
  });

  for (const row of pending) {
    try {
      const { status, error } = await getShopifyFileStatus(admin, row.shopifyFileId);

      if (status === "READY") {
        await associateFileWithProduct(admin, row.productId, row.shopifyFileId);
        await db.productMedia.update({
          where: { id: row.id },
          data: { status: "READY", lastError: null },
        });
      } else if (status === "FAILED") {
        await db.productMedia.update({
          where: { id: row.id },
          data: { status: "FAILED", lastError: error ?? "Shopify could not process this video." },
        });
      } else if (status !== row.status) {
        await db.productMedia.update({ where: { id: row.id }, data: { status } });
      }
    } catch (err: any) {
      // One bad row must not stop the rest from advancing.
      console.error(`[ProductMedia] sync failed for ${row.id}:`, err);
      await db.productMedia.update({
        where: { id: row.id },
        data: { lastError: String(err?.message ?? err) },
      });
    }
  }
}

// ─── Reading the gallery ──────────────────────────────────────────────────────

const PRODUCT_MEDIA = `#graphql
  query nqProductMedia($id: ID!) {
    product(id: $id) {
      id
      title
      status
      # featuredImage is deprecated in favour of featuredMedia.
      featuredMedia { preview { image { url } } }
      priceRangeV2 { minVariantPrice { amount currencyCode } }
      media(first: 50) {
        nodes {
          id
          mediaContentType
          alt
          preview { image { url } }
          # Playable sources, so the Arrange screen can preview a video on hover
          # rather than showing a still you can't tell apart from a photo.
          ... on Video {
            sources { url format mimeType height }
          }
        }
      }
    }
  }
`;

export type GalleryItem = {
  id: string;
  type: string;
  alt: string | null;
  previewUrl: string | null;
  /** Smallest mp4 source, used for hover preview. Null for images. */
  hoverUrl: string | null;
};

export type ProductGallery = {
  id: string;
  title: string;
  status: string;
  featuredImageUrl: string | null;
  price: string | null;
  currency: string | null;
  media: GalleryItem[];
};

/**
 * Returns null when the product no longer exists — deleted or unpublished after
 * we stored its ID. Callers must handle that rather than rendering a blank row
 * with a NaN price, which is exactly the bug visible in competing apps.
 */
const PRODUCT_GALLERIES = `#graphql
  query nqProductGalleries($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        status
        featuredMedia { preview { image { url } } }
        priceRangeV2 { minVariantPrice { amount currencyCode } }
        media(first: 50) {
          nodes {
            id
            mediaContentType
            alt
            preview { image { url } }
            ... on Video {
              sources { url format mimeType height }
            }
          }
        }
      }
    }
  }
`;

/** Shared mapper so the single and batched queries can't drift apart. */
function toGallery(p: any): ProductGallery {
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    featuredImageUrl: p.featuredMedia?.preview?.image?.url ?? null,
    price: p.priceRangeV2?.minVariantPrice?.amount ?? null,
    currency: p.priceRangeV2?.minVariantPrice?.currencyCode ?? null,
    media: (p.media?.nodes ?? []).map((m: any) => {
      // Shopify returns several transcodes per video. Pick the smallest mp4 —
      // hover previews should start fast, not stream 1080p.
      const sources: any[] = m.sources ?? [];
      const mp4s = sources.filter((s) => (s.mimeType || s.format || "").includes("mp4"));
      const pool = mp4s.length ? mp4s : sources;
      const smallest = pool.slice().sort((a, b) => (a.height ?? 9999) - (b.height ?? 9999))[0];

      return {
        id: m.id,
        type: m.mediaContentType,
        alt: m.alt ?? null,
        previewUrl: m.preview?.image?.url ?? null,
        hoverUrl: smallest?.url ?? null,
      };
    }),
  };
}

/**
 * Fetches many products' galleries in as few round-trips as possible.
 *
 * The list screen previously called getProductGallery once per product. On a
 * catalogue with dozens of tagged products that's dozens of GraphQL requests
 * per page load — slow enough that the page never finished rendering, and
 * enough to hit Shopify's rate limiter. `nodes(ids:)` collapses them into one
 * request per chunk.
 *
 * Products that no longer exist come back as null and are simply absent from
 * the returned map, which callers already treat as "missing".
 */
export async function getProductGalleries(
  admin: AdminClient,
  productGids: string[]
): Promise<Map<string, ProductGallery>> {
  const out = new Map<string, ProductGallery>();
  const CHUNK = 50; // well inside Shopify's per-request cost budget

  for (let i = 0; i < productGids.length; i += CHUNK) {
    const ids = productGids.slice(i, i + CHUNK);
    try {
      const data = await gql(admin, PRODUCT_GALLERIES, { ids });
      for (const node of data.nodes ?? []) {
        if (node?.id) out.set(node.id, toGallery(node));
      }
    } catch (err) {
      // A bad chunk shouldn't blank the whole screen; those products just
      // render as "missing".
      console.error("[ProductMedia] gallery batch failed:", err);
    }
  }

  return out;
}

export async function getProductGallery(
  admin: AdminClient,
  productGid: string
): Promise<ProductGallery | null> {
  const data = await gql(admin, PRODUCT_MEDIA, { id: productGid });
  const p = data.product;
  if (!p) return null;

  return {
    id: p.id,
    title: p.title,
    status: p.status,
    featuredImageUrl: p.featuredMedia?.preview?.image?.url ?? null,
    price: p.priceRangeV2?.minVariantPrice?.amount ?? null,
    currency: p.priceRangeV2?.minVariantPrice?.currencyCode ?? null,
    media: (p.media?.nodes ?? []).map((m: any) => {
      // Shopify returns several transcodes per video. Pick the smallest mp4 —
      // hover previews should start fast, not stream 1080p.
      const sources: any[] = m.sources ?? [];
      const mp4s = sources.filter((s) => (s.mimeType || s.format || "").includes("mp4"));
      const pool = mp4s.length ? mp4s : sources;
      const smallest = pool
        .slice()
        .sort((a, b) => (a.height ?? 9999) - (b.height ?? 9999))[0];

      return {
        id: m.id,
        type: m.mediaContentType,
        alt: m.alt ?? null,
        previewUrl: m.preview?.image?.url ?? null,
        hoverUrl: smallest?.url ?? null,
      };
    }),
  };
}

// ─── Reordering ───────────────────────────────────────────────────────────────

const REORDER = `#graphql
  mutation nqReorderMedia($id: ID!, $moves: [MoveInput!]!) {
    productReorderMedia(id: $id, moves: $moves) {
      job { id done }
      mediaUserErrors { code field message }
    }
  }
`;

const JOB_STATUS = `#graphql
  query nqJob($id: ID!) {
    job(id: $id) { id done }
  }
`;

/**
 * Applies a new gallery order.
 *
 * Two easy things to get wrong here, both handled: newPosition is a STRING, and
 * this mutation returns a Job rather than completing inline. We poll the job so
 * the caller can report real success — without that the merchant saves, reloads
 * and sees the old order, and concludes the feature is broken.
 */
export async function reorderProductMedia(
  admin: AdminClient,
  productGid: string,
  orderedMediaIds: string[]
): Promise<{ confirmed: boolean }> {
  const moves = orderedMediaIds.map((id, index) => ({ id, newPosition: String(index) }));

  const data = await gql(admin, REORDER, { id: productGid, moves });
  throwUserErrors(data.productReorderMedia?.mediaUserErrors);

  const jobId = data.productReorderMedia?.job?.id;
  if (!jobId || data.productReorderMedia?.job?.done) return { confirmed: true };

  // Poll until Shopify says the job is done. A product with a lot of media can
  // take well over five seconds, and the earlier version gave up at that point
  // and reported success anyway — so the merchant saw "saved", reloaded, and
  // found a half-applied order. Now the caller is told when it's unconfirmed.
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 700));
    const status = await gql(admin, JOB_STATUS, { id: jobId });
    if (status.job?.done) return { confirmed: true };
  }

  return { confirmed: false };
}

// ─── Detaching ────────────────────────────────────────────────────────────────

const FILE_UPDATE = `#graphql
  mutation nqDetach($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files { id }
      userErrors { field message }
    }
  }
`;

const FILE_DELETE = `#graphql
  mutation nqFileDelete($fileIds: [ID!]!) {
    fileDelete(fileIds: $fileIds) {
      deletedFileIds
      userErrors { field message }
    }
  }
`;

/**
 * Removes the video from the product's gallery, and deletes the underlying
 * Shopify file when nothing else is using it.
 *
 * The detach and the delete are separate steps on purpose. A file can be
 * referenced by several products, so detaching alone is correct there. But if
 * this was the last product using it, leaving the file behind would leak a slot
 * against the store's plan allowance — the merchant removes a video, sees no
 * slot freed, and eventually can't add anything at all.
 */
export async function detachVideoFromProduct(
  admin: AdminClient,
  shop: string,
  productMediaId: string
): Promise<void> {
  const row = await db.productMedia.findFirst({ where: { id: productMediaId, shop } });
  if (!row) return;

  try {
    const data = await gql(admin, FILE_UPDATE, {
      files: [{ id: row.shopifyFileId, referencesToRemove: [row.productId] }],
    });
    throwUserErrors(data.fileUpdate?.userErrors);
  } catch (err) {
    // If the file is already gone from Shopify, dropping our row is still the
    // right outcome — otherwise the merchant can never clear the entry.
    console.warn(`[ProductMedia] detach warning for ${productMediaId}:`, err);
  }

  // Keep the row as a tombstone rather than deleting it.
  //
  // autoAddMissingVideos pushes any tagged video that has no row for its
  // product. If removal deleted the row, the next page load would treat the
  // video as never-added and put it straight back — the merchant removes it,
  // it reappears, and there's no way to make it stop. A REMOVED row records
  // the decision.
  await db.productMedia.update({
    where: { id: row.id },
    data: { status: "REMOVED", shopifyFileId: "", lastError: null },
  });

  // Any other product still using this exact file?
  const stillUsed = await db.productMedia.count({
    where: { shop, shopifyFileId: row.shopifyFileId },
  });

  if (stillUsed === 0) {
    try {
      const del = await gql(admin, FILE_DELETE, { fileIds: [row.shopifyFileId] });
      throwUserErrors(del.fileDelete?.userErrors);
      console.log(`[ProductMedia] deleted Shopify file ${row.shopifyFileId}, slot freed`);
    } catch (err) {
      // Non-fatal: the video is off the product page either way. The file can
      // still be removed by hand in Shopify admin > Content > Files.
      console.warn(`[ProductMedia] could not delete file ${row.shopifyFileId}:`, err);
    }
  }
}
