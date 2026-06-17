import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME!;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!;

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Downloads a file from a URL to a local temp path.
 */
async function downloadToTemp(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buffer);
}

/**
 * Extracts a single frame from a video at the given time offset (seconds).
 * Saves it as a WebP to outPath (smaller than JPEG at equivalent quality).
 */
function extractFrame(inputPath: string, outPath: string, timeOffset = 1): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(timeOffset)
      .outputOptions(["-vframes 1", "-f webp", "-quality 82"])
      .output(outPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

/**
 * Compresses an MP4 into a small, web-optimised reel clip — the same strategy
 * Quinn uses (tiny progressive MP4, ~150–400 KB for a few-second clip).
 *
 * Key choices:
 *  - libx264 re-encode (NOT -codec copy) so the file is actually small.
 *  - scale longest-cap to 720px wide; vertical reels become ~720x1280.
 *  - CRF 30 + veryfast = good quality at a tiny size. Raise CRF (32–34) for
 *    even smaller files, lower it (26–28) for higher quality.
 *  - -movflags +faststart moves the moov atom to the front so the browser can
 *    start playback after the first few KB instead of downloading the whole file.
 *  - yuv420p for universal browser/mobile compatibility.
 */
function compressToMp4(inputPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-vf", "scale='min(720,iw)':-2", // cap width at 720, keep aspect, even height
        "-c:v", "libx264",
        "-profile:v", "main",
        "-preset", "veryfast",
        "-crf", "30",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "96k",
        "-movflags", "+faststart",
      ])
      .output(outPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

/**
 * Given an MP4 URL, compresses it into a small web-optimised MP4 (Quinn-style),
 * extracts a thumbnail frame, uploads both to R2, and returns the public URLs.
 *
 * We no longer produce HLS: for short reel clips a single small progressive MP4
 * (with +faststart + range support + long cache) starts faster and transitions
 * more smoothly than HLS, which adds a per-video manifest/segment handshake.
 * streamUrl is returned as null so the storefront plays the MP4 directly.
 *
 * @param mp4Url    Public R2 URL of the source MP4
 * @param baseKey   Base R2 key, e.g. "1234567890-my-product"
 *                  Compressed MP4 → compressed/{baseKey}.mp4
 *                  Thumbnail      → thumbnails/{baseKey}.webp
 */
export async function processVideo(
  mp4Url: string,
  baseKey: string
): Promise<{ compressedUrl: string; streamUrl: string | null; thumbnailUrl: string }> {
  const tmpDir         = await fs.mkdtemp(path.join(os.tmpdir(), "nq-video-"));
  const inputPath      = path.join(tmpDir, "input.mp4");
  const thumbPath      = path.join(tmpDir, "thumbnail.webp");
  const compressedPath = path.join(tmpDir, "compressed.mp4");

  try {
    // 1. Download the original video
    console.log(`[Video] Downloading ${mp4Url}`);
    await downloadToTemp(mp4Url, inputPath);

    // 2. Extract thumbnail & compress to a small MP4 in parallel
    console.log(`[Video] Extracting thumbnail & compressing to MP4`);
    await Promise.all([
      extractFrame(inputPath, thumbPath, 1),
      compressToMp4(inputPath, compressedPath),
    ]);

    // 3. Upload thumbnail (immutable, 1-year cache)
    const thumbBuffer = await fs.readFile(thumbPath);
    const thumbKey    = `thumbnails/${baseKey}.webp`;
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: thumbKey,
      Body: thumbBuffer,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000, immutable",
    }));

    // 4. Upload compressed MP4 (immutable, 1-year cache; R2 serves range requests)
    const mp4Buffer = await fs.readFile(compressedPath);
    const mp4Key    = `compressed/${baseKey}.mp4`;
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: mp4Key,
      Body: mp4Buffer,
      ContentType: "video/mp4",
      CacheControl: "public, max-age=31536000, immutable",
    }));

    const compressedUrl = `${R2_PUBLIC_URL}/${mp4Key}`;
    const thumbnailUrl  = `${R2_PUBLIC_URL}/${thumbKey}`;
    const sizeKB        = Math.round(mp4Buffer.length / 1024);
    console.log(`[Video] Done — mp4: ${compressedUrl} (${sizeKB} KB) | thumb: ${thumbnailUrl}`);

    return { compressedUrl, streamUrl: null, thumbnailUrl };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
