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
 * Saves it as a JPEG to outPath.
 */
function extractFrame(inputPath: string, outPath: string, timeOffset = 1): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .seekInput(timeOffset)
      .outputOptions(["-vframes 1", "-f image2"])
      .output(outPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

/**
 * Compresses a video to a web-optimised H.264 MP4.
 * - Scales down to max 1080p height (won't upscale smaller videos)
 * - CRF 23 — standard web quality, visually sharp
 * - faststart — moov atom at the front so browsers can play before full download
 */
function compressToMp4(inputPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-vf", "scale=-2:min(1080\\,ih)",
        "-c:v", "libx264",
        "-crf", "23",
        "-preset", "fast",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
      ])
      .output(outPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

/**
 * Runs FFmpeg to convert an MP4 to HLS segments.
 * Outputs: playlist.m3u8 + segment000.ts, segment001.ts, ...
 */
function convertToHLS(inputPath: string, outputDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-codec: copy",       // copy streams — no re-encode, maximum speed
        "-start_number 0",
        "-hls_time 2",        // 2-second segments
        "-hls_list_size 0",   // include all segments in playlist
        "-f hls",
      ])
      .output(path.join(outputDir, "playlist.m3u8"))
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

/**
 * Uploads all files in a local directory to R2 under a given key prefix.
 */
async function uploadDirToR2(localDir: string, r2Prefix: string): Promise<void> {
  const files = await fs.readdir(localDir);
  await Promise.all(
    files.map(async (filename) => {
      const buffer = await fs.readFile(path.join(localDir, filename));
      const contentType = filename.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : "video/mp2t";
      await s3.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: `${r2Prefix}/${filename}`,
          Body: buffer,
          ContentType: contentType,
        })
      );
    })
  );
}

/**
 * Given an MP4 URL, converts it to HLS, extracts a thumbnail frame,
 * uploads everything to R2, and returns both public URLs.
 *
 * @param mp4Url    Public R2 URL of the source MP4
 * @param baseKey   Base R2 key, e.g. "1234567890-my-product"
 *                  HLS → hls/{baseKey}/playlist.m3u8
 *                  Thumbnail → thumbnails/{baseKey}.jpg
 */
export async function processVideo(
  mp4Url: string,
  baseKey: string
): Promise<{ compressedUrl: string; streamUrl: string; thumbnailUrl: string }> {
  const tmpDir         = await fs.mkdtemp(path.join(os.tmpdir(), "nq-video-"));
  const inputPath      = path.join(tmpDir, "input.mp4");
  const compressedPath = path.join(tmpDir, "compressed.mp4");
  const thumbPath      = path.join(tmpDir, "thumbnail.jpg");
  const hlsDir         = path.join(tmpDir, "hls");
  await fs.mkdir(hlsDir);

  try {
    // 1. Download the original video
    console.log(`[Video] Downloading ${mp4Url}`);
    await downloadToTemp(mp4Url, inputPath);

    // 2. Compress to 720p H.264 (the main perf win — small file, faststart)
    console.log(`[Video] Compressing to 720p H.264`);
    await compressToMp4(inputPath, compressedPath);

    // 3. Upload compressed MP4 to R2
    const compressedBuffer = await fs.readFile(compressedPath);
    const compressedKey    = `videos/${baseKey}-web.mp4`;
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: compressedKey,
      Body: compressedBuffer,
      ContentType: "video/mp4",
    }));
    const compressedUrl = `${R2_PUBLIC_URL}/${compressedKey}`;
    console.log(`[Video] Compressed → ${compressedUrl}`);

    // 4. Extract thumbnail & HLS from the compressed file (fast — already H.264)
    console.log(`[Video] Extracting thumbnail & converting to HLS`);
    await Promise.all([
      extractFrame(compressedPath, thumbPath, 1),
      convertToHLS(compressedPath, hlsDir),
    ]);

    // 5. Upload thumbnail
    const thumbBuffer = await fs.readFile(thumbPath);
    const thumbKey    = `thumbnails/${baseKey}.jpg`;
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: thumbKey,
      Body: thumbBuffer,
      ContentType: "image/jpeg",
    }));

    // 6. Upload HLS chunks + playlist
    const hlsKey = `hls/${baseKey}`;
    await uploadDirToR2(hlsDir, hlsKey);

    const streamUrl    = `${R2_PUBLIC_URL}/${hlsKey}/playlist.m3u8`;
    const thumbnailUrl = `${R2_PUBLIC_URL}/${thumbKey}`;
    console.log(`[Video] Done — stream: ${streamUrl} | thumb: ${thumbnailUrl}`);

    return { compressedUrl, streamUrl, thumbnailUrl };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
