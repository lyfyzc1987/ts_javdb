import { createHash } from "node:crypto";

const base = String(
  process.env.BASE_URL || process.argv[2] || "https://ts-javdb.pages.dev",
).replace(/\/+$/, "");
const targetSeconds = Number(process.env.TARGET_SECONDS || process.argv[3] || 6040);
const itemId = String(process.env.ITEM_ID || "0eYvb");
const mediaSourceName = String(
  process.env.MEDIA_SOURCE_NAME || "fcjav 去码版",
);
const stressCount = Math.max(
  1,
  Number(process.env.STRESS_COUNT || 6),
);
const stressConcurrency = Math.max(
  1,
  Number(process.env.STRESS_CONCURRENCY || 3),
);
const requestTimeoutMs = Math.max(
  30000,
  Number(process.env.REQUEST_TIMEOUT_MS || 180000),
);
const expectedTsSha256 = String(
  process.env.EXPECTED_TS_SHA256 || "",
).trim().toLowerCase();
const expectedTsBytes = Math.max(
  0,
  Number(process.env.EXPECTED_TS_BYTES || 0),
);
const transportMode = String(process.env.PARALLEL_MODE || "parallel")
  .trim()
  .toLowerCase();
const parallelDisabled = ["0", "false", "no", "off", "serial", "single"]
  .includes(transportMode);
const expectedBuildId = String(
  process.env.EXPECTED_BUILD_ID || "2026-10-23-late-snapshot-113",
).trim();
const runDirectBench = /^(?:1|true|yes|on)$/i.test(
  String(process.env.RUN_DIRECT_BENCH || ""),
);
const sourceHeaders = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  referer: "https://getav.com/",
};

function elapsed(startedAt) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

let currentStage = "start";
function stage(name) {
  currentStage = name;
  console.error(
    `[verify-live] ${new Date().toISOString()} ${name}`,
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function embeddedTsOffset(bytes) {
  const limit = Math.min(bytes.byteLength - 188 * 3, 1024 * 1024);
  for (let offset = 0; offset <= limit; offset += 1) {
    if (
      bytes[offset] === 0x47 &&
      bytes[offset + 188] === 0x47 &&
      bytes[offset + 376] === 0x47 &&
      bytes[offset + 564] === 0x47
    ) {
      return offset;
    }
  }
  return -1;
}

function errorDetails(error) {
  const details = {
    name: error?.name || "Error",
    message: error?.message || String(error),
  };
  let cause = error?.cause;
  for (let depth = 0; cause && depth < 4; depth += 1) {
    details[`cause${depth || ""}`] = {
      name: cause.name,
      message: cause.message,
      code: cause.code,
    };
    cause = cause.cause;
  }
  return details;
}

async function readResponseBody(response, startedAt) {
  const headerMs = elapsed(startedAt);
  if (!response.body) {
    return {
      headerMs,
      firstByteMs: headerMs,
      first64KiBMs: headerMs,
      totalMs: headerMs,
      bytes: new Uint8Array(),
    };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  let firstByteMs = null;
  let first64KiBMs = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    if (firstByteMs === null) firstByteMs = elapsed(startedAt);
    byteLength += value.byteLength;
    if (first64KiBMs === null && byteLength >= 64 * 1024) {
      first64KiBMs = elapsed(startedAt);
    }
    chunks.push(value);
  }
  const totalMs = elapsed(startedAt);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    headerMs,
    firstByteMs: firstByteMs ?? totalMs,
    first64KiBMs: first64KiBMs ?? totalMs,
    totalMs,
    bytes,
  };
}

async function measuredFetch(url, headers = {}) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    headers: { ...sourceHeaders, ...headers },
    redirect: "follow",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const body = await readResponseBody(response, startedAt);
  const totalMiB = body.bytes.byteLength / 1024 / 1024;
  return {
    status: response.status,
    statusText: response.statusText,
    finalUrl: response.url,
    contentType: response.headers.get("content-type") || "",
    contentLength: response.headers.get("content-length") || "",
    contentRange: response.headers.get("content-range") || "",
    build:
      response.headers.get("x-emby-build") ||
      response.headers.get("x-bbjavdb-build") ||
      "",
    parallel: response.headers.get("x-catemby-parallel-range") || "",
    adjusted: response.headers.get("x-emby-ts-prefix-adjusted") || "",
    headerMs: body.headerMs,
    firstByteMs: body.firstByteMs,
    first64KiBMs: body.first64KiBMs,
    totalMs: body.totalMs,
    bytes: body.bytes.byteLength,
    totalMiB: Number(totalMiB.toFixed(3)),
    throughputMiBps: Number(
      (totalMiB / Math.max(body.totalMs, 1) * 1000).toFixed(3),
    ),
    packetAligned: body.bytes.byteLength % 188 === 0,
    firstByte: body.bytes[0] ?? null,
    sha256: sha256(body.bytes),
    rawBytes: body.bytes,
  };
}

