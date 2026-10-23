// MemoJav 番号 → 永久短链 → 动态解析播放源。
//
// 设计目标与 MemoJavstrm 一致：播放器（Emby / VLC / PotPlayer）请求本服务
// 的短链时，默认返回 302，让客户端一跳直达上游；Worker 只处理这一次
// 重定向请求，清单和分片都不经过 Worker，实现“零流量”。
//
// 路由挂在独立的 /memo/ 前缀下，避免和现有 Emby / 站点代理路由冲突：
//
//   GET /memo/<番号>              → 302 到第一条真实播放源（默认，零流量）
//   GET /memo/<番号>?sources=1    → 返回上游真实播放源列表（HLS / MP4 清晰度）
//   GET /memo/<番号>?source=<id>  → 302 到指定播放源
//   GET /memo/<番号>?json=1       → 返回解析结果 JSON（调试）
//   GET /memo/<番号>?refresh=1    → 绕过解析缓存强制重新探测
//   GET /memo/<番号>?proxy=1      → 反向代理 HLS 清单并改写为走本服务
//   GET /memo/<番号>?web=1        → 浏览器播放页（同源代理，仅预览用）
//   GET /memo/<番号>/<分片>       → proxy 模式下的分片 / init.mp4 转发
//
// 上游（2026-10-12 实测）：
//   https://memojav.org/hls/get_video_info.php?id=<番号>&sig=...&sts=...
//   - 这是详情页播放器真正使用的接口，返回 hls 或 mp4；
//   - mp4 原生提供 1080p / 720p / 360p 三条清晰度（url=m37/m22/m18）；
//   - hls 上游当前只有一条 master.m3u8，不能伪造出并不存在的清晰度，
//     因此真实线路只给一条，另外补一条明确标注的代理兜底源。

export const MEMOJAV_ROUTE_PREFIX = "/memo/";

export const MEMOJAV_BUILD_ID = "2026-10-23-memojav-quality-labels-5";

// 上游媒体域名。video10 是 2026-09 实测唯一可用的域名；其余留作候选，
// 按顺序探测，命中第一个真正返回 HLS 清单的域名。
const DEFAULT_MEDIA_HOSTS = ["video10.memojav.net"];

// 解析结果缓存时长（秒）。命中缓存时 302/代理都不再探测上游。
const DEFAULT_CACHE_TTL_SECONDS = 600;
// 未命中的负缓存时长（秒）：新上架番号能较快出现，又不会被 404 打穿上游。
const NEGATIVE_CACHE_TTL_SECONDS = 60;
const MEMORY_CACHE_MAX_ENTRIES = 512;

const INFO_ORIGIN = "https://memojav.org";
const INFO_PATH = "/hls/get_video_info.php";
const INFO_REFERER_PREFIX = "https://memojav.org/embed/";

// 上游 mp4 播放器把同一地址按 `=m37/=m22/=m18` 后缀切成三档清晰度。
const MP4_QUALITIES = [
  { id: "mp4-1080", suffix: "m37", height: 1080, name: "MemoJav 1080P" },
  { id: "mp4-720", suffix: "m22", height: 720, name: "MemoJav 720P" },
  { id: "mp4-360", suffix: "m18", height: 360, name: "MemoJav 360P" },
];

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.-]{0,63}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/;

const RESOLVE_MEMORY = new Map();

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function mediaHosts(env) {
  const raw = String(env?.MEMOJAV_MEDIA_HOSTS || "");
  const list = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : DEFAULT_MEDIA_HOSTS;
}

function cacheTtlSeconds(env) {
  const value = Number.parseInt(env?.MEMOJAV_CACHE_TTL, 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CACHE_TTL_SECONDS;
}

function buildId(env) {
  return String(env?.MEMOJAV_BUILD_ID || MEMOJAV_BUILD_ID);
}

/** 是否默认附加“代理兜底源”。MEMOJAV_INCLUDE_PROXY_SOURCE=false 可关闭。 */
export function memoIncludeProxySource(env) {
  const raw = String(env?.MEMOJAV_INCLUDE_PROXY_SOURCE ?? "true")
    .trim()
    .toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off" && raw !== "no";
}

function isAllowedMemoHost(hostname, env) {
  const host = String(hostname || "").toLowerCase();
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return false;
  if (mediaHosts(env).includes(host)) return true;
  return host === "memojav.net" || host.endsWith(".memojav.net");
}

/** 规范化番号：去扩展名、去空白、统一大写。 */
function normalizeCode(raw) {
  let code = String(raw || "").trim();
  if (!code) return "";
  try {
    code = decodeURIComponent(code);
  } catch {
    return "";
  }
  code = code.toUpperCase().replace(/\.(STRM|MP4|MKV|M3U8|TS)$/, "");
  if (!CODE_PATTERN.test(code)) return "";
  if (!/[A-Z0-9]/.test(code)) return "";
  return code;
}

function safeSegment(raw) {
  const segment = String(raw || "").trim();
  if (!segment || segment.length > 512) return "";
  if (!SEGMENT_PATTERN.test(segment)) return "";
  if (segment.includes("..")) return "";
  return segment;
}

function memoryGet(key) {
  const entry = RESOLVE_MEMORY.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    RESOLVE_MEMORY.delete(key);
    return null;
  }
  return entry.info;
}

