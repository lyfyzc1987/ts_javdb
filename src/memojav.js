// MemoJav 番号 → 永久短链 → 302 直达上游 HLS。
//
// 设计目标与 MemoJavstrm 一致：播放器（Emby / VLC / PotPlayer）请求本服务
// 的短链时，默认返回 302，让客户端一跳直达上游 m3u8；Worker 只处理这一次
// 重定向请求，清单和分片都不经过 Worker，实现"零流量"。
//
// 路由挂在独立的 /memo/ 前缀下，避免和现有 Emby / 站点代理路由冲突：
//
//   GET /memo/<番号>            → 302 到上游 master.m3u8（默认，零流量）
//   GET /memo/<番号>?json=1     → 返回解析结果 JSON（调试）
//   GET /memo/<番号>?refresh=1  → 绕过解析缓存强制重新探测
//   GET /memo/<番号>?proxy=1    → 反向代理 HLS 清单并改写为走本服务
//   GET /memo/<番号>?web=1      → 浏览器播放页（同源代理，仅预览用）
//   GET /memo/<番号>/<分片>     → proxy 模式下的分片 / init.mp4 转发

export const MEMOJAV_ROUTE_PREFIX = "/memo/";

export const MEMOJAV_BUILD_ID = "2026-10-12-memojav-shortlink-1";

// 上游媒体域名。video10 是 2026-09 实测唯一可用的域名；其余留作候选，
// 按顺序探测，命中第一个真正返回 HLS 清单的域名。
const DEFAULT_MEDIA_HOSTS = ["video10.memojav.net"];

// 解析结果缓存时长（秒）。命中缓存时 302/代理都不再探测上游。
const DEFAULT_CACHE_TTL_SECONDS = 600;
// 未命中的负缓存时长（秒）：新上架番号能较快出现，又不会被 404 打穿上游。
const NEGATIVE_CACHE_TTL_SECONDS = 60;
const MEMORY_CACHE_MAX_ENTRIES = 512;

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

/**
 * 探测番号：逐个候选域名请求 master.m3u8，必须拿到真正的 HLS 清单才算命中。
 * 命中返回 { ok:true, host, url, checkedAt }，否则返回 { ok:false, status }。
 */
export async function resolveMemoSource(code, env = {}, fetchImpl = fetch) {
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
          return {
            ok: true,
            host,
            url,
            checkedAt: new Date().toISOString(),
          };
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

async function resolveCached(code, env, ctx, fetchImpl, refresh) {
  const key = `${buildId(env)}|${mediaHosts(env).join(",")}|${code}`;
  const cached = await readResolveCache(key, env, refresh);
  if (cached) return cached;
  const info = await resolveMemoSource(code, env, fetchImpl);
  await writeResolveCache(key, info, env, ctx);
  return info;
}

/** 把清单里的相对 URI 改写成走本服务代理的绝对 URL。 */
export function rewriteMemoPlaylist(text, code, origin) {
  const base = `${origin}${MEMOJAV_ROUTE_PREFIX}${code}`;
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
    return `${base}/${proxied}?proxy=1&p=1${query}${hash}`;
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

function playerHtml(code, origin) {
  const shortLink = `${origin}${MEMOJAV_ROUTE_PREFIX}${code}`;
  const proxyLink = `${shortLink}?proxy=1`;
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
    <a class="btn" href="${proxyLink}" target="_blank" rel="noreferrer">原始 m3u8</a>
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
  if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src=SRC;
    v.addEventListener('loadedmetadata', hide);
    v.addEventListener('error', function(){ fail('原生 HLS 播放失败，请改用 302 短链。'); });
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

function usageResponse(origin, env) {
  return jsonResponse({
    ok: true,
    service: "memojav-shortlink",
    buildId: buildId(env),
    usage: {
      [`GET ${MEMOJAV_ROUTE_PREFIX}<番号>`]: "302 重定向到上游 m3u8（默认，零流量）",
      [`GET ${MEMOJAV_ROUTE_PREFIX}<番号>?json=1`]: "返回解析结果 JSON",
      [`GET ${MEMOJAV_ROUTE_PREFIX}<番号>?refresh=1`]: "绕过缓存强制重新解析",
      [`GET ${MEMOJAV_ROUTE_PREFIX}<番号>?proxy=1`]: "HLS 反向代理（清单+分片经本服务）",
      [`GET ${MEMOJAV_ROUTE_PREFIX}<番号>?web=1`]: "浏览器播放页（同源代理预览）",
    },
    example: `${origin}${MEMOJAV_ROUTE_PREFIX}ROE-552`,
    upstream: mediaHosts(env).map((host) => `https://${host}/stream/<番号>/master.m3u8`),
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
  const refresh = incoming.searchParams.get("refresh") === "1";
  const proxy = incoming.searchParams.get("proxy") === "1";
  const web = incoming.searchParams.get("web") === "1";

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
    return jsonResponse({ ok: true, code, host: info.host, url: info.url, proxy });
  }

  if (web) {
    return htmlResponse(playerHtml(code, incoming.origin));
  }

  if (proxy) {
    const upstream = await fetchImpl(info.url, {
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
    return new Response(rewriteMemoPlaylist(text, code, incoming.origin), {
      status: 200,
      headers: {
        "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: info.url,
      "cache-control": `public, max-age=${cacheTtlSeconds(env)}`,
      "access-control-allow-origin": "*",
    },
  });
}
