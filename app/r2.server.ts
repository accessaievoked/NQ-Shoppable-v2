import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME!;
export const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!;

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Uploads a file buffer to R2 and returns the public URL.
 * @param key      Path inside the bucket, e.g. "videos/my-video.mp4"
 * @param body     File contents as Buffer or Uint8Array
 * @param mimeType e.g. "video/mp4"
 */
export async function uploadToR2(
  key: string,
  body: Buffer | Uint8Array,
  mimeType: string
): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: mimeType,
    })
  );

  return `${R2_PUBLIC_URL}/${key}`;
}

/**
 * Converts a public R2 URL back to a bucket key.
 * e.g. "https://pub-xxx.r2.dev/thumbnails/abc.jpg" → "thumbnails/abc.jpg"
 */
function urlToKey(url: string): string | null {
  try {
    const publicUrl = process.env.R2_PUBLIC_URL!;
    if (!url.startsWith(publicUrl)) return null;
    return url.slice(publicUrl.length + 1); // strip trailing slash too
  } catch {
    return null;
  }
}

/**
 * Deletes all objects under a given prefix (e.g. "hls/my-video/").
 */
async function deletePrefix(prefix: string): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const objects = list.Contents?.map((o) => ({ Key: o.Key! })) ?? [];
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: R2_BUCKET_NAME,
          Delete: { Objects: objects },
        })
      );
    }

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
}

/**
 * Deletes all R2 assets associated with a video:
 *  - Original MP4 (videoUrl)
 *  - Thumbnail (thumbnailUrl)
 *  - HLS playlist + all segments (streamUrl prefix)
 */
export async function deleteVideoFromR2(params: {
  videoUrl?: string | null;
  thumbnailUrl?: string | null;
  streamUrl?: string | null;
}): Promise<void> {
  const tasks: Promise<void>[] = [];

  // Delete original MP4
  if (params.videoUrl) {
    const key = urlToKey(params.videoUrl);
    if (key) {
      tasks.push(
        s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key })).then(() => {})
      );
    }
  }

  // Delete thumbnail
  if (params.thumbnailUrl) {
    const key = urlToKey(params.thumbnailUrl);
    if (key) {
      tasks.push(
        s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key })).then(() => {})
      );
    }
  }

  // Delete all HLS files (playlist + .ts segments)
  if (params.streamUrl) {
    const key = urlToKey(params.streamUrl); // e.g. "hls/abc/playlist.m3u8"
    if (key) {
      const prefix = key.replace("playlist.m3u8", ""); // "hls/abc/"
      tasks.push(deletePrefix(prefix));
    }
  }

  await Promise.all(tasks);
}