function publicResult(result) {
  const { rawBytes: _rawBytes, ...visible } = result;
  return visible;
}

function proxyUrlWithTransportMode(value, disableParallel = parallelDisabled) {
  const url = new URL(value);
  if (disableParallel) {
    url.searchParams.set("_parallel", "0");
  }
  return url.href;
}

async function fetchServerInfo() {
  const url = `${base}/emby/System/Info/Public`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60000),
  });
  const payload = await response.json();
  const headerBuild =
    response.headers.get("x-emby-build") ||
    response.headers.get("x-bbjavdb-build") ||
    "";
  return {
    url,
    status: response.status,
    headerBuild,
    buildId: String(payload.BuildId || ""),
    version: String(payload.Version || ""),
  };
}

async function measureRanges(url, total, parts) {
  const baseSize = Math.floor(total / parts);
  const ranges = Array.from({ length: parts }, (_, index) => ({
    start: index * baseSize,
    end: index === parts - 1 ? total - 1 : (index + 1) * baseSize - 1,
  }));
  const startedAt = performance.now();
  const results = await Promise.all(ranges.map(async (range) => {
    const result = await measuredFetch(url, {
      range: `bytes=${range.start}-${range.end}`,
    });
    return { range, result };
  }));
  const wallMs = elapsed(startedAt);
  const bytes = results.reduce(
    (totalBytes, item) => totalBytes + item.result.bytes,
    0,
  );
  const expectedBytes = ranges.reduce(
    (totalBytes, range) => totalBytes + range.end - range.start + 1,
    0,
  );
  return {
    parts,
    wallMs,
    bytes,
    expectedBytes,
    complete: bytes === expectedBytes,
    throughputMiBps: Number(
      (bytes / 1024 / 1024 / Math.max(wallMs, 1) * 1000).toFixed(3),
    ),
    ranges: results.map(({ range, result }) => ({
      ...range,
      ...publicResult(result),
    })),
  };
}

async function fetchPlaybackInfo() {
  const url =
    `${base}/emby/Items/${itemId}/PlaybackInfo?api_key=bbjavdb-guest`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(60000),
  });
  const payload = await response.json();
  return {
    url,
    status: response.status,
    build:
      response.headers.get("x-emby-build") ||
      response.headers.get("x-bbjavdb-build") ||
      "",
    sources: (payload.MediaSources || []).map((source) => ({
      name: source.Name,
      id: source.MediaSourceId,
      path: source.Path,
    })),
    selected: payload.MediaSources?.find(
      (source) => source.Name === mediaSourceName,
    ) || null,
  };
}

stage("System Info");
const serverInfo = await fetchServerInfo();
if (
  serverInfo.status !== 200 ||
  !serverInfo.buildId ||
  serverInfo.headerBuild !== serverInfo.buildId
) {
  throw new Error(
    `Build verification failed: status=${serverInfo.status} header=${
      serverInfo.headerBuild || "<empty>"
    } body=${serverInfo.buildId || "<empty>"}`,
  );
}

stage("PlaybackInfo");
const playback = await fetchPlaybackInfo();
if (!playback.selected?.Path) {
  throw new Error(
    `Playback source "${mediaSourceName}" missing. Available: ${
      playback.sources.map((source) => source.name).join(", ")
    }`,
  );
}

