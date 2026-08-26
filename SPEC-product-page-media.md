# Product-page media — research + spec (Route A)

Goal: push a video that's already in the client's R2 bucket into the Shopify
product's **native media gallery**, and let the merchant control its position —
the "Products with Videos / Arrange Media" screen.

Verified against Shopify docs, August 2026. Sources at the bottom.

---

## 1. Video requires a staged upload

**Corrected after testing.** The docs present `fileCreate` with a public
`originalSource` URL as generic across content types, and the first version of
this spec concluded we could skip staged uploads entirely. That holds for
images. It does **not** hold for video — Shopify rejects an external URL with
`Invalid video url`. Video has to be uploaded to a staged target, which is also
why the docs describe that path as "recommended for large files like videos".

Four steps:

1. Fetch the video out of R2 into memory.
2. `stagedUploadsCreate` with `resource: VIDEO`, `httpMethod: POST`, and
   `fileSize` (required for video).
3. `POST` multipart form data to the returned `url`. Every returned parameter
   must be appended **before** the `file` field — the storage backend rejects
   the upload otherwise.
4. `fileCreate` with `originalSource` set to the target's `resourceUrl`.

```graphql
mutation {
  stagedUploadsCreate(input: [{
    filename: "1234-clip.mp4",
    mimeType: "video/mp4",
    resource: VIDEO,
    fileSize: "8298186",
    httpMethod: POST
  }]) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}
```

Consequence worth noting: the video passes through our server, so a push costs
bandwidth and holds the file in memory briefly. Fine for compressed clips on a
512MB machine; it's another reason the 200MB cap matters.

## 2. Constraints that matter

| Limit | Value | Impact |
|---|---|---|
| Formats | MP4, MOV, WEBM | Our pipeline outputs MP4. Fine. |
| Max size | 1 GB | Our compressed output is far under. Fine. |
| Max duration | **10 minutes** | Reels are seconds. Fine, but validate. |
| Max resolution | 3840×2160 | Fine. |
| **Videos per store per week, per app** | **1,000** | Backfilling 120 products is fine. Matters if a client bulk-imports. Error code `VIDEO_THROTTLE_EXCEEDED`. |
| Storage quota | Videos count against the shop's quota | External videos (YouTube/Vimeo) don't, but ours aren't external. Worth telling clients. |

Shopify transcodes to 480p / 720p / 1080p and serves HLS + MP4, so the theme
gets adaptive playback for free — better than what we serve from R2 directly.

**The video ends up stored twice**: our R2 copy (which the carousel and reel
player use) and Shopify's copy (which the product gallery uses). That's
unavoidable on this route and is the main argument for Route B.

## 3. Flow

```
R2 public URL
   |
   |  fileCreate(originalSource: <r2 url>, contentType: VIDEO)
   v
gid://shopify/Video/...   fileStatus: UPLOADED
   |
   |  poll node(id) { fileStatus }        <-- async, seconds to minutes
   v
fileStatus: READY
   |
   |  productUpdate / productSet  files: [{ originalSource: <file gid>, contentType: VIDEO }]
   v
video is on the product
   |
   |  productReorderMedia(id, moves: [{ id, newPosition }])
   v
returns a Job -> poll job.done
```

Four states to handle on the poll: `UPLOADED`, `PROCESSING`, `READY`, `FAILED`.
Associating before `READY` fails, so the association step must be queued, not
fired inline.

### Association

Once ready, reference the file **by ID**, not by URL:

```graphql
mutation {
  productSet(input: {
    id: "gid://shopify/Product/123",
    files: [{ originalSource: "gid://shopify/Video/456", contentType: VIDEO }]
  }) { product { id } userErrors { field message } }
}
```

`fileUpdate` with `referencesToAdd` / `referencesToRemove` is the alternative,
and is the better fit for *detaching* a video from one product without deleting
the file.

### Reordering

```graphql
mutation {
  productReorderMedia(id: "gid://shopify/Product/123", moves: [
    { id: "gid://shopify/Video/456",      newPosition: "0" },
    { id: "gid://shopify/MediaImage/789", newPosition: "1" }
  ]) { job { id done } mediaUserErrors { code field message } }
}
```

