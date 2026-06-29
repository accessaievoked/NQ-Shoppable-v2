/**
 * One-off backfill: generate the tiny card-preview clip (previews/{baseKey}.mp4)
 * for existing videos that don't have one yet, and set Video.previewUrl.
 *
 * SAFETY GUARANTEES
 *  - Only ever ADDS objects to R2 (previews/...). Never overwrites the reel,
 *    thumbnail, or source, and never deletes anything.
 *  - Writes ONLY the previewUrl field in the DB. Product links (productId,
 *    variantId, productUrl, ...) and every other field are never touched.
 *  - Idempotent & resumable: it processes only rows where previewUrl IS NULL,
 *    and is best-effort per video (one failure never affects the others).
 *  - Sequential (one video at a time) so it stays light on the 512 MB machine.
 *
 * RUN IT ON FLY (the machine already has ffmpeg + the R2/DB secrets):
 *   fly ssh console -a nq-shoppable-v2
 *   cd /app && node scripts/backfill-previews.mjs
 */

import { PrismaClient } from "@prisma/client";
import ffmpeg from "fluent-ffmpeg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_PUBLIC_URL,
} = process.env;

for (const [k, val] of Object.entries({
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL,
})) {
  if (!val) {
    console.error(`[backfill] Missing required env var ${k} — aborting (no changes made).`);
    process.exit(1);
  }
}

const prisma = new PrismaClient();
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// Same recipe as ffmpeg.server.ts makeCardClip: first 3s, silent, 480p cap,
// +faststart. Re-encoding from the already-compressed reel is fine for a tiny
// card preview (the quality loss is invisible at card size).
function makeCardClip(inputPath, outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-t", "3",
        "-an",
        "-vf", "scale='min(480,iw)':-2",
        "-c:v", "libx264",
        "-profile:v", "main",
        "-preset", "slow",
        "-crf", "32",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
      ])
      .output(outPath)
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
}

async function downloadToTemp(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
  await fs.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

// baseKey from a compressed reel URL: ".../compressed/<baseKey>.mp4"
function baseKeyFromUrl(videoUrl) {
  const m = String(videoUrl || "").match(/\/compressed\/(.+)\.mp4(?:\?.*)?$/);
  return m ? m[1] : null;
}

async function run() {
  // Only videos still missing a preview — makes the script resumable.
  const videos = await prisma.video.findMany({
    where: { previewUrl: null },
    select: { id: true, videoUrl: true, streamUrl: true },
  });
  console.log(`[backfill] ${videos.length} video(s) without a preview`);

  let done = 0, skipped = 0, failed = 0;

  for (const v of videos) {
    const baseKey = baseKeyFromUrl(v.videoUrl);
    // No MP4 reel to clip from (HLS-only, or an admin-pasted external URL).
    // The storefront safely keeps using the full video for these.
    if (v.streamUrl || !baseKey) {
      console.log(`[backfill] skip ${v.id} (no compressed MP4 source)`);
      skipped++;
      continue;
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nq-backfill-"));
    const inputPath = path.join(tmpDir, "input.mp4");
    const clipPath = path.join(tmpDir, "preview.mp4");

    try {
      await downloadToTemp(v.videoUrl, inputPath);
      await makeCardClip(inputPath, clipPath);
      const clipBuffer = await fs.readFile(clipPath);

      const previewKey = `previews/${baseKey}.mp4`;
      await s3.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: previewKey,
        Body: clipBuffer,
        ContentType: "video/mp4",
        CacheControl: "public, max-age=31536000, immutable",
      }));

      const previewUrl = `${R2_PUBLIC_URL}/${previewKey}`;
      // ONLY previewUrl is written — every other field (product links etc.) is untouched.
      await prisma.video.update({ where: { id: v.id }, data: { previewUrl } });

      console.log(`[backfill] OK  ${v.id} -> ${previewUrl} (${Math.round(clipBuffer.length / 1024)} KB)`);
      done++;
    } catch (err) {
      console.warn(`[backfill] FAIL ${v.id}: ${err?.message || err}`);
      failed++;
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  console.log(`[backfill] complete — ${done} done, ${skipped} skipped, ${failed} failed`);
}

run()
  .catch((e) => {
    console.error("[backfill] fatal:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