function memorySet(key, info, ttlSeconds) {
  if (RESOLVE_MEMORY.size >= MEMORY_CACHE_MAX_ENTRIES) {
    const oldest = RESOLVE_MEMORY.keys().next().value;
    if (oldest !== undefined) RESOLVE_MEMORY.delete(oldest);
  }
  RESOLVE_MEMORY.set(key, {
    info,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

function cloudflareCache() {
  try {
    if (typeof caches === "undefined" || !caches.default) return null;
    return caches.default;
  } catch {
    return null;
  }
}

function cacheKeyRequest(key) {
  return new Request(`https://memojav.internal/__resolve/${encodeURIComponent(key)}`, {
    method: "GET",
  });
}

async function readResolveCache(key, env, refresh) {
  if (refresh) return null;
  const memory = memoryGet(key);
  if (memory) return memory;
  const cache = cloudflareCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(cacheKeyRequest(key));
    if (!hit) return null;
    const info = await hit.json();
    if (info && typeof info === "object") {
      memorySet(key, info, cacheTtlSeconds(env));
      return info;
    }
  } catch {
    // 缓存损坏时按未命中处理。
  }
  return null;
}

async function writeResolveCache(key, info, env, ctx) {
  const ttl = info.ok ? cacheTtlSeconds(env) : NEGATIVE_CACHE_TTL_SECONDS;
  memorySet(key, info, ttl);
  const cache = cloudflareCache();
  if (!cache) return;
  const put = cache
    .put(
      cacheKeyRequest(key),
      new Response(JSON.stringify(info), {
        headers: {
          "content-type": "application/json",
          "cache-control": `s-maxage=${ttl}`,
        },
      }),
    )
    .catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(put);
    return;
  }
  await put;
}

function base64Encode(value) {
  if (typeof btoa === "function") return btoa(value);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "binary").toString("base64");
  }
  throw new Error("base64 encoder unavailable");
}

/**
 * 复刻上游 /static/main.js 的 video_sig()：
 *   sig = btoa(timestamp) 的第 8~17 位（共 10 位）
 *   sts = 1 + Σ(charCode(sig[i]) * i * 1743)
 */
export function memoVideoSignature(nowMs = Date.now()) {
  const encoded = base64Encode(String(nowMs));
  const sig = encoded.slice(-12, -2);
  let sts = 1;
  for (let index = 0; index < sig.length; index += 1) {
    sts += sig.charCodeAt(index) * index * 1743;
  }
  return { sig, sts };
}

function decodeComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function hostFromUrl(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hlsSource(url, checkedAt) {
  return {
    id: "hls",
    // 上游这条清单本身不带清晰度（单码率媒体清单）。名称先留中性标签，
    // 由 expandHlsVariants 探测真实分辨率后改成 “MemoJav 1080P” 这种格式；
    // 探测失败时也不会出现用户明确否掉的“原画”字样。
    name: memoSourceName(0),
    kind: "hls",
    container: "m3u8",
    height: 0,
    url,
    checkedAt,
  };
}

// 清晰度标签：把探测到的真实高度换成客户端列表里的常见写法。
// 2160 → 4K、1440 → 2K，其余按 1080P / 720P / 480P / 360P / 240P 归档。
const MEMO_QUALITY_TIERS = [
  { height: 2160, label: "4K" },
  { height: 1440, label: "2K" },
  { height: 1080, label: "1080P" },
  { height: 720, label: "720P" },
  { height: 480, label: "480P" },
  { height: 360, label: "360P" },
  { height: 240, label: "240P" },
];

export function memoQualityLabel(height) {
  const value = Number(height) || 0;
  if (value <= 0) return "";
  let best = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const tier of MEMO_QUALITY_TIERS) {
    const diff = Math.abs(value - tier.height);
    if (diff < bestDiff) {
      best = tier;
      bestDiff = diff;
    }
  }
  if (best && bestDiff <= 200) return best.label;
  return `${Math.round(value)}P`;
}

