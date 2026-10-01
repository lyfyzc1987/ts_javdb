import { handleEmby } from "./emby.js";

export const DEFAULT_UPSTREAM_ORIGIN =
  "https://catembylegacy.fastcdn.dpdns.org";

export const MEDIA_PROXY_PREFIX = "/__media/";

const DEFAULT_MEDIA_HOSTS = new Set([
  "fast-stream.jav.si",
  "jdforrepam.com",
  "tp.spfcas.com",
  "h1.gzankun.com",
]);

const MEDIA_HOST_SUFFIXES = [".spfcas.com", ".gzankun.com"];
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const BODYLESS_STATUSES = new Set([101, 204, 205, 304]);
const TEXT_CONTENT_TYPES = [
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/mpegurl",
  "application/vnd.apple.mpegurl",
  "application/x-javascript",
  "application/x-mpegurl",
  "image/svg+xml",
  "text/",
];

// 上游解析接口响应体很大(常见 1MB+)、首字节可能超过 20 秒,
// 12 秒的旧预算会把正常响应切成 502,所以首线路预算放宽到 45 秒。
const RESOLVER_FIRST_VARIANT_TIMEOUT_MS = 45000;
const RESOLVER_SECONDARY_MERGE_MS = 12000;
// 解析端点顺序不固定：可能一个端点先返回 4 条伪 HLS（data: 清单），真实线路要等
// 另一个端点 7~14 秒才补齐。若先到的结果里没有任何可直连的真实地址，就放宽合并
// 窗口，避免不同实例拿到的线路数不一致；已经有真实地址时只做短暂合并。
const RESOLVER_THIN_MERGE_MS = 15000;

function resolverMergeBudget(env, baseMs) {
  const override = Number(env?.RESOLVER_MERGE_BUDGET_MS);
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return baseMs;
}

const MAGNET_COPY_COMPONENT_SOURCE = "function dY({magnet:t})";
const MAGNET_COPY_COMPONENT_PATCH =
  'async function bbCopyMagnet(t,n){const e="magnet:?xt=urn:btih:"+t;try{if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(e);else{const r=document.createElement("textarea");r.value=e,r.setAttribute("readonly",""),r.style.position="fixed",r.style.opacity="0",document.body.appendChild(r),r.focus(),r.select();try{if(!document.execCommand("copy"))throw new Error("copy failed")}finally{r.remove()}}n.textContent="\u5df2\u590d\u5236"}catch{n.textContent="\u590d\u5236\u5931\u8d25"}setTimeout(()=>{n.isConnected&&(n.textContent="\u590d\u5236")},1500)}function bbCopyButton(t){return f.jsx(Ar,{type:"button",variant:"outline",size:"sm",className:"h-7 shrink-0 px-2 text-xs",title:"\u590d\u5236\u78c1\u529b\u94fe\u63a5","aria-label":"\u590d\u5236\u78c1\u529b\u94fe\u63a5",onClick:n=>bbCopyMagnet(t,n.currentTarget),children:"\u590d\u5236"})}function dY({magnet:t})';

const MAGNET_MOBILE_TITLE_SOURCE =
  't.downloadUrl?f.jsx("a",{href:t.downloadUrl,target:"_blank",rel:"noreferrer",className:"text-sm font-medium text-primary hover:underline break-all",children:t.name}):f.jsx("span",{className:"text-sm font-medium break-all",children:t.name})';
const MAGNET_MOBILE_TITLE_PATCH =
  'f.jsxs("div",{className:"flex items-start gap-2",children:[t.downloadUrl?f.jsx("a",{href:t.downloadUrl,target:"_blank",rel:"noreferrer",className:"min-w-0 flex-1 text-sm font-medium text-primary hover:underline break-all",children:t.name}):f.jsx("span",{className:"min-w-0 flex-1 text-sm font-medium break-all",children:t.name}),bbCopyButton(t.hash)]})';

const MAGNET_DESKTOP_TITLE_SOURCE =
  'f.jsx(ff,{className:"max-w-md truncate font-medium",children:e.downloadUrl?f.jsx("a",{href:e.downloadUrl,target:"_blank",rel:"noreferrer",className:"text-primary hover:underline",children:e.name}):e.name})';
