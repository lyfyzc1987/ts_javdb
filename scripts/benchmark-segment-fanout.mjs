import { performance } from "node:perf_hooks";

const [manifestUrl, startArg = "1", countArg = "4"] = process.argv.slice(2);
if (!manifestUrl) {
  console.error(
    "Usage: node scripts/benchmark-segment-fanout.mjs <manifest-url> [start-index] [count]",
  );
  process.exit(2);
}

const startIndex = Math.max(0, Number.parseInt(startArg, 10) || 0);
const count = Math.max(1, Math.min(12, Number.parseInt(countArg, 10) || 4));
const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  referer: "https://getav.com/",
};

function elapsed(start) {
  return Math.round((performance.now() - start) * 10) / 10;
}

async function readSegmentUrls() {
  const response = await fetch(manifestUrl, { headers: requestHeaders });
  if (!response.ok) {
    throw new Error(`Manifest request failed: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  const paths = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return paths.slice(startIndex, startIndex + count).map((path) =>
    new URL(path, new URL(manifestUrl)).href,
  );
}

async function fetchSegment(segmentUrl, index) {
  const started = performance.now();
  const response = await fetch(segmentUrl, { headers: requestHeaders });
  const headerMs = elapsed(started);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    index: startIndex + index,
    status: response.status,
    contentRange: response.headers.get("content-range") || "",
    contentLengthHeader: response.headers.get("content-length") || "",
    headerMs,
    totalMs: elapsed(started),
    bytes: bytes.byteLength,
  };
}

const segmentUrls = await readSegmentUrls();
if (segmentUrls.length !== count) {
  throw new Error(`Expected ${count} segments, found ${segmentUrls.length}`);
}

const wallStart = performance.now();
const results = await Promise.all(segmentUrls.map(fetchSegment));
const wallMs = elapsed(wallStart);
const totalBytes = results.reduce((sum, result) => sum + result.bytes, 0);

console.log(
  JSON.stringify(
    {
      startIndex,
      count,
      wallMs,
      totalMiB: Number((totalBytes / 1024 / 1024).toFixed(2)),
      aggregateMiBps: Number(
        (totalBytes / 1024 / 1024 / (wallMs / 1000)).toFixed(2),
      ),
      results,
    },
    null,
    2,
  ),
);