/** “MemoJav + 清晰度”。高度未知时退化成 “MemoJav HLS”，不再使用“原画”。 */
export function memoSourceName(height, extra = "") {
  const quality = memoQualityLabel(height);
  const suffix = String(extra || "").trim();
  if (quality && suffix) return `MemoJav ${suffix} ${quality}`;
  if (quality) return `MemoJav ${quality}`;
  if (suffix) return `MemoJav ${suffix}`;
  return "MemoJav HLS";
}

// 从 fMP4 的 init 段（moov/trak/tkhd）里读出真实分辨率。
// 上游 HLS 只有一条单码率清单，但媒体是真的 1080P/720P：
// 读 tkhd 的 width/height（16.16 定点）即可，不必下载整个视频。
export function parseMp4TrackDimensions(bytes) {
  const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (buffer.length < 16) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const readUint32 = (offset) => (offset + 4 <= buffer.length ? view.getUint32(offset) : 0);
  const walk = (start, end, depth) => {
    let offset = start;
    while (offset + 8 <= end && depth <= 6) {
      const size = readUint32(offset);
      const type = String.fromCharCode(
        buffer[offset + 4],
        buffer[offset + 5],
        buffer[offset + 6],
        buffer[offset + 7],
      );
      let headerSize = 8;
      let boxSize = size;
      if (size === 1) {
        // 64 位 largesize
        if (offset + 16 > end) return null;
        const high = readUint32(offset + 8);
        const low = readUint32(offset + 12);
        boxSize = high * 4294967296 + low;
        headerSize = 16;
      } else if (size === 0) {
        boxSize = end - offset;
      }
      if (boxSize < headerSize || offset + boxSize > end) return null;
      if (type === "tkhd") {
        const version = buffer[offset + 8];
        // v0：ver/flags 4 + 时间/ID 20 + reserved 8 + layer/…8 + matrix 36 → width
        // v1：creation/modification/duration 各 8 字节，整体多 12 字节。
        const widthOffset = offset + headerSize + (version === 1 ? 88 : 76);
        if (widthOffset + 8 > offset + boxSize) return null;
        const width = Math.round(readUint32(widthOffset) / 65536);
        const height = Math.round(readUint32(widthOffset + 4) / 65536);
        if (width > 0 && height > 0) return { width, height };
      }
      if (type === "moov" || type === "trak" || type === "mdia") {
        const found = walk(offset + headerSize, offset + boxSize, depth + 1);
        if (found) return found;
      }
      offset += boxSize;
    }
    return null;
  };
  return walk(0, buffer.length, 0);
}

const HLS_INIT_PROBE_MAX_BYTES = 262144;

/** 从单码率 HLS 清单里找出 init 段（#EXT-X-MAP）地址。 */
export function parseHlsInitUri(manifestText, baseUrl) {
  const match = /#EXT-X-MAP:[^\n\r]*URI="([^"]+)"/i.exec(String(manifestText || ""));
  if (!match) return "";
  try {
    return new URL(match[1], baseUrl).href;
  } catch {
    return "";
  }
}

async function probeHlsHeight(manifestText, baseUrl, fetchImpl) {
  const initUrl = parseHlsInitUri(manifestText, baseUrl);
  if (!initUrl) return 0;
  try {
    const response = await fetchImpl(initUrl, {
      method: "GET",
      headers: {
        "user-agent": BROWSER_UA,
        accept: "*/*",
        range: `bytes=0-${HLS_INIT_PROBE_MAX_BYTES - 1}`,
      },
    });
    if (!response.ok && response.status !== 206) return 0;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const dimensions = parseMp4TrackDimensions(bytes);
    return dimensions ? dimensions.height : 0;
  } catch {
    return 0;
  }
}

function mp4Sources(baseUrl, checkedAt) {
  return MP4_QUALITIES.map((quality) => ({
    id: quality.id,
    name: quality.name,
    kind: "mp4",
    container: "mp4",
    height: quality.height,
    url: `${baseUrl}=${quality.suffix}`,
    checkedAt,
  }));
}