stage("HLS manifest");
const manifestStartedAt = performance.now();
const manifestResponse = await fetch(playback.selected.Path, {
  signal: AbortSignal.timeout(requestTimeoutMs),
});
const manifestText = await manifestResponse.text();
const manifestMs = elapsed(manifestStartedAt);
const segments = [];
let timeline = 0;
let pendingDuration = 0;
for (const rawLine of manifestText.split(/\r?\n/)) {
  const line = rawLine.trim();
  const durationMatch = /^#EXTINF:([\d.]+)/i.exec(line);
  if (durationMatch) {
    pendingDuration = Number(durationMatch[1]);
    continue;
  }
  if (!line || line.startsWith("#")) continue;
  const segmentEnd = timeline + pendingDuration;
  segments.push({
    url: new URL(line, playback.selected.Path).href,
    start: timeline,
    end: segmentEnd,
    duration: pendingDuration,
  });
  timeline = segmentEnd;
  pendingDuration = 0;
}
const targetIndex = segments.findIndex(
  (segment) => segment.start <= targetSeconds && targetSeconds < segment.end,
);
if (targetIndex < 0) {
  throw new Error(`No segment found around ${targetSeconds} seconds`);
}
const target = segments[targetIndex];
const targetUrl = new URL(target.url);
const upstreamUrl = targetUrl.searchParams.get("url");
if (!upstreamUrl) {
  throw new Error("The selected segment does not carry an upstream URL");
}

let probeHeaderMs = null;
let probeContentRange = "";
let upstreamTotal = 0;
let directSingle = null;
let directOffset = null;
let directTsBytes = null;
const directRanges = [];
let upstreamProbeError = null;
let directSingleError = null;