Two things to note: positions are **strings**, and this returns a **Job** rather
than completing synchronously. The "Save Order" button must poll `job.done`
before showing success, or the merchant will reload and see the old order.

Position 0 becomes the product's primary image — it's what shows on collection
pages and search results. Putting a video at 0 changes the thumbnail everywhere,
so the UI should warn before allowing it.

## 4. Data model

We need to remember which R2 video became which Shopify file, or every re-sync
creates duplicates and reordering has nothing to reference.

```prisma
model ProductMedia {
  id            String   @id @default(cuid())
  shop          String
  videoId       String              // FK -> Video.id
  productId     String              // Shopify product GID
  shopifyFileId String              // gid://shopify/Video/...
  status        String   @default("PENDING") // PENDING|PROCESSING|READY|FAILED
  lastError     String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([shop, videoId, productId])
  @@index([shop, status])
}
```

Migration folder timestamp must sort **after** `20260801000000_ensure_video_products`,
per the existing ordering convention.

Position is deliberately not stored — Shopify owns the order. Read it from the
product's media on open, write it back on save. Caching it locally guarantees
drift the moment the merchant reorders in the Shopify admin.

## 5. Admin UI

**List screen** — "Products with Videos (n)"

- Group our `Video` rows by `productId`.
- One GraphQL call to fetch product title, price, status and existing media.
- Columns: product, price, status, media thumbnails, action.
- Per row: **Push to product page** (if not yet pushed) and **Arrange Media**.

**Arrange Media modal**

- Fetch *all* the product's media, images included — reordering only makes sense
  against the full gallery.
- Drag to reorder, number badge = position.
- Save → `productReorderMedia` → poll the job → close on `done`.

## 6. Edge cases

These are the ones that will actually cause support tickets.

| Case | Handling |
|---|---|
| Product deleted / unpublished in Shopify | The GraphQL lookup returns null. Show "product no longer available" and offer to detach. **Whatmore's own UI fails this** — their first row renders a blank product and `₹NaN`. |
| Video deleted in our app | Offer to remove from Shopify too: `fileUpdate` with `referencesToRemove` to detach, `fileDelete` only if it's on no other product. |
| Same video pushed twice | `@@unique([shop, videoId, productId])` plus a check on `shopifyFileId` before calling `fileCreate`. |
| `fileStatus: FAILED` | Surface it on the row with the reason. Most likely cause is the R2 object being unreachable. |
| `VIDEO_THROTTLE_EXCEEDED` | Show "Shopify's weekly video limit reached — try again in a few days". Don't retry in a loop. |
| Merchant reorders in Shopify admin | We never cache position, so nothing to reconcile. |
| Video over 10 min | Reject before calling `fileCreate`; we know the duration from `processVideo`. |

## 7. Build order

1. Prisma model + migration.
2. `shopifyMedia.server.ts` — `fileCreate`, poll, associate, reorder, detach.
3. Background poller for `PENDING`/`PROCESSING` rows (mirror how `processVideo`
   already runs detached).
4. List screen.
5. Arrange Media modal + job polling.
6. Edge cases from §6.

Scopes are already correct — `read_products`, `write_products`, `write_files` is
exactly what the docs require. No scope change, so no re-consent from merchants.

Ships with `fly deploy`; nothing here touches the theme extension.

## 8. Route B, for the record

Render our own gallery from R2 in a theme app extension block on the product
page. No duplicate storage, no Shopify video limits, full control of playback.
The cost is that it can't sit *inside* the native gallery — it goes above or
below it — and matching each theme's design is ongoing work. Revisit if storage
duplication or the weekly cap becomes a real problem.

---

Sources:

- Manage media for products and collections — https://shopify.dev/docs/apps/build/product-merchandising/products-and-collections/manage-media
- `fileCreate` — https://shopify.dev/docs/api/admin-graphql/latest/mutations/fileCreate
- `productReorderMedia` — https://shopify.dev/docs/api/admin-graphql/latest/mutations/productreordermedia
- `stagedUploadsCreate` — https://shopify.dev/docs/api/admin-graphql/latest/mutations/stageduploadscreate