const HLS_VARIANT_PROBE_MAX_BYTES = 65536;

/**
 * 从 master 清单里解析 `#EXT-X-STREAM-INF` 变体。
 * 上游对部分番号确实提供多条不同分辨率的 HLS 变体，这时必须逐条给出
 * 真实清晰度的 302 短链，而不是只暴露一条（用户反馈“MemoJav 只有一个
 * 视频源”）。没有变体的媒体清单返回空数组，绝不伪造清晰度。
 */
export function parseHlsVariantSources(manifestText, baseUrl, checkedAt = new Date().toISOString()) {
  const lines = String(manifestText || "").split(/\r?\n/);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!/^#EXT-X-STREAM-INF:/i.test(line)) continue;
    const attrs = line.slice(line.indexOf(":") + 1);
    let uri = "";
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next].trim();
      if (!candidate) continue;
      if (candidate.startsWith("#")) break;
      uri = candidate;
      break;
    }
    if (!uri) continue;
    let absolute = "";
    try {
      absolute = new URL(uri, baseUrl).href;
    } catch {
      continue;
    }
    const resolution = /RESOLUTION=(\d+)x(\d+)/i.exec(attrs);
    const bandwidth = /(?:AVERAGE-)?BANDWIDTH=(\d+)/i.exec(attrs);
    variants.push({
      url: absolute,
      height: resolution ? Number(resolution[2]) || 0 : 0,
      bandwidth: bandwidth ? Number(bandwidth[1]) || 0 : 0,
    });
  }
  return variants;
}

/**
 * 上游 HLS 若是多清晰度 master，就展开成多条真实播放源；
 * 单条媒体清单（memojav 目前绝大多数番号）保持原样，不制造假清晰度。
 */
async function expandHlsVariants(info, fetchImpl, prefetchedText = "") {
  if (!info || !info.ok || info.type !== "hls") return info;
  if (!Array.isArray(info.sources) || info.sources.length !== 1) return info;
  const base = info.sources[0].url;
  let text = String(prefetchedText || "");
  if (!text) {
    try {
      const response = await fetchImpl(base, {
        method: "GET",
        headers: {
          "user-agent": BROWSER_UA,
          accept: "*/*",
          range: `bytes=0-${HLS_VARIANT_PROBE_MAX_BYTES - 1}`,
        },
      });
      if (!response.ok && response.status !== 206) return info;
      text = await response.text();
    } catch {
      return info;
    }
  }
  const variants = parseHlsVariantSources(text, base, info.checkedAt);
  if (!variants.length) {
    // 单码率媒体清单：没有 STREAM-INF，但 init 段里有真实分辨率。
    // 探测成功就把 “MemoJav 原画” 换成 “MemoJav 1080P” 这类带清晰度的名称。
    const height = await probeHlsHeight(text, base, fetchImpl);
    if (height > 0) {
      info.sources[0].height = height;
      info.sources[0].name = memoSourceName(height);
    }
    return info;
  }
  const byHeight = new Map();
  for (const variant of variants) {
    if (!variant.height || variant.height < 144) continue;
    const existing = byHeight.get(variant.height);
    if (!existing || variant.bandwidth > existing.bandwidth) {
      byHeight.set(variant.height, variant);
    }
  }
  const heights = [...byHeight.keys()].sort((left, right) => right - left);
  if (!heights.length) return info;
  // 只有一条变体时也把真实清晰度写进名称，而不是退回“原画”。
  if (heights.length === 1) {
    info.sources[0].height = heights[0];
    info.sources[0].name = memoSourceName(heights[0]);
    return info;
  }
  info.sources = heights.map((height) => {
    const variant = byHeight.get(height);
    return {
      id: `hls-${height}`,
      name: memoSourceName(height),
      kind: "hls",
      container: "m3u8",
      height,
      url: variant.url,
      checkedAt: info.checkedAt,
    };
  });
  return info;
}

