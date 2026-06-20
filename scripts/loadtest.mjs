#!/usr/bin/env node
/**
 * Simple load test for the NQ Shoppable Videos backend.
 *
 * Exercises the two storefront endpoints that hit Neon Postgres:
 *   - GET  /api/videos?shop=...   (read path)
 *   - POST /api/track             (write path — only if --videoId is given)
 *
 * It fires requests with a fixed concurrency for a set duration and reports
 * throughput, success rate, error breakdown, and latency percentiles. This is
 * what you use to confirm the app + Neon connection pooling hold up under load
 * instead of throwing "too many connections" or 5xx errors.
 *
 * USAGE (PowerShell — run from the nq-shoppable-v2 folder):
 *
 *   # Read load: 50 concurrent for 30s against your store
 *   node scripts/loadtest.mjs --base https://nq-shoppable-v2.fly.dev --shop your-store.myshopify.com --concurrency 50 --duration 30
 *
 *   # Mixed read + write (pass a real videoId from your DB to also test ATC writes)
 *   node scripts/loadtest.mjs --base https://nq-shoppable-v2.fly.dev --shop your-store.myshopify.com --videoId clxxxx --writeRatio 0.2 --concurrency 50 --duration 30
 *
 * FLAGS:
 *   --base         Backend base URL (required), e.g. https://nq-shoppable-v2.fly.dev
 *   --shop         Shop domain for the read query (required), e.g. store.myshopify.com
 *   --concurrency  Number of parallel workers (default 25)
 *   --duration     Test length in seconds (default 20)
 *   --videoId      If set, enables POST /api/track writes for this video id
 *   --writeRatio   Fraction of requests that are writes when --videoId is set (default 0.1)
 *   --type         Track event type for writes: VIEW or ATC (default VIEW)
 */

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base || "").replace(/\/$/, "");
const SHOP = args.shop;
const CONCURRENCY = Number(args.concurrency || 25);
const DURATION = Number(args.duration || 20);
const VIDEO_ID = args.videoId || null;
const WRITE_RATIO = VIDEO_ID ? Number(args.writeRatio ?? 0.1) : 0;
const TRACK_TYPE = (args.type || "VIEW").toUpperCase();

if (!BASE || !SHOP) {
  console.error("ERROR: --base and --shop are required.\nExample:\n  node scripts/loadtest.mjs --base https://nq-shoppable-v2.fly.dev --shop store.myshopify.com --concurrency 50 --duration 30");
  process.exit(1);
}

const latencies = [];
let total = 0, ok = 0, failed = 0, reads = 0, writes = 0;
const statusCounts = {};
const errorCounts = {};

const endAt = Date.now() + DURATION * 1000;

async function readReq() {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/videos?shop=${encodeURIComponent(SHOP)}`, {
      headers: { "accept": "application/json" },
    });
    record(t0, res.status);
    // Drain body so the connection frees up.
    await res.text();
  } catch (err) {
    recordError(t0, err);
  }
}

async function writeReq() {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: TRACK_TYPE, videoId: VIDEO_ID }),
    });
    record(t0, res.status);
    await res.text();
  } catch (err) {
    recordError(t0, err);
  }
}

function record(t0, status) {
  const ms = performance.now() - t0;
  latencies.push(ms);
  total++;
  statusCounts[status] = (statusCounts[status] || 0) + 1;
  if (status >= 200 && status < 400) ok++;
  else failed++;
}

function recordError(t0, err) {
  const ms = performance.now() - t0;
  latencies.push(ms);
  total++;
  failed++;
  const key = err.code || err.name || String(err.message || err).slice(0, 60);
  errorCounts[key] = (errorCounts[key] || 0) + 1;
}

async function worker() {
  while (Date.now() < endAt) {
    if (WRITE_RATIO > 0 && Math.random() < WRITE_RATIO) {
      writes++;
      await writeReq();
    } else {
      reads++;
      await readReq();
    }
  }
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

console.log(`\nLoad test → ${BASE}`);
console.log(`shop=${SHOP} | concurrency=${CONCURRENCY} | duration=${DURATION}s` +
  (VIDEO_ID ? ` | writes=${(WRITE_RATIO * 100).toFixed(0)}% (${TRACK_TYPE})` : ` | reads only`));
console.log("Running...\n");

const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const elapsed = (performance.now() - started) / 1000;

console.log("================ RESULTS ================");
console.log(`Duration:        ${elapsed.toFixed(1)}s`);
console.log(`Total requests:  ${total}  (reads=${reads}, writes=${writes})`);
console.log(`Throughput:      ${(total / elapsed).toFixed(1)} req/s`);
console.log(`Success (2xx/3xx): ${ok}  (${((ok / total) * 100).toFixed(1)}%)`);
console.log(`Failed:          ${failed}  (${((failed / total) * 100).toFixed(1)}%)`);
console.log(`\nLatency (ms):  p50=${pct(latencies, 50).toFixed(0)}  p95=${pct(latencies, 95).toFixed(0)}  p99=${pct(latencies, 99).toFixed(0)}  max=${Math.max(...latencies).toFixed(0)}`);
console.log(`\nStatus codes:`, statusCounts);
if (Object.keys(errorCounts).length) console.log(`Network errors:`, errorCounts);
console.log("=========================================\n");

// Non-zero exit if any failures, so this can gate a CI/handoff check.
process.exit(failed > 0 ? 1 : 0);