const MAGNET_DESKTOP_TITLE_PATCH =
  'f.jsx(ff,{className:"max-w-md font-medium",children:f.jsxs("div",{className:"flex items-center gap-2",children:[e.downloadUrl?f.jsx("a",{href:e.downloadUrl,target:"_blank",rel:"noreferrer",className:"min-w-0 flex-1 truncate text-primary hover:underline",children:e.name}):f.jsx("span",{className:"min-w-0 flex-1 truncate",children:e.name}),bbCopyButton(e.hash)]})})';

const REPLICA_SOURCE_PATCHES = [
  ["catemby\u9057\u4ea7", "\u6708\u5f71emby"],//改变站点名称
  ["--container-7xl:80rem", "--container-7xl:100rem"],
  [
    "grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8",
    "grid-cols-2 sm:grid-cols-4",
  ],
  [
    'pathname:"/v1/movies/latest",query:{page:t,filter_by:n}',
    'pathname:"/v1/movies/latest",query:{page:t,filter_by:n,limit:32}',
  ],
  ["function bG(t,n=1,e=24,r=", "function bG(t,n=1,e=32,r="],
  [
    "function CG(t,{filterByTags:n,page:e=1,limit:r=24,sortBy:",
    "function CG(t,{filterByTags:n,page:e=1,limit:r=32,sortBy:",
  ],
  [
    "movie_filter_by:r.movieFilterBy,movie_sort_by:r.sortBy,limit:r.limit",
    "movie_filter_by:r.movieFilterBy,movie_sort_by:r.sortBy,limit:r.limit||32",
  ],
  ["const jx=24,pK=5", "const jx=32,pK=5"],
  [MAGNET_COPY_COMPONENT_SOURCE, MAGNET_COPY_COMPONENT_PATCH],
  [MAGNET_MOBILE_TITLE_SOURCE, MAGNET_MOBILE_TITLE_PATCH],
  [MAGNET_DESKTOP_TITLE_SOURCE, MAGNET_DESKTOP_TITLE_PATCH],
];

function normalizeOrigin(value) {
  const url = new URL(value || DEFAULT_UPSTREAM_ORIGIN);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("UPSTREAM_ORIGIN must use http or https");
  }

  return url.origin;
}