/** 解析 get_video_info.php 的响应（前面可能带 `for(;;);` 反 JSON 劫持前缀）。 */
export function parseMemoVideoInfo(text, checkedAt = new Date().toISOString()) {
  const raw = String(text || "").replace(/^\s*for\s*\(;;\);\s*/i, "");
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || payload.success !== true) return null;
  const type = String(payload.type || "").toLowerCase();
  const url = decodeComponent(payload.url);
  if (!url) return null;
  if (type === "hls") {
    return {
      ok: true,
      type: "hls",
      provider: "memojav-api",
      host: hostFromUrl(url),
      url,
      sources: [hlsSource(url, checkedAt)],
      checkedAt,
    };
  }
  if (type === "mp4") {
    const sources = mp4Sources(url, checkedAt);
    return {
      ok: true,
      type: "mp4",
      provider: "memojav-api",
      host: hostFromUrl(sources[0].url),
      url: sources[0].url,
      sources,
      checkedAt,
    };
  }
  return null;
}

/** 给 HLS 结果补一条明确标注的代理兜底源（不伪造清晰度）。 */
function addProxyFallback(info, env) {
  if (!memoIncludeProxySource(env) || !info || !info.ok) return info;
  if (info.type !== "hls" || !Array.isArray(info.sources) || !info.sources.length) {
    return info;
  }
  if (info.sources.some((source) => source.id === "hls-proxy")) return info;
  const primary = info.sources.find((source) => source.id === "hls") || info.sources[0];
  info.sources.push({
    id: "hls-proxy",
    // 这一条不是 302 直连（清单和分片都要经本服务中转），名称保持原样，
    // 不跟 302 线路一起改成「MemoJav 清晰度」。
    name: "MemoJav 代理",
    kind: "hls",
    container: "m3u8",
    height: primary.height || 0,
    url: primary.url,
    proxy: true,
    fallback: true,
    checkedAt: info.checkedAt,
  });
  return info;
}

async function resolveMemoInfo(code, env, fetchImpl = fetch) {
  const checkedAt = new Date().toISOString();
  const signature = memoVideoSignature();
  const infoUrl =
    `${INFO_ORIGIN}${INFO_PATH}?id=${encodeURIComponent(code)}` +
    `&sig=${encodeURIComponent(signature.sig)}&sts=${encodeURIComponent(String(signature.sts))}`;
  try {
    const response = await fetchImpl(infoUrl, {
      method: "GET",
      headers: {
        "user-agent": BROWSER_UA,
        accept: "*/*",
        referer: `${INFO_REFERER_PREFIX}${encodeURIComponent(code)}`,
      },
    });
    if (response.ok) {
      const info = parseMemoVideoInfo(await response.text(), checkedAt);
      if (info) {
        return addProxyFallback(await expandHlsVariants(info, fetchImpl), env);
      }
    }
  } catch {
    // 接口失败时继续走旧版媒体域名探测，保证已上架 HLS 仍可播放。
  }
  return null;
}

/**
 * 兼容旧直链探测：逐个候选域名请求 master.m3u8，必须拿到真正的 HLS 清单才算命中。
 */
async function resolveLegacySource(code, env, fetchImpl = fetch) {
  const list = mediaHosts(env);
  let lastStatus = 404;
  for (const host of list) {
    const url = `https://${host}/stream/${code}/master.m3u8`;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          "user-agent": BROWSER_UA,
          accept: "*/*",
          range: "bytes=0-4095",
        },
      });
      if (response.status === 200 || response.status === 206) {
        let head = "";
        try {
          head = await response.text();
        } catch {
          head = "";
        }
        if (/#EXTM3U/i.test(head)) {
          const checkedAt = new Date().toISOString();
          return addProxyFallback(
            await expandHlsVariants(
              {
                ok: true,
                type: "hls",
                provider: "legacy-host",
                host,
                url,
                sources: [hlsSource(url, checkedAt)],
                checkedAt,
              },
              fetchImpl,
            ),
            env,
          );
        }
        lastStatus = 502;
      } else {
        lastStatus = response.status;
      }
    } catch {
      lastStatus = 0;
    }
  }
  return { ok: false, status: lastStatus };
}

/**
 * 解析番号对应的全部真实播放源。
 * 返回 { ok, type, provider, host, url, sources:[{id,name,kind,container,height,url,proxy?}], checkedAt }
 */
export async function resolveMemoSource(code, env = {}, fetchImpl = fetch) {
  const info = await resolveMemoInfo(code, env, fetchImpl);
  if (info && info.ok) return info;
  return resolveLegacySource(code, env, fetchImpl);
}

async function resolveCached(code, env, ctx, fetchImpl, refresh) {
  const key =
    `${buildId(env)}|${mediaHosts(env).join(",")}|` +
    `${memoIncludeProxySource(env) ? "proxy" : "direct"}|${code}`;
  const cached = await readResolveCache(key, env, refresh);
  if (cached) return cached;
  const info = await resolveMemoSource(code, env, fetchImpl);
  await writeResolveCache(key, info, env, ctx);
  return info;
}