if (!expectedTsSha256) {
  try {
    stage("upstream size probe");
    const probeStartedAt = performance.now();
    const probeResponse = await fetch(upstreamUrl, {
      headers: { ...sourceHeaders, range: "bytes=0-0" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    probeHeaderMs = elapsed(probeStartedAt);
    probeContentRange = probeResponse.headers.get("content-range") || "";
    await probeResponse.body?.cancel();
    const totalMatch = /\/\s*(\d+)\s*$/.exec(probeContentRange);
    upstreamTotal = Number(totalMatch?.[1]);
    if (!Number.isSafeInteger(upstreamTotal) || upstreamTotal <= 0) {
      throw new Error(
        `Cannot determine upstream size from Content-Range: ${probeContentRange}`,
      );
    }
  } catch (error) {
    upstreamProbeError = errorDetails(error);
  }

  if (upstreamTotal > 0) {
    try {
      stage("direct upstream single connection");
      directSingle = await measuredFetch(upstreamUrl, {
        range: `bytes=0-${upstreamTotal - 1}`,
      });
      directOffset = embeddedTsOffset(directSingle.rawBytes);
      if (directOffset < 0) {
        throw new Error(
          "The direct upstream response has no embedded MPEG-TS prefix",
        );
      }
      directTsBytes = directSingle.rawBytes.slice(directOffset);
    } catch (error) {
      directSingleError = errorDetails(error);
    }
  }
}

if (runDirectBench) {
  if (!upstreamTotal) {
    throw new Error("RUN_DIRECT_BENCH requires an upstream size probe");
  }
  for (const parts of [2, 3, 4, 8]) {
    stage(`direct upstream ${parts}-range`);
    directRanges.push(await measureRanges(upstreamUrl, upstreamTotal, parts));
  }
}

stage("Worker/Pages proxy segment");
const proxyResult = await measuredFetch(proxyUrlWithTransportMode(target.url));
stage("Worker/Pages serial control segment");
const serialControl = await measuredFetch(
  proxyUrlWithTransportMode(target.url, true),
);
const proxyTransportStream = /^video\/mp2t\b/i.test(
  proxyResult.contentType,
);
const proxyTransportStreamValid = !proxyTransportStream ||
  (proxyResult.packetAligned && proxyResult.firstByte === 0x47);
const expectedMatch = Boolean(
  expectedTsSha256 &&
  proxyResult.sha256 === expectedTsSha256 &&
  (!expectedTsBytes || proxyResult.bytes === expectedTsBytes)
);
const serialMatch = serialControl.status === 200 &&
  proxyResult.status === 200 &&
  proxyResult.bytes === serialControl.bytes &&
  proxyResult.sha256 === serialControl.sha256;
const directMatch = directTsBytes
  ? proxyResult.bytes === directTsBytes.byteLength &&
    proxyResult.sha256 === sha256(directTsBytes)
  : false;

const stressSegments = segments.slice(
  targetIndex,
  Math.min(segments.length, targetIndex + stressCount),
);
const stressResults = new Array(stressSegments.length);
let stressCursor = 0;
async function stressWorker() {
  for (;;) {
    const index = stressCursor;
    stressCursor += 1;
    if (index >= stressSegments.length) return;
    const segment = stressSegments[index];
    try {
      stressResults[index] = {
        index: targetIndex + index,
        start: segment.start,
        end: segment.end,
        ...publicResult(
          await measuredFetch(proxyUrlWithTransportMode(segment.url)),
        ),
      };
    } catch (error) {
      stressResults[index] = {
        index: targetIndex + index,
        start: segment.start,
        end: segment.end,
        error: errorDetails(error),
      };
    }
  }
}

const stressStartedAt = performance.now();
stage(
  `Worker/Pages stress ${stressResults.length} segments at concurrency ${
    stressConcurrency
  }`,
);
await Promise.all(
  Array.from(
    { length: Math.min(stressConcurrency, stressResults.length) },
    stressWorker,
  ),
);
const stressWallMs = elapsed(stressStartedAt);
const successfulStress = stressResults.filter(
  (result) => result.status === 200,
);
const transportStreamStress = successfulStress.filter((result) =>
  /^video\/mp2t\b/i.test(result.contentType || "")
);
const transportStreamStressValid = transportStreamStress.every(
  (result) => result.packetAligned && result.firstByte === 0x47,
);
const totalStressBytes = successfulStress.reduce(
  (totalBytes, result) => totalBytes + (result.bytes || 0),
  0,
);

const summary = {
  base,
  build: serverInfo.buildId,
  transportMode: parallelDisabled ? "single-upstream" : "rolling-parallel",
  serverInfo,
  targetSeconds,
  source: {
    name: playback.selected.Name,
    id: playback.selected.MediaSourceId,
    path: playback.selected.Path,
  },
  playbackSources: playback.sources,
  manifest: {
    status: manifestResponse.status,
    manifestMs,
    segments: segments.length,
    targetIndex,
    targetStart: target.start,
    targetEnd: target.end,
    targetDuration: target.duration,
  },
  upstream: {
    url: upstreamUrl,
    probeHeaderMs,
    contentRange: probeContentRange,
    total: upstreamTotal,
    probeError: upstreamProbeError,
    directEmbeddedOffset: directOffset,
    directTsBytes: directTsBytes?.byteLength ?? null,
    directTsSha256: directTsBytes ? sha256(directTsBytes) : null,
    directSingleError,
    expectedTsBytes: expectedTsBytes || null,
    expectedTsSha256: expectedTsSha256 || null,
  },
  directSingle: directSingle
    ? {
      ...publicResult(directSingle),
      embeddedOffset: directOffset,
    }
    : null,
  directRanges,
  proxySegment: publicResult(proxyResult),
  serialControl: publicResult(serialControl),
  transportStreamValidation: {
    target: proxyTransportStream,
    targetValid: proxyTransportStreamValid,
    stressTransportStreamSegments: transportStreamStress.length,
    stressOtherSegments: successfulStress.length - transportStreamStress.length,
    stressValid: transportStreamStressValid,
  },
  serialMatch,
  byteExactMatch: directMatch,
  expectedHashMatch: expectedMatch,
  stress: {
    count: stressResults.length,
    concurrency: stressConcurrency,
    wallMs: stressWallMs,
    successful: successfulStress.length,
    totalMiB: Number((totalStressBytes / 1024 / 1024).toFixed(3)),
    aggregateMiBps: Number(
      (totalStressBytes / 1024 / 1024 / Math.max(stressWallMs, 1) * 1000)
        .toFixed(3),
    ),
    packetAligned: transportStreamStressValid,
    results: stressResults,
  },
};

console.log(JSON.stringify(summary, null, 2));

if (
  serverInfo.buildId !== expectedBuildId ||
  serverInfo.headerBuild !== serverInfo.buildId ||
  (playback.build && playback.build !== serverInfo.buildId) ||
  manifestResponse.status !== 200 ||
  proxyResult.status !== 200 ||
  serialControl.status !== 200 ||
  !(serialMatch || directMatch || expectedMatch) ||
  !proxyTransportStreamValid ||
  successfulStress.length !== stressResults.length ||
  !transportStreamStressValid
) {
  process.exitCode = 1;
}