function extraMediaHosts(env) {
  return String(env.EXTRA_MEDIA_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedMediaHost(hostname, env = {}) {
  const host = String(hostname || "").toLowerCase();

  if (!/^[a-z0-9.-]+$/.test(host)) {
    return false;
  }

  return (
    DEFAULT_MEDIA_HOSTS.has(host) ||
    MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    extraMediaHosts(env).includes(host)
  );
}

export function resolveUpstreamTarget(requestUrl, env = {}) {
  const incoming = new URL(requestUrl);
  const upstreamOrigin = normalizeOrigin(env.UPSTREAM_ORIGIN);

  if (!incoming.pathname.startsWith(MEDIA_PROXY_PREFIX)) {
    return {
      kind: "application",
      upstreamOrigin,
      url: new URL(`${incoming.pathname}${incoming.search}`, upstreamOrigin),
    };
  }

  const remainder = incoming.pathname.slice(MEDIA_PROXY_PREFIX.length);
  const slashIndex = remainder.indexOf("/");
  const hostname = (slashIndex === -1 ? remainder : remainder.slice(0, slashIndex))
    .toLowerCase();
  const pathname = slashIndex === -1 ? "/" : remainder.slice(slashIndex);

  if (!isAllowedMediaHost(hostname, env)) {
    return { kind: "blocked", hostname, upstreamOrigin };
  }

  return {
    kind: "media",
    hostname,
    upstreamOrigin,
    url: new URL(`https://${hostname}${pathname}${incoming.search}`),
  };
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceOrigin(text, sourceOrigin, destinationOrigin) {
  const normalPattern = new RegExp(escapeForRegExp(sourceOrigin), "gi");
  const escapedSource = sourceOrigin.replaceAll("/", "\\/");
  const escapedDestination = destinationOrigin.replaceAll("/", "\\/");
  const escapedPattern = new RegExp(escapeForRegExp(escapedSource), "gi");

  return text
    .replace(normalPattern, destinationOrigin)
    .replace(escapedPattern, escapedDestination);
}

export function applyReplicaOverrides(text) {
  return REPLICA_SOURCE_PATCHES.reduce(
    (source, [from, to]) => source.replaceAll(from, to),
    text,
  );
}

export function rewriteText(text, publicOrigin, upstreamOrigin, env = {}) {
  let rewritten = applyReplicaOverrides(
    replaceOrigin(text, upstreamOrigin, publicOrigin),
  );

  // The upstream app signs direct API URLs in the browser. Rewriting those URLs
  // by default would prevent it from attaching the required jdsignature header.
  if (String(env.PROXY_EXTERNAL_MEDIA || "").toLowerCase() !== "true") {
    return rewritten;
  }

  rewritten = rewritten.replace(
    /https?:\/\/([a-z0-9.-]+)/gi,
    (urlOrigin, hostname) =>
      isAllowedMediaHost(hostname, env)
        ? `${publicOrigin}${MEDIA_PROXY_PREFIX}${hostname.toLowerCase()}`
        : urlOrigin,
  );

  rewritten = rewritten.replace(
    /https?:\\\/\\\/([a-z0-9.-]+)/gi,
    (urlOrigin, hostname) =>
      isAllowedMediaHost(hostname, env)
        ? `${publicOrigin}${MEDIA_PROXY_PREFIX}${hostname.toLowerCase()}`.replaceAll(
            "/",
            "\\/",
          )
        : urlOrigin,
  );

  return rewritten;
}

function rewriteLocation(location, publicOrigin, upstreamOrigin, env) {
  if (!location) {
    return location;
  }

  try {
    const target = new URL(location, upstreamOrigin);

    if (target.origin === upstreamOrigin) {
      return `${publicOrigin}${target.pathname}${target.search}${target.hash}`;
    }

    if (isAllowedMediaHost(target.hostname, env)) {
      return `${publicOrigin}${MEDIA_PROXY_PREFIX}${target.host}${target.pathname}${target.search}${target.hash}`;
    }
  } catch {
    return location;
  }

  return location;
}

function rewriteSetCookie(cookie) {
  return cookie.replace(/;\s*Domain=[^;]*/gi, "");
}

function copyResponseHeaders(response, publicOrigin, upstreamOrigin, env) {
  const headers = new Headers(response.headers);
  const location = headers.get("location");

  if (location) {
    headers.set(
      "location",
      rewriteLocation(location, publicOrigin, upstreamOrigin, env),
    );
  }

  const contentSecurityPolicy = headers.get("content-security-policy");
  if (contentSecurityPolicy) {
    headers.set(
      "content-security-policy",
      rewriteText(contentSecurityPolicy, publicOrigin, upstreamOrigin, env),
    );
  }

  const getSetCookie = response.headers.getSetCookie;
  const cookies =
    typeof getSetCookie === "function"
      ? getSetCookie.call(response.headers)
      : headers.get("set-cookie")
        ? [headers.get("set-cookie")]
        : [];

  if (cookies.length > 0) {
    headers.delete("set-cookie");
    for (const cookie of cookies) {
      headers.append("set-cookie", rewriteSetCookie(cookie));
    }
  }

  return headers;
}

function isTextResponse(headers) {
  const contentType = (headers.get("content-type") || "").toLowerCase();
  return TEXT_CONTENT_TYPES.some((type) => contentType.includes(type));
}

function createForwardHeaders(request, upstreamOrigin) {
  const headers = new Headers(request.headers);

  for (const name of [
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "host",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
  ]) {
    headers.delete(name);
  }

  if (headers.has("origin")) {
    headers.set("origin", upstreamOrigin);
  }

  if (headers.has("referer")) {
    headers.set("referer", `${upstreamOrigin}/`);
  }

  return headers;
}

function forbiddenProxyResponse() {
  return new Response("Forbidden media host", {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function resolverVariants(payload) {
  const data = payload?.data || payload;
  if (Array.isArray(data)) {
    return data;
  }
  const candidates = [
    data?.variants,
    data?.sources,
    data?.videos,
    data?.streams,
    data?.data?.variants,
    data?.data?.sources,
  ];
  const list = candidates.find((item) => Array.isArray(item) && item.length > 0);
  if (list) {
    return list;
  }
  const sourceUrl =
    typeof data === "string"
      ? data
      : data?.sourceUrl || data?.source_url || data?.url || data?.playUrl ||
        data?.play_url || data?.directUrl || data?.direct_url || data?.file ||
        data?.src;
  return sourceUrl ? [data] : [];
}

function resolverVariantCount(payload) {
  return resolverVariants(payload).length;
}

function resolverSourceUrl(item) {
  if (typeof item === "string") {
    return item;
  }
  if (!item || typeof item !== "object") {
    return "";
  }
  return item.sourceUrl || item.source_url || item.url || item.playUrl ||
    item.play_url || item.directUrl || item.direct_url || item.file ||
    item.src || "";
}

// 可用播放地址包括绝对 URL 和上游根相对路径；data: 里的 HLS 清单不能算作
// 已拿到播放源。统一校验协议与媒体主机，避免薄结果过早结束线路合并。
export function resolverPayloadHasUsableSource(payload, env = {}) {
  return resolverVariants(payload).some((item) => {
    const raw = String(resolverSourceUrl(item) || "").trim();
    if (!raw || raw.startsWith("data:")) {
      return false;
    }
    try {
      const upstreamOrigin = normalizeOrigin(env.UPSTREAM_ORIGIN);
      const url = new URL(raw, upstreamOrigin);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return false;
      }
      return url.origin === upstreamOrigin ||
        isAllowedMediaHost(url.hostname, env);
    } catch {
      return false;
    }
  });
}

function canonicalResolverSource(item) {
  const source =
    typeof item === "string"
      ? item
      : item?.sourceUrl || item?.source_url || item?.url || item?.playUrl ||
        item?.play_url || item?.directUrl || item?.direct_url || item?.file ||
        item?.src;
  const value = String(source || "").trim();
  if (!value) return "";
  if (value.startsWith("data:")) {
    return value;
  }
  try {
    const url = new URL(value);
    url.hash = "";
    const search = [...url.searchParams.entries()].sort(([left], [right]) =>
      left.localeCompare(right));
    url.search = "";
    for (const [name, paramValue] of search) {
      url.searchParams.append(name, paramValue);
    }
    return url.toString();
  } catch {
    return value;
  }
}

function resolverVariantKey(item) {
  const sourceKey = canonicalResolverSource(item);
  const variant = String(item?.variant || item?.name || item?.id || "")
    .trim()
    .toLowerCase();
  const label = String(item?.label || item?.displayName || "").trim().toLowerCase();
  if (sourceKey) {
    // 同一线路名可能由多个来源返回（例如两个端点都报 original），不能只按名称
    // 去重；URL 与名称都相同才算重复，从而保留不同 CDN 的真实备用线路。
    return `source:${sourceKey}|variant:${variant}|label:${label}`;
  }
  if (variant) {
    return `variant:${variant}`;
  }
  return label ? `label:${label}` : "";
}

function mergeResolverPayloads(primary, fallback) {
  const variants = [];
  const seen = new Set();
  [primary, fallback].forEach((payload, payloadIndex) => {
    resolverVariants(payload).forEach((item, itemIndex) => {
      const key = resolverVariantKey(item) ||
        `payload:${payloadIndex}:item:${itemIndex}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      variants.push(item);
    });
  });

  const base = primary && !Array.isArray(primary) ? primary : {};
  const merged = { ...base, variants };
  if (Object.prototype.hasOwnProperty.call(base, "data")) {
    merged.data = base.data && typeof base.data === "object" && !Array.isArray(base.data)
      ? { ...base.data, variants }
      : variants;
  }
  return merged;
}

function settledWithin(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function createResolverVariantParser() {
  let json = "";
  let keySearchIndex = 0;
  let arrayStart = -1;
  let scanIndex = -1;
  let arrayComplete = false;
  let inString = false;
  let escaped = false;
  let elementStart = -1;
  let elementDepth = 0;
  const variants = [];

  const findArrayStart = () => {
    if (arrayStart >= 0) return;
    const pattern = /"(?:variants|sources|videos|streams)"\s*:/g;
    pattern.lastIndex = keySearchIndex;
    const match = pattern.exec(json);
    if (!match) {
      keySearchIndex = Math.max(0, json.length - 32);
      return;
    }
    let index = pattern.lastIndex;
    while (index < json.length && /\s/.test(json[index])) index += 1;
    if (json[index] !== "[") {
      keySearchIndex = pattern.lastIndex;
      return;
    }
    arrayStart = index;
    scanIndex = index + 1;
  };

  const scan = () => {
    findArrayStart();
    if (arrayStart < 0 || arrayComplete) return;
    while (scanIndex < json.length) {
      const char = json[scanIndex];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        scanIndex += 1;
        continue;
      }
      if (char === '"') {
        inString = true;
        scanIndex += 1;
        continue;
      }
      if (elementStart < 0) {
        if (char === "]") {
          arrayComplete = true;
          try {
            const complete = JSON.parse(json.slice(arrayStart, scanIndex + 1));
            if (Array.isArray(complete)) {
              variants.splice(0, variants.length, ...complete);
            }
          } catch {
            // 已收集到的对象仍可用。
          }
          break;
        }
        if (char === "{") {
          elementStart = scanIndex;
          elementDepth = 1;
        }
      } else if (char === "{" || char === "[") {
        elementDepth += 1;
      } else if (char === "}" || char === "]") {
        elementDepth -= 1;
        if (elementDepth === 0) {
          try {
            variants.push(JSON.parse(json.slice(elementStart, scanIndex + 1)));
          } catch {
            // 半截或非对象元素直接跳过。
          }
          elementStart = -1;
        }
      }
      scanIndex += 1;
    }
  };

  return {
    push(fragment) {
      if (!fragment) return;
      json += fragment;
      scan();
    },
    variants() {
      return variants.slice();
    },
    complete() {
      return arrayComplete;
    },
    payload() {
      if (variants.length || arrayComplete) {
        return { variants: variants.slice() };
      }
      try {
        return JSON.parse(json);
      } catch {
        return null;
      }
    },
  };
}

async function readResolverJsonResponse(response) {
  const timeoutMs = RESOLVER_FIRST_VARIANT_TIMEOUT_MS;
  const timeoutAt = Date.now() + timeoutMs;
  let pendingRead = null;
  const readWithDeadline = async (reader, deadline) => {
    if (!pendingRead) {
      // Reuse the pending read after a deadline so a later loop cannot issue a
      // second reader.read() against the same response stream.
      pendingRead = reader.read().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    }
    let timer;
    const timedOut = Symbol("timedOut");
    const timeout = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve(timedOut),
        Math.max(0, deadline - Date.now()),
      );
    });
    let result;
    try {
      result = await Promise.race([pendingRead, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (result === timedOut) {
      return null;
    }
    pendingRead = null;
    if (result.error) {
      throw result.error;
    }
    return result.value;
  };

  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await Promise.race([
      response.text(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Resolver response timed out")), timeoutMs);
      }),
    ]);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Resolver returned non-JSON (${response.status})`);
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createResolverVariantParser();

  try {
    while (Date.now() < timeoutAt) {
      const chunk = await readWithDeadline(reader, timeoutAt);
      if (!chunk) {
        break;
      }
      if (chunk.done) {
        parser.push(decoder.decode());
        const payload = parser.payload();
        if (payload) return payload;
        throw new Error(`Resolver returned non-JSON (${response.status})`);
      }
      parser.push(decoder.decode(chunk.value, { stream: true }));
      if (parser.complete()) {
        return parser.payload();
      }
    }
    const payload = parser.payload();
    if (payload) return payload;
    throw new Error("Resolver response timed out");
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 取消失败不影响已解析的线路。
    }
  }
}

async function fetchResolverResult(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVER_FIRST_VARIANT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(String(url), {
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: controller.signal,
    });
    let payload;
    try {
      payload = await readResolverJsonResponse(response);
    } catch (error) {
      payload = {
        error: error instanceof Error
          ? error.message
          : `Resolver returned non-JSON (${response.status})`,
      };
    }
    return {
      ok: response.ok,
      status: response.status,
      payload,
      variantCount: response.ok ? resolverVariantCount(payload) : 0,
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      payload: {
        error: error instanceof Error ? error.message : "Resolver unavailable",
      },
      variantCount: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function handlePublicApi(request, env = {}, fetchImpl = fetch) {
  const incoming = new URL(request.url);
  if (incoming.pathname !== "/api/v/resolve" && incoming.pathname !== "/api/subtitle") {
    return null;
  }
  if (incoming.pathname === "/api/subtitle") {
    return new Response(JSON.stringify({ error: "Subtitle resolver is unavailable" }), {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  }
  const code = String(incoming.searchParams.get("code") || "").trim();
  if (!code) {
    return new Response(JSON.stringify({ error: "Movie code is required" }), {
      status: 400,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  }
  const resolverOrigin = String(env.JAVSTRM_ORIGIN || "https://javstrm.emby-59f.workers.dev").replace(/\/$/, "");
  const target = new URL("/api/resolve", resolverOrigin);
  target.searchParams.set("code", code);
  if (incoming.searchParams.get("refresh") === "1") {
    target.searchParams.set("refresh", "1");
  }
  const fallbackTarget = new URL(
    "/api/v/resolve",
    normalizeOrigin(env.UPSTREAM_ORIGIN),
  );
  fallbackTarget.searchParams.set("code", code);
  fallbackTarget.searchParams.set("lang", "zh");
  if (incoming.searchParams.get("refresh") === "1") {
    fallbackTarget.searchParams.set("refresh", "1");
  }

  const primaryPromise = fetchResolverResult(target, fetchImpl);
  let result;
  if (fallbackTarget.toString() !== target.toString()) {
    const fallbackPromise = fetchResolverResult(fallbackTarget, fetchImpl);
    const entries = [
      { name: "primary", promise: primaryPromise },
      { name: "fallback", promise: fallbackPromise },
    ];
    const firstValid = await new Promise((resolve) => {
      let remaining = entries.length;
      let resolved = false;
      entries.forEach((entry) => {
        entry.promise.then((settled) => {
          remaining -= 1;
          if (!resolved && settled.ok && settled.variantCount > 0) {
            resolved = true;
            resolve({ name: entry.name, settled });
            return;
          }
          if (!resolved && remaining === 0) {
            resolved = true;
            resolve(null);
          }
        });
      });
    });
    if (!firstValid) {
      const primaryResult = await primaryPromise;
      const fallbackResult = await fallbackPromise;
      result = primaryResult.variantCount >= fallbackResult.variantCount
        ? primaryResult
        : fallbackResult;
    } else {
      const otherPromise = firstValid.name === "primary" ? fallbackPromise : primaryPromise;
      const firstHasUsableSource = resolverPayloadHasUsableSource(
        firstValid.settled.payload,
        env,
      );
      const other = await settledWithin(
        otherPromise,
        resolverMergeBudget(
          env,
          firstHasUsableSource
            ? RESOLVER_SECONDARY_MERGE_MS
            : RESOLVER_THIN_MERGE_MS,
        ),
      );
      const primaryResult = firstValid.name === "primary" ? firstValid.settled : other;
      const fallbackResult = firstValid.name === "fallback" ? firstValid.settled : other;
      if (
        primaryResult?.ok &&
        fallbackResult?.ok &&
        primaryResult.variantCount > 0 &&
        fallbackResult.variantCount > 0
      ) {
      const payload = mergeResolverPayloads(
        primaryResult.payload,
        fallbackResult.payload,
      );
      result = {
        ...fallbackResult,
        payload,
        variantCount: resolverVariantCount(payload),
      };
      } else {
        result = primaryResult?.variantCount > 0
          ? primaryResult
          : fallbackResult;
      }
    }
  } else {
    result = await primaryPromise;
  }

  return new Response(JSON.stringify(result.payload), {
    status: result.ok ? 200 : result.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

export async function handleProxy(
  request,
  env = {},
  _context = {},
  fetchImpl = fetch,
) {
  const publicApiResponse = await handlePublicApi(request, env, fetchImpl);
  if (publicApiResponse) {
    return publicApiResponse;
  }
  // Keep background resolution and playback-state writes alive after the
  // response returns. Without the Pages ExecutionContext, cold detail and
  // PlaybackInfo requests can time out, get killed, and only expose a single
  // placeholder source on the next refresh.
  const embyResponse = await handleEmby(request, env, fetchImpl, _context);
  if (embyResponse) {
    return embyResponse;
  }

  const target = resolveUpstreamTarget(request.url, env);

  if (target.kind === "blocked") {
    return forbiddenProxyResponse();
  }

  const incoming = new URL(request.url);
  const publicOrigin = incoming.origin;
  const headers = createForwardHeaders(request, target.upstreamOrigin);
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (!BODYLESS_METHODS.has(request.method.toUpperCase())) {
    init.body = request.body;
  }

  const upstreamResponse = await fetchImpl(target.url.toString(), init);

  if (upstreamResponse.status === 101) {
    return upstreamResponse;
  }

  const responseHeaders = copyResponseHeaders(
    upstreamResponse,
    publicOrigin,
    target.upstreamOrigin,
    env,
  );

  if (
    request.method.toUpperCase() === "HEAD" ||
    BODYLESS_STATUSES.has(upstreamResponse.status)
  ) {
    return new Response(null, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  }

  if (!isTextResponse(responseHeaders)) {
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  }

  const text = await upstreamResponse.text();
  const body = rewriteText(
    text,
    publicOrigin,
    target.upstreamOrigin,
    env,
  );

  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("etag");

  return new Response(body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