/**
 * 给 Emby / 其他内部调用使用的缓存解析入口。
 * 复用 /memo/ 路由同一份缓存，避免详情页、PlaybackInfo 和播放请求重复探测上游。
 */
export async function resolveMemoSourceCached(
  code,
  env = {},
  ctx = {},
  fetchImpl = fetch,
  refresh = false,
) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false, status: 400 };
  return resolveCached(normalized, env, ctx, fetchImpl, refresh);
}

/** 从解析结果里挑一条源；空请求默认第一条真实源。 */
export function selectMemoSource(info, requested) {
  const sources = Array.isArray(info?.sources) ? info.sources : [];
  if (!sources.length) return null;
  const raw = String(requested || "").trim().toLowerCase();
  if (!raw) return sources[0];
  return (
    sources.find((source) => String(source.id || "").toLowerCase() === raw) ||
    sources.find((source) => String(source.height || "") === raw) ||
    sources.find((source) => String(source.name || "").toLowerCase() === raw) ||
    sources[0]
  );
}

/** 把清单里的相对 URI 改写成走本服务代理的绝对 URL。 */
export function rewriteMemoPlaylist(text, code, origin, sourceId = "") {
  const base = `${origin}${MEMOJAV_ROUTE_PREFIX}${code}`;
  const sourceQuery = sourceId ? `&source=${encodeURIComponent(sourceId)}` : "";
  const fix = (raw) => {
    const value = String(raw || "").trim();
    if (!value) return raw;
    if (/^(https?:)?\/\//i.test(value)) return raw;
    if (value.startsWith("data:") || value.startsWith("blob:")) return raw;
    const hashIndex = value.indexOf("#");
    const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
    const withoutHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
    const queryIndex = withoutHash.indexOf("?");
    const query = queryIndex >= 0 ? withoutHash.slice(queryIndex) : "";
    const pathname = (queryIndex >= 0
      ? withoutHash.slice(0, queryIndex)
      : withoutHash
    )
      .replace(/^\.\//, "")
      .replace(/^\//, "");
    if (!pathname) return raw;
    const proxied = pathname
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${base}/${proxied}?proxy=1&p=1${sourceQuery}${query}${hash}`;
  };
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]*)"/gi, (_match, uri) => `URI="${fix(uri)}"`);
      }
      return fix(trimmed);
    })
    .join("\n");
}

async function proxyMemoRequest(target, request, env, fetchImpl) {
  if (!isAllowedMemoHost(new URL(target).hostname, env)) {
    return jsonResponse({ error: "segment host is not allowed" }, 403);
  }
  const headers = new Headers({
    "user-agent": request.headers.get("user-agent") || BROWSER_UA,
    accept: request.headers.get("accept") || "*/*",
  });
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const upstream = await fetchImpl(target, { method: "GET", headers });
  const out = new Headers(upstream.headers);
  out.set("cache-control", "no-store");
  out.set("access-control-allow-origin", "*");
  if (/\.m3u8($|\?)/i.test(target)) {
    out.set("content-type", "application/vnd.apple.mpegurl");
  }
  if (request.method === "HEAD") {
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

function playerHtml(code, origin, selected) {
  const shortLink = `${origin}${MEMOJAV_ROUTE_PREFIX}${code}`;
  const sourceQuery = selected?.id ? `&source=${encodeURIComponent(selected.id)}` : "";
  const proxyLink = `${shortLink}?proxy=1${sourceQuery}`;
  const isMp4 = selected?.kind === "mp4";
  const safeCode = code.replace(/[<>&"]/g, "");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeCode} · MemoJav 短链</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0e0f13;color:#e8eaf0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:18px}
h1{font-size:16px;margin:0 0 12px;font-weight:600}
h1 b{color:#7cc4ff}
.box{position:relative;background:#000;border-radius:10px;overflow:hidden;aspect-ratio:16/9}
video{width:100%;height:100%;display:block;background:#000}
.status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;color:#9aa3b2;font-size:13px}
.status.err{color:#ff9a9a}
.status.hide{display:none}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
a.btn{appearance:none;border:1px solid #2a2f3a;background:#171a21;color:#cfd6e4;padding:7px 12px;border-radius:8px;font-size:12.5px;text-decoration:none}
a.btn:hover{border-color:#3d4759;background:#1d212a}
.note{margin-top:16px;color:#7b8494;font-size:12px;line-height:1.9}
code{background:#171a21;border:1px solid #232833;padding:2px 6px;border-radius:5px;font-size:12px;word-break:break-all}
</style>
</head>
<body>
<div class="wrap">
  <h1>MemoJav 短链 · <b>${safeCode}</b></h1>
  <div class="box">
    <video id="v" controls autoplay playsinline></video>
    <div id="st" class="status">正在加载播放清单…</div>
  </div>
  <div class="bar">
    <a class="btn" href="${shortLink}" target="_blank" rel="noreferrer">302 短链（外部播放器）</a>
    <a class="btn" href="${proxyLink}" target="_blank" rel="noreferrer">代理播放源</a>
    <a class="btn" href="${MEMOJAV_ROUTE_PREFIX}">接口说明</a>
  </div>
  <div class="note">
    <div>· 本页播放走同源代理 <code>?proxy=1</code>，清单与分片经本服务中转，仅供浏览器预览。</div>
    <div>· Emby / VLC / PotPlayer 请用 302 短链 <code>${shortLink}</code>，一跳直达上游、零 Worker 流量。</div>
  </div>
</div>
<script>
var SRC=${JSON.stringify(proxyLink)};
var v=document.getElementById('v'), st=document.getElementById('st');
function fail(m){ st.textContent=m; st.className='status err'; }
function hide(){ st.className='status hide'; }
function start(Hls){
  if (${isMp4 ? "true" : "v.canPlayType('application/vnd.apple.mpegurl')"}) {
    v.src=SRC;
    v.addEventListener('loadedmetadata', hide);
    v.addEventListener('error', function(){ fail('原生播放失败，请改用 302 短链。'); });
    return;
  }
  if (Hls && Hls.isSupported()) {
    var hls=new Hls({enableWorker:true,maxBufferLength:30});
    hls.on(Hls.Events.MANIFEST_PARSED,function(){ hide(); var p=v.play(); if(p&&p.catch)p.catch(function(){}); });
    hls.on(Hls.Events.ERROR,function(_e,data){ if(data&&data.fatal){ fail('播放失败：'+data.type+' / '+data.details); } });
    hls.loadSource(SRC);
    hls.attachMedia(v);
    return;
  }
  fail('当前浏览器不支持 HLS，请用 VLC / PotPlayer 打开 302 短链。');
}
var CDNS=['https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js','https://unpkg.com/hls.js@1/dist/hls.min.js','https://cdn.bootcdn.net/ajax/libs/hls.js/1.5.20/hls.min.js'];
(function load(i){ if(i>=CDNS.length){ start(null); return; } var s=document.createElement('script'); s.src=CDNS[i]; s.onload=function(){ start(window.Hls); }; s.onerror=function(){ load(i+1); }; document.head.appendChild(s); })(0);
</script>
</body>
</html>`;
}

function sourceListPayload(info, code) {
  return {
    ok: true,
    code,
    type: info.type,
    provider: info.provider,
    checkedAt: info.checkedAt,
    host: info.host,
    url: info.url,
    sources: (info.sources || []).map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      container: source.container,
      height: source.height || 0,
      url: source.url,
      proxy: Boolean(source.proxy),
      fallback: Boolean(source.fallback),
    })),
  };
}

function usageResponse(origin, env) {
  return jsonResponse({
    ok: true,
    service: "memojav-shortlink",
    buildId: buildId(env),
    usage: {
      [`GET ${MEMOJAV_ROUTE_PREFIX}<番号>`]: "302 重定向到第一条真实播放源（默认，零流量）",
      [`GET ${MEMOJAV_ROUTE_PREFIX}<番号>?sources=1`]: "返回上游真实播放源列表（HLS / MP4 清晰度）",
      [`GET ${MEMOJAV_ROUTE_PREFIX}<番号>?source=<id>`]: "302 重定向到指定播放源",
      [`GET ${MEMOJAV_ROUTE_PREFIX}<番号>?json=1`]: "返回解析结果 JSON",
      [`GET ${MEMOJAV_ROUTE_PREFIX}<番号>?refresh=1`]: "绕过缓存强制重新解析",
      [`GET ${MEMOJAV_ROUTE_PREFIX}<番号>?proxy=1`]: "HLS / MP4 反向代理（清单+分片经本服务）",
      [`GET ${MEMOJAV_ROUTE_PREFIX}<番号>?web=1`]: "浏览器播放页（同源代理预览）",
    },
    example: `${origin}${MEMOJAV_ROUTE_PREFIX}ROE-552`,
    upstream: mediaHosts(env).map((host) => `https://${host}/stream/<番号>/master.m3u8`),
    infoApi: `${INFO_ORIGIN}${INFO_PATH}`,
    includeProxySource: memoIncludeProxySource(env),
    cacheTtlSeconds: cacheTtlSeconds(env),
  });
}

export function resetMemoJavCachesForTests() {
  RESOLVE_MEMORY.clear();
}

/**
 * 处理 /memo/ 前缀的请求。返回 null 表示不属于本模块，交给后续路由。
 */
export async function handleMemoJav(
  request,
  env = {},
  ctx = {},
  fetchImpl = fetch,
) {
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith(MEMOJAV_ROUTE_PREFIX)) return null;

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return jsonResponse({ error: "only GET/HEAD is supported" }, 405);
  }

  const parts = incoming.pathname
    .slice(MEMOJAV_ROUTE_PREFIX.length)
    .split("/")
    .filter(Boolean);
  if (parts.length === 0) {
    return usageResponse(incoming.origin, env);
  }

  const code = normalizeCode(parts[0]);
  if (!code) {
    return jsonResponse(
      { error: "invalid code", hint: "example: /memo/ROE-552" },
      400,
    );
  }

  const segment = parts.length > 1 ? parts.slice(1).join("/") : "";
  const asJson = incoming.searchParams.get("json") === "1";
  const asSources = incoming.searchParams.get("sources") === "1";
  const refresh = incoming.searchParams.get("refresh") === "1";
  const proxy = incoming.searchParams.get("proxy") === "1";
  const web = incoming.searchParams.get("web") === "1";
  const requestedSource =
    incoming.searchParams.get("source") || incoming.searchParams.get("quality") || "";

  const info = await resolveCached(code, env, ctx, fetchImpl, refresh);
  if (!info || !info.ok) {
    const status = info && info.status === 502 ? 502 : 404;
    return jsonResponse(
      {
        error: status === 404 ? "code not found" : "upstream unavailable",
        code,
        hint:
          status === 404
            ? "check the code spelling (case-insensitive)"
            : "retry later",
      },
      status,
    );
  }

  const selected = selectMemoSource(info, requestedSource);
  if (!selected) {
    return jsonResponse({ error: "no playable source", code }, 502);
  }

  if (asSources) {
    return jsonResponse(sourceListPayload(info, code));
  }

  if (proxy && segment) {
    const safe = safeSegment(segment);
    if (!safe) return jsonResponse({ error: "invalid segment" }, 400);
    return proxyMemoRequest(
      `https://${info.host}/stream/${code}/${safe}`,
      request,
      env,
      fetchImpl,
    );
  }

  if (asJson) {
    return jsonResponse({
      ...sourceListPayload(info, code),
      selectedSourceId: selected.id,
      proxy,
    });
  }

  if (web) {
    return htmlResponse(playerHtml(code, incoming.origin, selected));
  }

  if (proxy) {
    if (selected.kind === "mp4" || selected.container === "mp4") {
      return proxyMemoRequest(selected.url, request, env, fetchImpl);
    }
    const upstream = await fetchImpl(selected.url, {
      method: "GET",
      headers: new Headers({
        "user-agent": request.headers.get("user-agent") || BROWSER_UA,
        accept: "*/*",
      }),
    });
    if (!upstream.ok) {
      return jsonResponse(
        { error: "failed to load upstream playlist", code, status: upstream.status },
        502,
      );
    }
    const text = await upstream.text();
    return new Response(rewriteMemoPlaylist(text, code, incoming.origin, selected.id), {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  }

  // 默认：302 零流量重定向。代理兜底源 302 回本服务的代理入口。
  if (selected.proxy) {
    const proxyUrl = new URL(
      `${incoming.origin}${MEMOJAV_ROUTE_PREFIX}${encodeURIComponent(code)}`,
    );
    proxyUrl.searchParams.set("proxy", "1");
    proxyUrl.searchParams.set("source", selected.id);
    return new Response(null, {
      status: 302,
      headers: {
        location: proxyUrl.toString(),
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: selected.url,
      "cache-control": `public, max-age=${cacheTtlSeconds(env)}`,
      "access-control-allow-origin": "*",
    },
  });
}
