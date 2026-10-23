/**
 * Backfill Video.duration on existing rows.
 *
 * WHY: processVideo always probed the duration (to pick a thumbnail offset and
 * decide whether a card clip was worth encoding) but never returned it, so
 * Video.duration stayed null on every row ever created. The pipeline now
 * persists it, but only for videos processed after that fix — this fills in
 * everything older.
 *
 * NOTHING IS RE-UPLOADED OR RE-ENCODED. ffprobe reads the container header
 * straight off the public R2 URL over HTTP range requests, downloading a few
 * KB rather than the whole file. Reprocessing through the admin's Retry button
 * would re-encode with a fresh base key, generating new R2 objects and
 * orphaning the old ones — this avoids all of that.
 *
 * SAFETY
 *  - Writes ONLY Video.duration. Every other column is untouched.
 *  - Skips rows that already have a duration, and rows with no videoUrl.
 *  - Idempotent: re-run anytime, it only fills blanks.
 *  - --dry prints what WOULD change and writes nothing.
 *
 * USAGE (on the Fly machine, which has ffprobe and DATABASE_URL):
 *   fly ssh console -a nq-shoppable-v2
 *   cd /app
 *   node scripts/backfill-durations.mjs --dry     # preview first
 *   node scripts/backfill-durations.mjs           # apply
 *
 * Optional: --shop=8613a2-5.myshopify.com to limit to one store.
 */

import { PrismaClient } from "@prisma/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const prisma = new PrismaClient();

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const SHOP = args.find((a) => a.startsWith("--shop="))?.split("=")[1] ?? null;

/** Seconds, or null when the file can't be read or has no duration. */
async function probeDuration(url) {
  try {
    const { stdout } = await run(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        // Let ffprobe range-request rather than stream the whole object.
        "-headers", "",
        url,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 }
    );
    const secs = Number(String(stdout).trim());
    return Number.isFinite(secs) && secs > 0 ? Math.round(secs) : null;
  } catch (err) {
    console.warn(`  ffprobe failed: ${String(err?.message ?? err).slice(0, 120)}`);
    return null;
  }
}

async function main() {
  const where = {
    duration: null,
    videoUrl: { not: "" },
    ...(SHOP ? { shop: SHOP } : {}),
  };

  const videos = await prisma.video.findMany({
    where,
    select: { id: true, shop: true, title: true, videoUrl: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(
    `${videos.length} video(s) with no duration${SHOP ? ` for ${SHOP}` : ""}` +
      `${DRY ? "  [dry run — nothing will be written]" : ""}`
  );
  if (!videos.length) return;

  let filled = 0;
  let skipped = 0;

  for (const v of videos) {
    const label = (v.title || "untitled").slice(0, 50);
    const seconds = await probeDuration(v.videoUrl);

    if (seconds === null) {
      console.log(`SKIP  ${label}`);
      skipped++;
      continue;
    }

    if (DRY) {
      console.log(`WOULD ${label}  ->  ${seconds}s`);
      filled++;
      continue;
    }

    await prisma.video.update({ where: { id: v.id }, data: { duration: seconds } });
    console.log(`OK    ${label}  ->  ${seconds}s`);
    filled++;
  }

  console.log(`\n${DRY ? "would fill" : "filled"} ${filled}, skipped ${skipped}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
