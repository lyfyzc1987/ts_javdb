import { performance } from "node:perf_hooks";

const [manifestUrl, segmentIndexArg = "0", concurrencyArg = "8"] = process.argv.slice(2);
if (!manifestUrl) {
  console.error(
    "Usage: node scripts/benchmark-segment.mjs <manifest-url> [segment-index] [concurrency]",
  );
  process.exit(2);
}

const segmentIndex = Math.max(0, Number.parseInt(segmentIndexArg, 10) || 0);
const concurrency = Math.max(2, Number.parseInt(concurrencyArg, 10) || 8);
const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  referer: "https://getav.com/",
};

function elapsed(start) {
  return Math.round((performance.now() - start) * 10) / 10;
}

function formatBytes(value) {
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

function logResult(label, result) {
  console.log(
    JSON.stringify(
      {
        label,
        ...result,
        totalMiB: result.bytes == null ? null : Number((result.bytes / 1024 / 1024).toFixed(2)),
        throughputMiBps:
          result.bytes == null || !result.totalMs
            ? null
            : Number((result.bytes / 1024 / 1024 / (result.totalMs / 1000)).toFixed(2)),
      },
      null,
      2,
    ),
  );
}

async function readManifest() {
  const started = performance.now();
  const response = await fetch(manifestUrl, { headers: requestHeaders });
  if (!response.ok) {
    throw new Error(`Manifest request failed: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  const segmentPaths = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!segmentPaths[segmentIndex]) {
    throw new Error(`Segment ${segmentIndex} is missing from manifest`);
  }
  const manifestUrlObject = new URL(manifestUrl);
  return {
    segmentUrl: new URL(segmentPaths[segmentIndex], manifestUrlObject).href,
    manifestMs: elapsed(started),
    segmentCount: segmentPaths.length,
  };
}

async function getSegmentLength(segmentUrl) {
  const started = performance.now();
  const response = await fetch(segmentUrl, {
    headers: {
      ...requestHeaders,
      range: "bytes=0-0",
    },
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentRange = response.headers.get("content-range") || "";
  const match = contentRange.match(/^bytes\s+\d+-\d+\/(\d+)$/);
  if (!response.ok || !match) {
    throw new Error(
      `Range probe failed: ${response.status} ${response.statusText}, content-range=${contentRange}`,
    );
  }
  return {
    bytes: bytes.byteLength,
    contentRange,
    contentType: response.headers.get("content-type") || "",
    contentLengthHeader: response.headers.get("content-length") || "",
    total: Number(match[1]),
    elapsedMs: elapsed(started),
  };
}

async function readBodyWithMilestones(response, started) {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const firstByteMs = elapsed(started);
    return {
      bytes,
      firstByteMs,
      first512Ms: firstByteMs,
      totalMs: firstByteMs,
    };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  let firstByteMs = null;
  let first512Ms = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.byteLength) {
      const now = elapsed(started);
      if (firstByteMs == null) firstByteMs = now;
      byteLength += value.byteLength;
      if (first512Ms == null && byteLength >= 512) first512Ms = now;
      chunks.push(value);
    }
  }
  const totalMs = elapsed(started);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, firstByteMs, first512Ms, totalMs };
}

async function timedFetch(segmentUrl, headers = {}) {
  const started = performance.now();
  const response = await fetch(segmentUrl, {
    headers: {
      ...requestHeaders,
      ...headers,
    },
  });
  const headerMs = elapsed(started);
  const body = await readBodyWithMilestones(response, started);
  return {
    status: response.status,
    statusText: response.statusText,
    contentRange: response.headers.get("content-range") || "",
    contentLengthHeader: response.headers.get("content-length") || "",
    contentType: response.headers.get("content-type") || "",
    headerMs,
    ...body,
  };
}

async function benchmarkFull(segmentUrl, total) {
  const result = await timedFetch(segmentUrl);
  if (!result.status || result.status >= 400) {
    throw new Error(`Full request failed: ${result.status} ${result.statusText}`);
  }
  if (result.bytes.byteLength !== total) {
    throw new Error(`Full request returned ${result.bytes.byteLength}, expected ${total}`);
  }
  return result;
}

async function benchmarkRanges(segmentUrl, total, parts) {
  const chunkSize = Math.ceil(total / parts);
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: parts }, (_, index) => {
      const start = index * chunkSize;
      const end = Math.min(total - 1, start + chunkSize - 1);
      return timedFetch(segmentUrl, {
        range: `bytes=${start}-${end}`,
      }).then((result) => ({ ...result, start, end }));
    }),
  );
  const wallMs = elapsed(started);
  let bytes = 0;
  for (const result of results) {
    if (result.status !== 206) {
      throw new Error(`Range request failed: ${result.status} ${result.statusText}`);
    }
    bytes += result.bytes.byteLength;
  }
  if (bytes !== total) {
    throw new Error(`Concurrent ranges returned ${bytes}, expected ${total}`);
  }
  return {
    wallMs,
    bytes,
    ranges: results.map((result) => ({
      start: result.start,
      end: result.end,
      status: result.status,
      contentRange: result.contentRange,
      headerMs: result.headerMs,
      firstByteMs: result.firstByteMs,
      first512Ms: result.first512Ms,
      totalMs: result.totalMs,
      bytes: result.bytes.byteLength,
    })),
  };
}

const manifest = await readManifest();
console.log(
  JSON.stringify(
    {
      manifestMs: manifest.manifestMs,
      segmentCount: manifest.segmentCount,
      segmentIndex,
      segmentUrl: manifest.segmentUrl,
    },
    null,
    2,
  ),
);

const probe = await getSegmentLength(manifest.segmentUrl);
console.log(JSON.stringify({ probe, totalMiB: Number((probe.total / 1024 / 1024).toFixed(2)) }, null, 2));

const full = await benchmarkFull(manifest.segmentUrl, probe.total);
logResult("single-full", {
  status: full.status,
  headerMs: full.headerMs,
  firstByteMs: full.firstByteMs,
  first512Ms: full.first512Ms,
  totalMs: full.totalMs,
  bytes: full.bytes.byteLength,
});

const concurrent = await benchmarkRanges(manifest.segmentUrl, probe.total, concurrency);
logResult(`range-${concurrency}`, {
  totalMs: concurrent.wallMs,
  bytes: concurrent.bytes,
});
console.log(JSON.stringify({ ranges: concurrent.ranges }, null, 2));
