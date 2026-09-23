const DEFAULT_API_ORIGIN = "https://jdforrepam.com/api";
const DEFAULT_UPSTREAM_ORIGIN = "https://catembylegacy.fastcdn.dpdns.org";
const DEFAULT_RESOLVER_ORIGIN = "https://catembylegacy.fastcdn.dpdns.org";
// 原站公开解析接口为 /api/v/resolve（无需登录）；旧解析器路径为 /api/resolve，
// 可用 JAVSTRM_RESOLVE_PATH 覆盖，便于随时切回或换源。
const DEFAULT_RESOLVER_RESOLVE_PATH = "/api/v/resolve";
const SIGNATURE_KEY = "lpw6vgqzsp";
const SIGNATURE_SECRET =
  "71cf27bb3c0bcdf207b64abecddc970098c7421ee7203b9cdae54478478a199e7d5a6e1a57691123c1a931c057842fb73ba3b3c83bcd69c17ccf174081e3d8aa";
const ROOT_ID = "bbjavdb-root";
// “中文可播放”分类在客户端显示为“中文字幕”：只收“有中文字幕且可播放”的影片。
// 原“可播放”分类已按要求移除，避免与“有码/无码/欧美”重复。
const CHINESE_PLAYABLE_LIBRARY_ID = "bbjavdb-chinese-playable";
const CENSORED_LIBRARY_ID = "bbjavdb-censored";
const UNCENSORED_LIBRARY_ID = "bbjavdb-uncensored";
const WESTERN_LIBRARY_ID = "bbjavdb-western";
const USER_ID = "bbjavdb-user";
const PRODUCT_NAME = "月影emby";
const DEFAULT_GUEST_TOKEN = "bbjavdb-guest";
const LIBRARIES = [
  {
    id: CHINESE_PLAYABLE_LIBRARY_ID,
    name: "中文字幕",
    sourceType: "all",
    sourceFilter: "subtitle",
    matches: (movie) => isPlayableChinese(movie),
  },
  {
    id: CENSORED_LIBRARY_ID,
    name: "有码",
    sourceType: "0",
    sourceFilter: "can_play",
    matches: (movie) => Boolean(movie?.can_play),
  },
  {
    id: UNCENSORED_LIBRARY_ID,
    name: "无码",
    sourceType: "1",
    sourceFilter: "can_play",
    matches: (movie) => Boolean(movie?.can_play),
  },
  {
    id: WESTERN_LIBRARY_ID,
    name: "欧美",
    sourceType: "2",
    sourceFilter: "can_play",
    matches: (movie) => Boolean(movie?.can_play),
  },
];

const MEDIA_HOSTS = new Set([
  "fast-stream.jav.si",
  "jdforrepam.com",
  "tp.spfcas.com",
  "h1.gzankun.com",
]);
const MEDIA_SUFFIXES = [".spfcas.com", ".gzankun.com"];
const INLINE_HLS_CONTENT_TYPES = new Set([
  "application/mpegurl",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
]);
// 解析器有时会把整段 HLS 清单塞进 data URL。不同资源的清单大小差异很大，
// 旧上限会把稍大的备用线路直接过滤掉，客户端就只剩一条播放源。
const MAX_INLINE_HLS_LENGTH = 12_000_000;
// 修改播放源结构后提升缓存版本，避免已经缓存成“只有一条”的旧结果继续命中。
const RESOLVE_VIDEO_CACHE_VERSION = "sources-v3";
const DEFAULT_PAGE_SIZE = 1000;
const HOME_SOURCE_PAGE_SIZE = 50;
const HOME_MAX_SOURCE_PAGES = 40;
const SEARCH_SOURCE_PAGE_SIZE = 50;
const SEARCH_MAX_SOURCE_PAGES = 40;
const IMAGE_CONTENT_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const IMAGE_SIGNATURES = [
  { contentType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { contentType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { contentType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { contentType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  { contentType: "image/bmp", bytes: [0x42, 0x4d] },
];

function add32(...values) {
  return values.reduce((sum, value) => (sum + value) | 0, 0);
}

function rotateLeft(value, amount) {
  return (value << amount) | (value >>> (32 - amount));
}

function littleEndianHex(value) {
  const unsigned = value >>> 0;
  let result = "";
  for (let index = 0; index < 4; index += 1) {
    result += (`0${((unsigned >>> (index * 8)) & 255).toString(16)}`).slice(-2);
  }
  return result;
}

// The upstream API uses MD5 for its public, time-based request signature.
function md5(value) {
  const bytes = new TextEncoder().encode(value);
  const blockLength = (((bytes.length + 8) >>> 6) + 1) * 16;
  const words = new Int32Array(blockLength);

  for (let index = 0; index < bytes.length; index += 1) {
    words[index >>> 2] |= bytes[index] << ((index & 3) * 8);
  }

  words[bytes.length >>> 2] |= 0x80 << ((bytes.length & 3) * 8);
  const bitLength = bytes.length * 8;
  words[blockLength - 2] = bitLength;
  words[blockLength - 1] = Math.floor(bitLength / 4294967296);

  const shifts = [
    [7, 12, 17, 22],
    [5, 9, 14, 20],
    [4, 11, 16, 23],
    [6, 10, 15, 21],
  ];
  const constants = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];

  let a = 0x67452301 | 0;
  let b = 0xefcdab89 | 0;
  let c = 0x98badcfe | 0;
  let d = 0x10325476 | 0;

  for (let offset = 0; offset < blockLength; offset += 16) {
    const originalA = a;
    const originalB = b;
    const originalC = c;
    const originalD = d;

    for (let index = 0; index < 64; index += 1) {
      let functionValue;
      let wordIndex;
      let round;

      if (index < 16) {
        functionValue = (b & c) | (~b & d);
        wordIndex = index;
        round = 0;
      } else if (index < 32) {
        functionValue = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
        round = 1;
      } else if (index < 48) {
        functionValue = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
        round = 2;
      } else {
        functionValue = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
        round = 3;
      }

      const shifted = add32(
        a,
        functionValue,
        words[offset + wordIndex],
        constants[index],
      );
      const nextA = d;
      d = c;
      c = b;
      b = add32(
        b,
        rotateLeft(shifted, shifts[round][index % 4]),
      );
      a = nextA;
    }

    a = add32(a, originalA);
    b = add32(b, originalB);
    c = add32(c, originalC);
    d = add32(d, originalD);
  }

  return [a, b, c, d].map(littleEndianHex).join("");
}

export function createJavdbSignature(timestamp = Math.floor(Date.now() / 1000)) {
  const value = String(timestamp);
  return `${value}.${SIGNATURE_KEY}.${md5(value + SIGNATURE_SECRET)}`;
}

function jsonResponse(value, status = 200, extraHeaders = {}) {
  // 客户端（Gson/Jackson 等）按对象解析响应体，空 body 会直接抛
  // “Expected start of the object '{', but had 'EOF'”。这里兜底保证
  // 成功响应永远是合法 JSON。
  return new Response(JSON.stringify(value === undefined ? {} : value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}

function errorResponse(status, message) {
  return jsonResponse({
    error: message,
    ErrorCode: status === 401 ? "Unauthorized" : "UnknownError",
    Message: message,
  }, status);
}

function apiOrigin(env) {
  return String(env.JAVDB_API_ORIGIN || DEFAULT_API_ORIGIN).replace(/\/$/, "");
}

function upstreamOrigin(env) {
  return new URL(env.UPSTREAM_ORIGIN || DEFAULT_UPSTREAM_ORIGIN).origin;
}

function resolverOrigin(env) {
  return String(env.JAVSTRM_ORIGIN || DEFAULT_RESOLVER_ORIGIN).replace(/\/$/, "");
}

function resolverResolvePath(env) {
  const value = String(env.JAVSTRM_RESOLVE_PATH || DEFAULT_RESOLVER_RESOLVE_PATH).trim();
  if (!value) return DEFAULT_RESOLVER_RESOLVE_PATH;
  return value.startsWith("/") ? value : `/${value}`;
}

function mediaHostAllowed(hostname, env) {
  const host = String(hostname || "").toLowerCase();
  if (MEDIA_HOSTS.has(host) || MEDIA_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }

  return String(env.EXTRA_MEDIA_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(host);
}

function safeMediaUrl(value, env) {
  try {
    const raw = String(value || "").trim();
    if (!raw || raw.startsWith("data:")) {
      return null;
    }

    // Resolver responses have used both absolute and root-relative URLs over
    // time. Relative media paths are safe because they are pinned to the
    // configured upstream origin before the host allowlist is checked.
    const url = new URL(raw, upstreamOrigin(env));
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }

    if (url.origin === upstreamOrigin(env) || mediaHostAllowed(url.hostname, env)) {
      return url;
    }
  } catch {
    return null;
  }

  return null;
}

function sourceUrlValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  return value.sourceUrl || value.source_url || value.url || value.playUrl ||
    value.play_url || value.directUrl || value.direct_url || value.file ||
    value.src || "";
}

function sourceVariants(payload) {
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
  const list = candidates.find((item) => Array.isArray(item) && item.length > 0) ||
    candidates.find(Array.isArray);
  if (list) {
    return list;
  }

  // Some resolver versions return one source object instead of an array.
  return sourceUrlValue(data) ? [data] : [];
}

function videoVariantLabel(source, index, total) {
  const label = String(source?.label || "").trim();
  if (label) return label;
  const variant = String(source?.variant || "").trim();
  if (variant === "original") return "原版";
  if (/reduc|mosaic|compress|small/i.test(variant)) return "压缩版";
  if (variant) return variant;
  return `线路 ${index + 1}`;
}

function safeMediaContentType(value) {
  const type = String(value || "").toLowerCase();
  return /^(?:video\/[a-z0-9.+-]+|application\/(?:vnd\.apple\.|x-)?mpegurl)$/.test(type)
    ? type
    : "video/mp4";
}

function decodeInlineHls(value) {
  const source = String(value || "");
  if (!source.startsWith("data:") || source.length > MAX_INLINE_HLS_LENGTH) {
    return null;
  }

  const commaIndex = source.indexOf(",");
  if (commaIndex === -1) {
    return null;
  }

  const metadata = source.slice(5, commaIndex).toLowerCase();
  const contentType = metadata.split(";")[0];
  if (!INLINE_HLS_CONTENT_TYPES.has(contentType)) {
    return null;
  }

  try {
    const payload = source.slice(commaIndex + 1);
    const playlist = metadata.split(";").includes("base64")
      ? new TextDecoder().decode(
          Uint8Array.from(atob(payload), (character) => character.charCodeAt(0)),
        )
      : decodeURIComponent(payload);
    return playlist.trimStart().startsWith("#EXTM3U") ? playlist : null;
  } catch {
    return null;
  }
}

function getToken(request, url) {
  const queryToken =
    url.searchParams.get("api_key") ||
    url.searchParams.get("ApiKey") ||
    url.searchParams.get("access_token") ||
    url.searchParams.get("AccessToken");
  if (queryToken) {
    return queryToken;
  }

  const directToken =
    request.headers.get("x-emby-token") ||
    request.headers.get("x-mediabrowser-token");
  if (directToken) {
    return directToken;
  }

  const authorization =
    request.headers.get("x-emby-authorization") ||
    request.headers.get("authorization") ||
    "";
  const tokenMatch = authorization.match(/\bToken\s*[=:]\s*"?([^",\s]+)/i);
  if (tokenMatch) {
    return tokenMatch[1];
  }

  const bearerMatch = authorization.match(/^Bearer\s+([^\s]+)/i);
  return bearerMatch ? bearerMatch[1] : "";
}

function requestDeviceId(request) {
  const header =
    request.headers.get("x-emby-authorization") ||
    request.headers.get("x-mediabrowser-authorization") ||
    request.headers.get("authorization") ||
    "";
  const match = header.match(/(?:^|[,\s])DeviceId\s*=\s*"?([^",\s]+)/i);
  if (match) {
    return match[1];
  }
  return String(request.headers.get("x-emby-device-id") || "");
}

function routePath(requestUrl) {
  const path = new URL(requestUrl).pathname;
  const withoutPrefix = /^\/emby(?:\/|$)/i.test(path)
    ? path.slice("/emby".length)
    : path;
  return withoutPrefix.replace(/\/+$/, "") || "/";
}

function normalizeClientPath(path) {
  return path
    .replace(/^\/Users\/[^/]+\/Items(?=\/|$)/i, "/Items")
    // 有些客户端的“继续观看”走 /Users/{uid}/Resume，之前会落到 404，
    // 客户端于是退回自己本地缓存的列表——表现就是“移除了又出现”。
    .replace(/^\/Users\/[^/]+\/Resume(?:\/.*)?$/i, "/Items/Resume")
    .replace(/^\/Users\/[^/]+\/Suggestions$/i, "/Suggestions");
}

function publicRoutePath(requestUrl, path) {
  const requestPath = new URL(requestUrl).pathname;
  return /^\/emby(?:\/|$)/i.test(requestPath) ? `/emby${path}` : path;
}

function serverId(env) {
  return String(env.EMBY_SERVER_ID || "bbjavdb-emby");
}

function guestAccessEnabled(env) {
  const value = String(env.EMBY_GUEST_ACCESS ?? "false").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function guestToken(env) {
  return String(env.EMBY_GUEST_TOKEN || DEFAULT_GUEST_TOKEN);
}

// 默认“本地信任登录”：不要求真实 JavDB 账号，随便输入的用户名都能登录成功。
// 只有显式设置 EMBY_REAL_JAVDB_LOGIN=true 时，才回到“必须真实 JavDB 账号验证”。
function realJavdbLoginEnabled(env) {
  const value = String(env.EMBY_REAL_JAVDB_LOGIN ?? "false").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

// 固定登录密码：设置 EMBY_LOGIN_PASSWORD 后，密码必须与它一致才能登录；
// 未设置时则仅要求“必须填写密码”（任意非空密码都可通过）。
function loginPassword(env) {
  return String(env.EMBY_LOGIN_PASSWORD || "").trim();
}

function virtualUser(env = {}, name = "JAVDB Guest", hasPassword = false) {
  return {
    Id: USER_ID,
    Name: name,
    ServerId: serverId(env),
    HasPassword: hasPassword,
    HasConfiguredPassword: hasPassword,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: !hasPassword,
    LastLoginDate: new Date().toISOString(),
    LastActivityDate: new Date().toISOString(),
    Configuration: {
      PlayDefaultAudioTrack: true,
      SubtitleLanguagePreference: "zh-CN",
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      SubtitleMode: "Default",
      DisplayCollectionsView: false,
      EnableLocalPassword: false,
      OrderedViews: [],
      LatestItemsExcludes: [],
      MyMediaExcludes: [],
      HidePlayedInLatest: false,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
    },
    Policy: {
      IsAdministrator: false,
      IsHidden: false,
      IsDisabled: false,
      BlockedTags: [],
      EnableUserPreferenceAccess: true,
      AccessSchedules: [],
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableRemoteAccess: true,
      EnableLiveTvManagement: false,
      EnableLiveTvAccess: true,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: true,
      EnableVideoPlaybackTranscoding: true,
      EnablePlaybackRemuxing: true,
      EnableContentDeletion: false,
      EnableContentDownloading: true,
      EnableSyncTranscoding: true,
      EnableMediaConversion: true,
      EnableAllFolders: true,
      EnabledFolders: [],
      EnableContentDeletionFromFolders: [],
      InvalidLoginAttemptCount: 0,
      LoginAttemptsBeforeLockout: -1,
      IsProtected: false,
      EnablePublicSharing: true,
      RemoteClientBitrateLimit: 0,
      AuthenticationProviderId: "DefaultAuthenticationProvider",
      PasswordResetProviderId: "DefaultPasswordResetProvider",
      SyncPlayAccess: "CreateAndJoin",
    },
  };
}

// 上游请求统一加超时与一次重试：解析/数据接口首次冷启动或瞬时抖动时，
// 客户端不会因为某个上游一直不返回而无限转圈。媒体流（播放/字幕/图片）
// 是长连接，不走这里，避免中途被超时打断。
const FETCH_TIMEOUT_MS = 10000;
const FETCH_MAX_ATTEMPTS = 2;
// 播放源解析接口是第三方现场抓取：新片子第一次通常要 10 秒左右，比普通接口慢很多。
// 单独放宽它的超时，避免刚好在 10 秒被掐断、白白重新来一遍。
const RESOLVER_FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(fetchImpl, url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchWithTimeout(fetchImpl, url, options, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  throw lastError;
}

// ---------- 访问加速缓存 ----------
// Worker 实例会被反复复用。这里把“影片元数据 / 播放源与字幕解析结果 / 分类列表页”
// 在进程内缓存一小段时间，并把同一个 key 的并发请求合并成一次回源。
// 效果：同一部片或同一页数据在一次浏览里只回源一次，翻页回退、返回再进、
// 以及起播时的等待都会明显缩短。
const MOVIE_CACHE_TTL_MS = 10 * 60 * 1000;
const RESOLVE_CACHE_TTL_MS = 30 * 60 * 1000;
const LIST_CACHE_TTL_MS = 60 * 1000;
const MAX_MOVIE_CACHE_ENTRIES = 4000;
const MAX_RESOLVE_CACHE_ENTRIES = 1000;
const MAX_LIST_CACHE_ENTRIES = 400;

function createTtlCache(ttlMs, maxEntries) {
  const entries = new Map();
  const pending = new Map();

  const read = (key) => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    // 命中后挪到末尾，容量满时优先淘汰最久没用到的键。
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  };

  const write = (key, value) => {
    entries.set(key, { value, expires: Date.now() + ttlMs });
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  };

  return {
    read,
    write,
    // 手动丢弃某个 key（例如缓存里的直链已失效，需要重新解析）。
    forget: (key) => {
      entries.delete(key);
      pending.delete(key);
    },
    // 同一个 key 的并发请求只回源一次；失败不缓存，等下次再试。
    fetch: async (key, compute) => {
      const cached = read(key);
      if (cached !== undefined) return cached;
      const running = pending.get(key);
      if (running) return running;
      const task = (async () => {
        const value = await compute();
        if (value !== undefined && value !== null) write(key, value);
        return value;
      })();
      pending.set(key, task);
      try {
        return await task;
      } finally {
        pending.delete(key);
      }
    },
  };
}

const MOVIE_CACHE = createTtlCache(MOVIE_CACHE_TTL_MS, MAX_MOVIE_CACHE_ENTRIES);
const RESOLVE_VIDEO_CACHE = createTtlCache(RESOLVE_CACHE_TTL_MS, MAX_RESOLVE_CACHE_ENTRIES);
const RESOLVE_SUBTITLE_CACHE = createTtlCache(RESOLVE_CACHE_TTL_MS, MAX_RESOLVE_CACHE_ENTRIES);
const LIST_CACHE = createTtlCache(LIST_CACHE_TTL_MS, MAX_LIST_CACHE_ENTRIES);
const API_TOKEN_CACHE = createTtlCache(60 * 1000, 500);

// ---------- 边缘缓存（跨实例复用） ----------
// 上面的缓存只活在“当前 Worker 实例”的内存里：实例重启、扩容、换节点后就全部失效，
// 于是每次冷启动都要重新回源，“第一次总是慢”主要就慢在这里。
// 下面把最热的几类结果（影片元数据 / 播放源解析 / 字幕列表 / 分类列表页）
// 再写一份到 Cloudflare 的边缘缓存：不同客户端、不同实例都能直接命中；
// 缓存键做哈希、不含登录信息，既不会串号也不会泄漏 token。
let edgeCacheOrigin = "";

const EDGE_NAMESPACE_MOVIE = "movie";
const EDGE_NAMESPACE_VIDEO = "video";
const EDGE_NAMESPACE_SUBTITLE = "subtitle";
const EDGE_NAMESPACE_LIST = "list";

function edgeCacheStore() {
  try {
    return typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

function edgeCacheRequest(namespace, key) {
  if (!edgeCacheOrigin) {
    return null;
  }
  try {
    return new Request(
      `${edgeCacheOrigin}/__emby-cache/v1/${namespace}/${md5(String(key))}`,
      { method: "GET" },
    );
  } catch {
    return null;
  }
}

async function edgeCacheRead(namespace, key) {
  const store = edgeCacheStore();
  const cacheKey = store ? edgeCacheRequest(namespace, key) : null;
  if (!store || !cacheKey) {
    return undefined;
  }
  try {
    const hit = await store.match(cacheKey);
    if (!hit) {
      return undefined;
    }
    const value = await hit.json();
    return value === undefined || value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

async function edgeCacheWrite(namespace, key, value, ttlSeconds) {
  const store = edgeCacheStore();
  const cacheKey = store ? edgeCacheRequest(namespace, key) : null;
  if (!store || !cacheKey) {
    return;
  }
  try {
    const seconds = Math.max(30, Math.round(Number(ttlSeconds) || 30));
    await store.put(cacheKey, new Response(JSON.stringify(value), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        // 边缘缓存按响应头里的 max-age 决定存活时间。
        "cache-control": `public, max-age=${seconds}`,
      },
    }));
  } catch {
    // 边缘缓存写失败（不支持、配额等）不能影响正常返回。
  }
}

function forgetEdgeCache(namespace, key) {
  const store = edgeCacheStore();
  const cacheKey = store ? edgeCacheRequest(namespace, key) : null;
  if (!store || !cacheKey) {
    return;
  }
  try {
    store.delete(cacheKey).catch(() => {});
  } catch {
    // 忽略：删不掉也不影响本次播放。
  }
}

// 图片内容只跟“影片 + 尺寸”有关：把 api_key / UserId 这类随会话变化的参数剔除，
// 不同客户端、不同登录状态就能共用同一份图片边缘缓存，命中率更高。
function edgeImageCacheKey(url) {
  const parts = [];
  for (const name of ["maxWidth", "maxHeight", "width", "height", "quality", "tag"]) {
    const value = url.searchParams.get(name);
    if (value) {
      parts.push(`${name}=${value}`);
    }
  }
  return new Request(
    `${url.origin}/__emby-cache/v1/image/${md5(`${url.pathname}|${parts.join("&")}`)}`,
    { method: "GET" },
  );
}

// 分类 / 演员列表页的两级缓存：内存命中直接返回；内存没有但边缘有就回填内存；
// 两边都没有才回源上游（回源结果非空时再写一份到边缘）。
async function cachedListPage(cacheKey, ttlSeconds, compute) {
  return LIST_CACHE.fetch(cacheKey, async () => {
    const shared = await edgeCacheRead(EDGE_NAMESPACE_LIST, cacheKey);
    if (shared !== undefined) {
      return shared;
    }
    const page = await compute();
    if (page && Array.isArray(page.movies) && page.movies.length > 0) {
      await edgeCacheWrite(EDGE_NAMESPACE_LIST, cacheKey, page, ttlSeconds);
    }
    return page;
  });
}

// 并发抓取上游分页：原来一页一页顺序请求，首次打开分类/演员页要等很久。
// 现在按页码小批量并发抓取、再按页码顺序合并，同时保留“够用就提前停止”的快速路径。
const SOURCE_PAGE_CONCURRENCY = 6;

async function fetchPagesInParallel(options) {
  const {
    maxPages,
    pageSize,
    needAll,
    enough,
    fetchPage,
    collect,
    concurrency = SOURCE_PAGE_CONCURRENCY,
  } = options;

  let sourcePage = 1;
  while (sourcePage <= maxPages) {
    if (!needAll && enough()) {
      return false;
    }
    const batch = [];
    for (let page = sourcePage; page < sourcePage + concurrency && page <= maxPages; page += 1) {
      batch.push(page);
    }
    const results = await Promise.all(batch.map(async (page) => {
      try {
        return { page, movies: await fetchPage(page) };
      } catch {
        return { page, movies: null };
      }
    }));
    results.sort((left, right) => left.page - right.page);

    for (const result of results) {
      if (result.movies === null) {
        // 这一页抓取失败：不要继续往后翻，交给上层按“没翻到底”处理。
        if (result.page === sourcePage) return false;
        continue;
      }
      const movies = Array.isArray(result.movies) ? result.movies : [];
      if (movies.length) {
        collect(movies);
      }
      if (movies.length < pageSize) {
        // 这一页不满一页，说明已经翻到结果末尾。
        return true;
      }
    }
    sourcePage += batch.length;
  }
  return false;
}
async function javdbRequest(path, env, fetchImpl, options = {}) {
  const url = new URL(`${apiOrigin(env)}${path}`);
  if (options.query) {
    Object.entries(options.query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  headers.set("user-agent", "Mozilla/5.0");
  headers.set("jdsignature", createJavdbSignature());
  if (options.token) {
    headers.set("authorization", options.token);
  }

  const response = await fetchWithRetry(fetchImpl, url.toString(), {
    method: options.method || "GET",
    headers,
    body: options.body,
    redirect: "follow",
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `JavDB API HTTP ${response.status}`);
  }
  if (payload.success !== undefined && payload.success !== 1) {
    throw new Error(payload.message || "JavDB API request failed");
  }

  return payload.data === undefined ? payload : payload.data;
}

async function upstreamJson(path, env, fetchImpl) {
  const response = await fetchWithRetry(fetchImpl, new URL(path, upstreamOrigin(env)).toString(), {
    headers: { accept: "application/json" },
    redirect: "follow",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Upstream HTTP ${response.status}`);
  }
  return payload;
}

async function resolverJson(path, env, fetchImpl) {
  const response = await fetchWithRetry(fetchImpl, `${resolverOrigin(env)}${path}`, {
    headers: { accept: "application/json" },
    redirect: "follow",
  }, RESOLVER_FETCH_TIMEOUT_MS);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Resolver returned non-JSON (${response.status})`);
  }
  if (!response.ok) {
    const detail = payload.code ? ` [code=${payload.code}]` : "";
    throw new Error(`${payload.message || payload.error || `Resolver HTTP ${response.status}`}${detail}`);
  }
  return payload;
}

function movieFromPayload(payload) {
  return payload?.movie || payload?.data?.movie || payload?.data || payload;
}

function moviesFromPayload(payload) {
  return payload?.movies || payload?.data?.movies || [];
}

function tagName(tag) {
  return typeof tag === "string" ? tag : tag?.name || "";
}

function hasChineseSubtitles(movie) {
  return Boolean(movie?.has_cnsub || Number(movie?.play_subtitle || 0) > 0);
}

function isPlayableChinese(movie) {
  return Boolean(movie?.can_play) && hasChineseSubtitles(movie);
}

function bytesStartWith(bytes, signature, offset = 0) {
  return bytes.length >= offset + signature.length &&
    signature.every((value, index) => bytes[offset + index] === value);
}

function sniffImageContentType(bytes) {
  for (const signature of IMAGE_SIGNATURES) {
    if (bytesStartWith(bytes, signature.bytes)) {
      return signature.contentType;
    }
  }
  if (
    bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytesStartWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  if (
    bytesStartWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) &&
    (
      bytesStartWith(bytes, [0x61, 0x76, 0x69, 0x66], 8) ||
      bytesStartWith(bytes, [0x61, 0x76, 0x69, 0x73], 8)
    )
  ) {
    return "image/avif";
  }
  return null;
}

function xorImageBytes(bytes, key, skip = 0) {
  const output = new Uint8Array(Math.max(bytes.length - skip, 0));
  for (let index = skip; index < bytes.length; index += 1) {
    output[index - skip] = bytes[index] ^ key;
  }
  return output;
}

function decodeImagePrefix(bytes) {
  const directType = sniffImageContentType(bytes);
  if (directType) {
    return { bytes, contentType: directType, xorKey: null };
  }

  if (bytes.length > 1) {
    const xorKey = bytes[0];
    const decoded = xorImageBytes(bytes, xorKey, 1);
    const contentType = sniffImageContentType(decoded);
    if (contentType) {
      return { bytes: decoded, contentType, xorKey };
    }
  }

  for (let skip = 0; skip <= 2; skip += 1) {
    const decoded = xorImageBytes(bytes, 0x7f, skip);
    const contentType = sniffImageContentType(decoded);
    if (contentType) {
      return { bytes: decoded, contentType, xorKey: 0x7f };
    }
  }

  return { bytes, contentType: null, xorKey: null };
}

async function decodeImageBody(body) {
  if (!body) {
    return { body: null, contentType: null };
  }

  const reader = body.getReader();
  const chunks = [];
  let byteLength = 0;
  while (byteLength < 12) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    chunks.push(result.value);
    byteLength += result.value.byteLength;
  }
  const prefix = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const decoded = decodeImagePrefix(prefix);
  const decodedBody = new ReadableStream({
    start(controller) {
      if (decoded.bytes.byteLength > 0) {
        controller.enqueue(decoded.bytes);
      }
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(
          decoded.xorKey === null
            ? result.value
            : xorImageBytes(result.value, decoded.xorKey),
        );
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { body: decodedBody, contentType: decoded.contentType };
}

function imageContentType(imageUrl, declaredType, detectedType) {
  if (detectedType) {
    return detectedType;
  }
  const normalized = String(declaredType || "").toLowerCase();
  if (normalized.startsWith("image/")) {
    return declaredType;
  }

  const pathname = imageUrl.pathname.toLowerCase();
  for (const [extension, contentType] of IMAGE_CONTENT_TYPES) {
    if (pathname.endsWith(extension)) {
      return contentType;
    }
  }

  return "image/jpeg";
}

// 展示用影片名称：番号 + 完整标题，例如 “JUR-799 息子の友人と…”；
// 若标题本身已带番号前缀（如 “ABC-123 xxx”），就不再重复拼接。
// 影片真正的“片名”候选：按“越接近原始片名越优先”排序。
// series_name / series 是系列名，不是影片标题（“标题只剩系列名”的根因就是拿它当片名），
// 所以与系列名完全相同的候选会被跳过。
function movieTitleCandidates(movie) {
  const seriesName = String(movie?.series_name || movie?.series || "").trim();
  const seen = new Set();
  const candidates = [];
  for (const raw of [
    movie?.origin_title,
    movie?.original_title,
    movie?.title,
    movie?.name,
  ]) {
    const text = String(raw || "").trim();
    if (!text || seen.has(text)) continue;
    if (seriesName && text === seriesName) continue;
    seen.add(text);
    candidates.push(text);
  }
  return candidates;
}

// 番号 + 完整片名，例如 “JUR-799 息子の友人と…”。
// 片名本身已带番号前缀（如 “ABC-123 xxx”）时不再重复拼接；
// 找不到真正的片名时只返回番号，绝不拿系列名冒充片名。
function resolveMovieTitle(movie) {
  const number = movieNumber(movie);
  const candidates = movieTitleCandidates(movie);
  if (!candidates.length) return number ? String(number) : "";
  return joinNumberAndTitle(number, candidates[0]);
}

function movieDisplayName(movie) {
  return resolveMovieTitle(movie) || String(movie?.id || "");
}

// 番号(品番)常见形态:ABC-123 / ABC123 / 123456_789 / 259LUXU-1234。
// 只认“字母+数字”或“数字+分隔符+数字”这类明确的番号样式,避免把普通标题误当番号。
// 从标题里切出候选番号:按非字母数字的字符切开(含全角括号、顿号等)。
const NUMBER_TOKEN_SPLITTER = /[^A-Za-z0-9_-]+/;
const NUMBER_TOKEN_PATTERNS = [
  /^[A-Za-z]{2,6}-\d{2,5}$/,
  /^[A-Za-z]{2,6}\d{2,5}$/,
  /^\d{4,6}[-_]\d{2,4}$/,
  /^\d{2,4}[A-Za-z]{2,6}[-_]?\d{2,5}$/,
];

function looksLikeMovieNumber(token) {
  return NUMBER_TOKEN_PATTERNS.some((pattern) => pattern.test(token));
}

// 全角字母数字 / 各种横线统一成半角:否则 “JUR–799”“ＪＵ－７９９” 这类写法会被切碎,
// 番号就提取不出来(标题里只剩中文名,客户端看起来就是“标题不完整”)。
function normalizeNumberText(value) {
  return String(value || "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63]/g, "-");
}

// 字母段和数字段被空格 / 横线分开时也整体识别(如 “JUR 799”“JUR-799”)。
const NUMBER_PAIR_PATTERN = /([A-Za-z]{2,6})[\s\-_]{0,3}(\d{2,5})(?![0-9])/;
// 标题里的这些“字母+数字”是画质 / 编码标记,不是番号。
const NUMBER_PAIR_BLOCKLIST = new Set([
  "HD", "FHD", "UHD", "SD", "WEB", "MP4", "AVI", "MOV", "MKV", "WMV",
  "HEVC", "AVC", "X264", "X265", "H264", "H265",
]);

// 从一段文字里提取番号:先整段匹配,再按词切,最后兜底“字母 + 数字”组合。
function movieNumberFromText(raw) {
  const text = normalizeNumberText(raw).trim();
  if (!text) return "";
  const upper = text.toUpperCase();
  if (looksLikeMovieNumber(upper)) {
    return upper;
  }
  for (const token of upper.split(NUMBER_TOKEN_SPLITTER)) {
    const value = token.trim();
    if (value && looksLikeMovieNumber(value)) {
      return value;
    }
  }
  const pair = NUMBER_PAIR_PATTERN.exec(upper);
  if (pair) {
    const letter = pair[1].toUpperCase();
    if (!NUMBER_PAIR_BLOCKLIST.has(letter)) {
      return letter + "-" + pair[2];
    }
  }
  return "";
}

// 取影片番号:优先用上游字段,字段缺失时从标题里兜底提取。
// (上游个别条目 number/number_letter 为空,以前会让客户端标题丢掉 JUR-799 这类番号。)
function movieNumber(movie) {
  const letterField = normalizeNumberText(movie?.number_letter || "").trim().toUpperCase();
  const numberField = normalizeNumberText(movie?.number || "").trim().toUpperCase();
  // 上游偶尔把番号拆成 number_letter + number 两个字段(如 “JUR” + “799”),
  // 这里先拼回完整番号,再去标题里兜底。
  if (/^[A-Z]{2,6}$/.test(letterField) && /^\d{2,5}$/.test(numberField)) {
    return letterField + "-" + numberField;
  }
  if (/^[A-Z]{2,6}$/.test(numberField) && /^\d{2,5}$/.test(letterField)) {
    return numberField + "-" + letterField;
  }
  // 上游字段有值就以它为准(保持原行为),只在字段为空时才从标题兜底提取。
  const explicit = normalizeNumberText(
    movie?.number || movie?.number_letter || movie?.code || "",
  ).trim().toUpperCase();
  if (explicit) {
    return explicit;
  }
  const candidates = [
    movie?.title,
    movie?.origin_title,
    movie?.original_title,
    movie?.name,
  ];
  for (const raw of candidates) {
    const found = movieNumberFromText(raw);
    if (found) return found;
  }
  return "";
}

function joinNumberAndTitle(number, title) {
  const text = String(title || "").trim();
  const code = String(number || "").trim();
  if (!code) return text;
  if (!text) return code;
  const pattern = movieNumberMatcher(code);
  // 标题里的番号可能是全角写法(ＪＵＲ－７９９)、或用了异体横线(–/—);
  // 匹配前先做一次等长规范化,命中后再按同样的下标从原标题里切掉,
  // 这样既不会重复拼接,也不会改动标题原文。normalizeNumberText 是逐字符
  // 一对一替换,所以下标可以直接复用。
  const haystack = normalizeNumberText(text);
  const match = pattern ? pattern.exec(haystack) : null;
  if (!match) {
    return (code + " " + text).trim();
  }
  if (match.index === 0) {
    return text;
  }
  const stripped = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
    .replace(EDGE_SEPARATORS, " ")
    .trim();
  return stripped ? (code + " " + stripped).trim() : code;
}

// 番号匹配:忽略大小写,并允许 JUR-799 / JUR799 / JUR 799 之间的分隔符差异。
const EDGE_SEPARATORS = /^[\s\-_\u3001,\uFF0C\u3002:\uFF1A\[\]\(\)\uFF08\uFF09]+|[\s\-_\u3001,\uFF0C\u3002:\uFF1A\[\]\(\)\uFF08\uFF09]+$/g;

function movieNumberMatcher(code) {
  const parts = [];
  for (const ch of String(code || "")) {
    if (/[A-Za-z0-9]/.test(ch)) {
      parts.push(ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    } else {
      parts.push("[\\s\\-_]*");
    }
  }
  if (!parts.length) return null;
  try {
    return new RegExp(parts.join(""), "i");
  } catch {
    return null;
  }
}

// 原始标题同样带上番号:部分客户端(Emby 安卓/TV)优先显示 OriginalTitle,
// 以前显示的是没有番号的日文原标题,看起来就像标题不完整。
function movieOriginalTitle(movie) {
  return resolveMovieTitle(movie);
}

function movieDisplayDate(movie) {
  const raw = String(
    movie?.release_date ||
    movie?.released_at ||
    movie?.delivery_date ||
    movie?.online_date ||
    movie?.publish_date ||
    movie?.published_at ||
    movie?.date ||
    movie?.created_at ||
    ""
  ).trim();
  if (!raw) return "";
  const match = raw.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function movieTagline(movie) {
  const date = movieDisplayDate(movie);
  return date ? `配信開始日 ${date}` : "";
}

function movieTaglines(movie) {
  const tagline = movieTagline(movie);
  return tagline ? [tagline] : undefined;
}

function mapMovie(movie, requestUrl, env = {}, parentId = CHINESE_PLAYABLE_LIBRARY_ID) {
  const id = String(movie.id ?? movie.number ?? "");
  const image = movie.cover_url || movie.thumb_url || "";
  const displayDate = movieDisplayDate(movie);
  const date = displayDate || movie.release_date || movie.released_at || "";
  const year = Number.parseInt(String(date).slice(0, 4), 10);
  const duration = Number(movie.duration || 0);
  // 上游返回的标签（巨乳 / 单体作品 / 4K 等）同时当作“类别”和“标签”用；
  // “中文字幕”是本服务自己补的一个可点击筛选标签。
  // 注意：不再补“可播放”这个标签（按需求，类别/标签里不显示它），
  // 但点任意类别/标签搜出来的列表仍然只包含可播放的作品（由各片库的筛选保证）。
  const sourceTags = [...new Set((movie.tags || []).map(tagName).filter(Boolean))];
  const tags = sourceTags.slice();
  if (hasChineseSubtitles(movie)) {
    tags.unshift("中文字幕");
  }
  const uniqueTags = [...new Set(tags)];
  // 演员信息：Id 用 person:<演员名> 编码。客户端在详情里点击演员后，
  // 服务端能凭这个 Id 反查出演员名，再回源搜索出该演员“可播放”的作品。
  // （原实现 Id 用的是 JavDB 演员数字 id，无法反查演员名，点击演员没有结果。）
  const actors = (movie.actors || []).filter(Boolean).map((actor) => {
    const actorName = actor.name || actor;
    return {
      Name: actorName,
      Type: "Actor",
      Id: actorName ? "person:" + actorName : String(actor.id || actorName || ""),
    };
  });
  const item = {
    Id: id,
    ServerId: serverId(env),
    ParentId: parentId,
    Name: movieDisplayName(movie),
    OriginalTitle: movieOriginalTitle(movie) || movieDisplayName(movie) || id,
    SortName: movieDisplayName(movie),
    Type: "Movie",
    IsFolder: false,
    CanDelete: false,
    CanDownload: true,
    SupportsSync: true,
    PlayAccess: "Full",
    LocationType: "Remote",
    MediaType: "Video",
    VideoType: "VideoFile",
    Container: "strm",
    Tagline: movieTagline(movie) || undefined,
    Taglines: movieTaglines(movie),
    Overview: String(movie?.summary || "").trim(),
    PremiereDate: (() => {
      const d = String(displayDate || date || "").trim();
      return d ? (d.includes("T") ? d : d + "T00:00:00.000Z") : undefined;
    })(),
    ProductionYear: Number.isFinite(year) ? year : undefined,
    ReleaseDate: displayDate || undefined,
    RunTimeTicks: duration > 0 ? Math.round(duration * 60 * 10_000_000) : undefined,
    Genres: uniqueTags,
    Tags: uniqueTags,
    // 详情页里的“类别 / 标签”是可点击的：Id 带前缀，客户端点下去会带
    // GenreIds / TagIds 回来，服务端再按名字回源搜索。
    GenreItems: uniqueTags.map((name) => ({ Name: name, Id: genreIdForName(name) })),
    TagItems: uniqueTags.map((name) => ({ Name: name, Id: tagIdForName(name) })),
    People: actors,
    ImageTags: image ? { Primary: id } : {},
    BackdropImageTags: [],
    PrimaryImageAspectRatio: image ? 0.667 : undefined,
    ProviderIds: { JavDB: id },
    UserData: {
      Played: false,
      PlayCount: 0,
      IsFavorite: false,
      PlaybackPositionTicks: 0,
    },
  };

  // 片商 / 导演 / 系列：Id 同样带前缀，点进去也能按名字回源搜索
  //（原来导演用的是数字 id，点开是空列表）。
  const studioName = String(movie.maker_name || "").trim();
  if (studioName) {
    item.Studios = [{ Name: studioName, Id: studioIdForName(studioName) }];
  } else if (movie.maker_id) {
    item.Studios = [{ Name: String(movie.maker_id), Id: String(movie.maker_id) }];
  }
  const directorName = String(movie.director_name || "").trim();
  if (directorName) {
    item.People.push({
      Name: directorName,
      Type: "Director",
      Id: personIdForName(directorName),
    });
  } else if (movie.director_id) {
    item.People.push({
      Name: String(movie.director_id),
      Type: "Director",
      Id: String(movie.director_id),
    });
  }
  const seriesName = String(movie.series_name || "").trim();
  // 不再写 SeriesName / SeriesId：Emby 客户端详情页会优先用 SeriesName 当大标题，
  // 于是出现“标题只剩系列名”（例如 GVH-385 只显示系列名）的情况。
  // 片名统一走 Name，系列仍放在下面的“类别 / 标签”里，点击照样能按系列名搜到可播放作品。
  // 系列也放进“类别 / 标签”：详情页标签栏里能直接看到系列名，
  // 点了按系列名回源搜索（搜索结果同样只会是可播放作品）。
  if (seriesName && !uniqueTags.includes(seriesName)) {
    uniqueTags.push(seriesName);
    item.Genres = uniqueTags.slice();
    item.Tags = uniqueTags.slice();
    item.GenreItems.push({ Name: seriesName, Id: genreIdForName(seriesName) });
    item.TagItems.push({ Name: seriesName, Id: tagIdForName(seriesName) });
  }

  return item;
}

async function apiToken(token, env) {
  const value = String(token || "").trim();
  if (!value || value === guestToken(env)) {
    return "";
  }
  // 会话查询本身也是一次存储读取，这里缓存一小段时间，避免每个请求都查一遍。
  // 只有“真实 JavDB 会话”的 token 才透传给上游数据接口；
  // “本地信任登录”生成的随机 token 一律不带，避免被 JavDB 当成无效会话拒绝。
  return API_TOKEN_CACHE.fetch(value, async () => {
    const record = await lookupSessionRecord(env, value);
    if (!record || record.trusted === true) {
      return "";
    }
    return value;
  });
}
async function getMovie(id, env, fetchImpl, token = "") {
  const payload = await javdbRequest(
    `/v4/movies/${encodeURIComponent(id)}`,
    env,
    fetchImpl,
    { token: await apiToken(token, env) },
  );
  return movieFromPayload(payload);
}

// 带缓存的影片元数据：详情页、图片、字幕、播放解析都会取同一部影片，
// 缓存后同一部片在一次浏览里只回源一次。
async function getMovieCached(id, env, fetchImpl, token = "") {
  const upstreamToken = await apiToken(token, env);
  const key = `${apiOrigin(env)}|${upstreamToken ? "u" : "g"}|${String(id)}`;
  return MOVIE_CACHE.fetch(key, async () => {
    const shared = await edgeCacheRead(EDGE_NAMESPACE_MOVIE, key);
    if (shared !== undefined) {
      return shared;
    }
    const movie = await getMovie(id, env, fetchImpl, token);
    // 空结果 / 瞬时失败不写共享缓存，避免把“查不到”缓存十分钟。
    if (movie && (movie.id || movie.number)) {
      await edgeCacheWrite(EDGE_NAMESPACE_MOVIE, key, movie, MOVIE_CACHE_TTL_MS / 1000);
    }
    return movie;
  });
}
// ---------- 分类列表排序 ----------
// Emby 客户端浏览分类时可选“按年份/名称/添加时间”排序，并带 SortBy/SortOrder。
// 原先这些参数被忽略，返回的一直是上游“最新上架”顺序，所以客户端里选排序没反应。
// 现在由服务器端把抓到的影片按所选条件排序后再分页返回，排序即可生效。
const NATURAL_ORDER_SORT_KEYS = new Set([
  "DateCreated",
  "DateAdded",
  "CreatedDate",
]);
const DATE_SORT_KEYS = new Set([
  "PremiereDate",
  "ProductionYear",
  "ReleaseDate",
  "Year",
  ...NATURAL_ORDER_SORT_KEYS,
]);
const NAME_SORT_KEYS = new Set([
  "SortName",
  "Name",
  "SeriesSortName",
]);

function buildSortComparators(sortByRaw) {
  const comparators = [];
  for (const rawKey of String(sortByRaw || "").split(",")) {
    const key = String(rawKey || "").trim();
    if (!key) continue;
    if (NAME_SORT_KEYS.has(key)) {
      comparators.push({
        key,
        kind: "name",
        value: (movie) => String(movieDisplayName(movie)).toLowerCase(),
      });
    } else if (DATE_SORT_KEYS.has(key)) {
      comparators.push({
        key,
        kind: "date",
        value: NATURAL_ORDER_SORT_KEYS.has(key)
          ? (movie) => movie?.created_at || movie?.release_date || movie?.released_at || ""
          : (movie) => movie?.release_date || movie?.released_at || "",
      });
    }
  }
  return comparators;
}

// 判断客户端要求的排序是否等于上游自带的“最新上架”顺序；
// 是的话继续用原来的快速分页，不额外抓全量。
function isNaturalCatalogOrder(comparators, sortOrder) {
  if (comparators.length === 0) return true;
  if (sortOrder === "asc") return false;
  return comparators.every((comparator) => NATURAL_ORDER_SORT_KEYS.has(comparator.key));
}

// 服务器端排序：无日期的条目排到最后，早/晚顺序由 SortOrder 决定。
function sortMoviesForClient(movies, comparators, sortOrder) {
  if (!comparators.length) return movies;
  const direction = sortOrder === "asc" ? 1 : -1;
  const sorted = movies.slice();
  sorted.sort((left, right) => {
    for (const comparator of comparators) {
      const leftValue = comparator.value(left);
      const rightValue = comparator.value(right);
      if (comparator.kind === "date") {
        const leftTime = Date.parse(String(leftValue || ""));
        const rightTime = Date.parse(String(rightValue || ""));
        const leftValid = Number.isFinite(leftTime);
        const rightValid = Number.isFinite(rightTime);
        if (leftValid !== rightValid) return leftValid ? -1 : 1;
        if (!leftValid && !rightValid) continue;
        if (leftTime === rightTime) continue;
        return (leftTime < rightTime ? -1 : 1) * direction;
      }
      const compared = String(leftValue).localeCompare(String(rightValue), "zh-CN");
      if (compared !== 0) return compared * direction;
    }
    return 0;
  });
  return sorted;
}

async function getMoviePage(query, env, fetchImpl, token = "") {
  const startIndex = Math.max(0, Number(query.get("StartIndex") || 0));
  const limit = Math.min(
    DEFAULT_PAGE_SIZE,
    Math.max(1, Number(query.get("Limit") || DEFAULT_PAGE_SIZE)),
  );
  const searchTerm = query.get("SearchTerm") || query.get("searchTerm") || "";
  const requestedParentId = query.get("ParentId") || CHINESE_PLAYABLE_LIBRARY_ID;
  const library = LIBRARIES.find((item) => item.id === requestedParentId) ||
    LIBRARIES.find((item) => item.id === CHINESE_PLAYABLE_LIBRARY_ID);
  const parentId = requestedParentId === ROOT_ID ? ROOT_ID : library.id;
  const requiredCount = startIndex + limit;
  const sortOrder = /^asc/i.test(String(query.get("SortOrder") || "")) ? "asc" : "desc";
  const sortBy = String(query.get("SortBy") || "");
  const sortComparators = buildSortComparators(sortBy);
  // 默认“最新上架”顺序走原有快速路径；
  // 一旦客户端明确要求“按年份/名称”等排序，就抓全量后再排序分页，保证排序真的生效。
  const needsFullCatalog = !isNaturalCatalogOrder(sortComparators, sortOrder);
  const upstreamToken = await apiToken(token, env);

  // 同一页数据短时间内直接复用：客户端返回再进、翻页回退、重复请求都不再回源。
  const cacheKey = [
    "movie-page-v1",
    apiOrigin(env),
    upstreamToken ? "u" : "g",
    library.id,
    searchTerm,
    startIndex,
    limit,
    sortOrder,
    sortBy,
    needsFullCatalog ? "full" : "fast",
  ].join("|");

  const page = await cachedListPage(cacheKey, LIST_CACHE_TTL_MS / 1000, () => loadMovieCatalogPage({
    library,
    searchTerm,
    startIndex,
    requiredCount,
    needsFullCatalog,
    sortComparators,
    sortOrder,
    env,
    fetchImpl,
    upstreamToken,
  }));

  return {
    Items: page.movies.map((movie) => mapMovie(
      movie,
      query.requestUrl || "https://localhost/",
      env,
      parentId,
    )),
    TotalRecordCount: page.totalRecordCount,
    StartIndex: startIndex,
  };
}

// 抓取分类/搜索结果（不依赖具体客户端地址，所以可以整块缓存复用）。
// 过滤、去重、排序都基于原始影片对象，映射成 Emby 条目放到每次请求里做。
async function loadMovieCatalogPage(options) {
  const {
    library,
    searchTerm,
    startIndex,
    requiredCount,
    needsFullCatalog,
    sortComparators,
    sortOrder,
    env,
    fetchImpl,
    upstreamToken,
  } = options;

  const matchingMovies = [];
  const seen = new Set();
  const collect = (movies) => {
    for (const movie of movies) {
      if (!library.matches(movie)) continue;
      const key = String(movie.id ?? movie.number ?? "");
      if (key && !seen.has(key)) {
        seen.add(key);
        matchingMovies.push(movie);
      }
    }
  };

  const sourceExhausted = searchTerm
    ? await fetchPagesInParallel({
      maxPages: SEARCH_MAX_SOURCE_PAGES,
      pageSize: SEARCH_SOURCE_PAGE_SIZE,
      needAll: needsFullCatalog,
      enough: () => matchingMovies.length >= requiredCount,
      fetchPage: (page) => javdbRequest("/v2/search", env, fetchImpl, {
        query: {
          q: searchTerm,
          page,
          type: "movie",
          movie_filter_by: library.sourceFilter,
          limit: SEARCH_SOURCE_PAGE_SIZE,
        },
        token: upstreamToken,
      }).then(moviesFromPayload),
      collect,
    })
    : await fetchPagesInParallel({
      maxPages: HOME_MAX_SOURCE_PAGES,
      pageSize: HOME_SOURCE_PAGE_SIZE,
      needAll: needsFullCatalog,
      enough: () => matchingMovies.length >= requiredCount,
      fetchPage: (page) => javdbRequest("/v1/movies/latest", env, fetchImpl, {
        query: {
          page,
          filter_by: library.sourceFilter,
          type: library.sourceType,
          limit: HOME_SOURCE_PAGE_SIZE,
        },
        token: upstreamToken,
      }).then(moviesFromPayload),
      collect,
    });

  const orderedMovies = needsFullCatalog
    ? sortMoviesForClient(matchingMovies, sortComparators, sortOrder)
    : matchingMovies;
  return {
    movies: orderedMovies.slice(startIndex, requiredCount),
    // 已翻到末尾时用真实数量；否则略多报，让客户端能继续往下翻页
    totalRecordCount: sourceExhausted
      ? matchingMovies.length
      : matchingMovies.length + 1,
  };
}
// ================= 演员（Person）相关 =================
// 客户端在影片详情里点演员，通常会先请求“演员”条目（Person），再请求
// “该演员出演的作品”列表。这里把 People 的 Id 编成 person:<演员名>，
// 方便按名字回源 JavDB 搜索；列表只保留“可播放”的作品，与分类规则一致。
const PERSON_ID_PREFIX = "person:";

// person:<演员名> -> 演员名；非 person: 前缀返回 null（当作普通影片 id 处理）
function personNameFromItemId(value) {
  const text = String(value || "");
  if (text.startsWith(PERSON_ID_PREFIX)) {
    return text.slice(PERSON_ID_PREFIX.length) || null;
  }
  return null;
}

function personIdForName(name) {
  return PERSON_ID_PREFIX + name;
}

// ================= 类别 / 标签 / 片商 / 系列 =================
// 详情页里这些字段都做成“点得动”的：Id 统一带前缀，
// 客户端点击后会带 GenreIds / TagIds / StudioIds / SeriesId 回来，
// 服务端凭前缀还原出名字，再像演员一样回源搜索“可播放”的作品。
const GENRE_ID_PREFIX = "genre:";
const TAG_ID_PREFIX = "tag:";
const STUDIO_ID_PREFIX = "studio:";
const SERIES_ID_PREFIX = "series:";
// 本服务自己补的两个通用标签：点它们不按关键词搜，直接浏览对应片库。
const CUSTOM_TAG_CHINESE_SUBTITLE = "中文字幕";
const CUSTOM_TAG_PLAYABLE = "可播放";

function genreIdForName(name) {
  return GENRE_ID_PREFIX + name;
}

function tagIdForName(name) {
  return TAG_ID_PREFIX + name;
}

function studioIdForName(name) {
  return STUDIO_ID_PREFIX + name;
}

function seriesIdForName(name) {
  return SERIES_ID_PREFIX + name;
}

// 把带前缀的 Id 还原成名字；没带前缀就原样返回（兼容客户端直接传名称）。
function nameFromPrefixedId(value) {
  const text = String(value || "").trim();
  for (const prefix of [GENRE_ID_PREFIX, TAG_ID_PREFIX, STUDIO_ID_PREFIX, SERIES_ID_PREFIX]) {
    if (text.startsWith(prefix)) {
      return text.slice(prefix.length).trim();
    }
  }
  return text;
}

function safeDecodeComponent(value) {
  const text = String(value || "");
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// /Items 上带这些参数，说明用户点了“类别 / 标签 / 片商 / 系列”。
const COLLECTION_FILTER_PARAMS = [
  "GenreIds",
  "TagIds",
  "StudioIds",
  "SeriesId",
  "Genres",
  "Tags",
  "Studios",
  "Series",
];

function collectionFilterName(query) {
  for (const param of COLLECTION_FILTER_PARAMS) {
    const raw = query.get(param);
    if (!raw) continue;
    const first = String(raw).split(",")[0].trim();
    if (!first) continue;
    const name = nameFromPrefixedId(first);
    if (name) return name;
  }
  return "";
}

// 演员条目（供客户端打开演员详情页 / 展示演员名）
function personItemDto(id, name, env) {
  return {
    Id: id,
    Name: name,
    ServerId: serverId(env),
    Type: "Person",
    IsFolder: false,
    CanDelete: false,
    CanDownload: false,
    PlayAccess: "None",
    ImageTags: {},
    BackdropImageTags: [],
    Overview: "",
  };
}

// 按关键词回源搜索作品（跨分类汇总、去重后返回）。
// searchTerm 可以是演员名、类别名、标签名、片商名或系列名；
// 传空字符串表示不搜索、直接按“最新上架”浏览（“可播放 / 中文字幕”这类内置标签用）。
async function keywordMoviesPage(query, env, fetchImpl, token, searchTerm, cacheKind) {
  const startIndex = Math.max(0, Number(query.get("StartIndex") || 0));
  const limit = Math.min(
    DEFAULT_PAGE_SIZE,
    Math.max(1, Number(query.get("Limit") || DEFAULT_PAGE_SIZE)),
  );
  const requiredCount = startIndex + limit;
  // 若请求指定了某个分类（ParentId），只在该分类里搜；否则跨四个分类汇总，
  // 因为同一位演员 / 同一个标签的作品可能分散在“中文字幕/有码/无码/欧美”里。
  const requestedParentId = query.get("ParentId") || "";
  const singleLibrary = LIBRARIES.find((lib) => lib.id === requestedParentId) || null;
  const libraryList = singleLibrary ? [singleLibrary] : LIBRARIES;

  // 与分类列表一致：客户端点演员后也可能按“年份/名称/添加时间”排序。
  // 需要排序时就把该演员的作品抓全（各分类都翻到底）再排序分页，
  // 否则排序只会作用在某一页的局部数据上，看起来就是“排序不生效”。
  // 默认“最新上架”顺序才走快速分页，边抓边够当前页就提前返回。
  const sortOrder = /^asc/i.test(String(query.get("SortOrder") || "")) ? "asc" : "desc";
  const sortBy = String(query.get("SortBy") || "");
  const sortComparators = buildSortComparators(sortBy);
  const needsFullCatalog = !isNaturalCatalogOrder(sortComparators, sortOrder);
  const upstreamToken = await apiToken(token, env);

  const cacheKey = [
    `${cacheKind}-page-v1`,
    apiOrigin(env),
    upstreamToken ? "u" : "g",
    searchTerm,
    singleLibrary ? singleLibrary.id : "all",
    startIndex,
    limit,
    sortOrder,
    sortBy,
    needsFullCatalog ? "full" : "fast",
  ].join("|");

  const page = await cachedListPage(cacheKey, LIST_CACHE_TTL_MS / 1000, async () => {
    const matches = [];
    const seen = new Set();
    const libraryByKey = new Map();
    let fullyScanned = true;

    const merge = (library, movies) => {
      for (const movie of movies) {
        const key = String(movie.id ?? movie.number ?? "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        matches.push(movie);
        libraryByKey.set(key, library);
      }
    };

    if (needsFullCatalog) {
      // 需要全量排序：各分类同时抓取，缩短“按年份排序”这类请求的等待。
      const scans = await Promise.all(libraryList.map((library) => scanLibraryMovies(library, {
        searchTerm,
        env,
        fetchImpl,
        upstreamToken,
        needAll: true,
        alreadyCount: 0,
        requiredCount,
      })));
      scans.forEach((scan, index) => {
        merge(libraryList[index], scan.movies);
        if (!scan.exhausted) {
          fullyScanned = false;
        }
      });
    } else {
      for (const library of libraryList) {
        if (matches.length >= requiredCount) break;
        const scan = await scanLibraryMovies(library, {
          searchTerm,
          env,
          fetchImpl,
          upstreamToken,
          needAll: false,
          alreadyCount: matches.length,
          requiredCount,
        });
        merge(library, scan.movies);
        if (!scan.exhausted) {
          fullyScanned = false;
        }
      }
    }

    const orderedMovies = needsFullCatalog
      ? sortMoviesForClient(matches, sortComparators, sortOrder)
      : matches;
    return {
      movies: orderedMovies.slice(startIndex, requiredCount),
      // 已把相关分类都翻到底时用真实数量；否则略多报，让客户端能继续往下翻页
      totalRecordCount: fullyScanned ? matches.length : matches.length + 1,
      // 用数组形式保存，方便写进边缘缓存（Map 没法 JSON 序列化）
      libraryEntries: [...libraryByKey],
    };
  });

  const libraryByKey = page.libraryEntries
    ? new Map(page.libraryEntries)
    : new Map(Object.entries(page.libraryByKey || {}));

  return {
    Items: page.movies.map((movie) => mapMovie(
      movie,
      query.requestUrl || "https://localhost/",
      env,
      libraryByKey.get(String(movie.id ?? movie.number ?? ""))?.id ||
        (singleLibrary ? singleLibrary.id : ""),
    )),
    TotalRecordCount: page.totalRecordCount,
    StartIndex: startIndex,
  };
}

// 点击“类别 / 标签 / 片商 / 系列”后的作品列表：把 Id 还原出的名字当关键词搜。
async function collectionMoviesPage(query, env, fetchImpl, token, name) {
  // “中文字幕 / 可播放”是本服务自己补的标签：不按关键词搜，直接浏览片库。
  if (name === CUSTOM_TAG_CHINESE_SUBTITLE || name === CUSTOM_TAG_PLAYABLE) {
    const browseQuery = new URLSearchParams(query);
    for (const param of COLLECTION_FILTER_PARAMS) {
      browseQuery.delete(param);
    }
    browseQuery.delete("SearchTerm");
    browseQuery.requestUrl = query.requestUrl || "https://localhost/";
    if (name === CUSTOM_TAG_CHINESE_SUBTITLE) {
      browseQuery.set("ParentId", CHINESE_PLAYABLE_LIBRARY_ID);
      return keywordMoviesPage(browseQuery, env, fetchImpl, token, "", "collection-cn");
    }
    // 四个分类里的影片都是“可播放”，去掉分类限制就等于全库浏览。
    browseQuery.delete("ParentId");
    return keywordMoviesPage(browseQuery, env, fetchImpl, token, "", "collection-all");
  }
  return keywordMoviesPage(query, env, fetchImpl, token, name, "collection");
}

// 演员：客户端点演员后带的请求一般是 /Items?PersonIds=person:<名字>&...
async function personMoviesPage(query, env, fetchImpl, token) {
  const personIdValues = [];
  for (const raw of query.getAll("PersonIds")) {
    for (const part of String(raw).split(",")) {
      const trimmed = part.trim();
      if (trimmed) personIdValues.push(trimmed);
    }
  }
  const personNames = personIdValues
    .map((value) => personNameFromItemId(value) || value)
    .filter(Boolean);
  const searchTerm = personNames[0] || "";
  if (!searchTerm) {
    return {
      Items: [],
      TotalRecordCount: 0,
      StartIndex: Math.max(0, Number(query.get("StartIndex") || 0)),
    };
  }
  return keywordMoviesPage(query, env, fetchImpl, token, searchTerm, "person");
}

// 在单个分类里抓取作品：给了关键词就回源搜索，没给关键词就按“最新上架”浏览。
async function scanLibraryMovies(library, options) {
  const {
    searchTerm,
    env,
    fetchImpl,
    upstreamToken,
    needAll,
    alreadyCount,
    requiredCount,
  } = options;
  const movies = [];
  const seen = new Set();
  const byKeyword = Boolean(String(searchTerm || "").trim());
  const exhausted = await fetchPagesInParallel({
    maxPages: byKeyword ? SEARCH_MAX_SOURCE_PAGES : HOME_MAX_SOURCE_PAGES,
    pageSize: byKeyword ? SEARCH_SOURCE_PAGE_SIZE : HOME_SOURCE_PAGE_SIZE,
    needAll,
    enough: () => alreadyCount + movies.length >= requiredCount,
    fetchPage: (page) => (byKeyword
      ? javdbRequest("/v2/search", env, fetchImpl, {
        query: {
          q: searchTerm,
          page,
          type: "movie",
          movie_filter_by: library.sourceFilter,
          limit: SEARCH_SOURCE_PAGE_SIZE,
        },
        token: upstreamToken,
      })
      : javdbRequest("/v1/movies/latest", env, fetchImpl, {
        query: {
          page,
          filter_by: library.sourceFilter,
          type: library.sourceType,
          limit: HOME_SOURCE_PAGE_SIZE,
        },
        token: upstreamToken,
      })
    ).then(moviesFromPayload),
    collect: (pageMovies) => {
      for (const movie of pageMovies) {
        if (!library.matches(movie)) continue;
        const key = String(movie.id ?? movie.number ?? "");
        if (key && !seen.has(key)) {
          seen.add(key);
          movies.push(movie);
        }
      }
    },
  });
  return { movies, exhausted };
}
async function resolveVideo(movie, env, fetchImpl) {
  const code = movieNumber(movie) || movie.id || movie.title;
  if (!code) {
    return null;
  }

  const payload = await resolverJson(
    `${resolverResolvePath(env)}?code=${encodeURIComponent(code)}&lang=zh`,
    env,
    fetchImpl,
  );
  const variants = sourceVariants(payload)
    .flatMap((item) => {
      const rawSource = sourceUrlValue(item);
      const sourceUrl = safeMediaUrl(rawSource, env);
      const inlinePlaylist = sourceUrl ? null : decodeInlineHls(rawSource);
      if (!sourceUrl && !inlinePlaylist) {
        return [];
      }
      return [{
        sourceUrl: sourceUrl?.toString() || "",
        sourceType: inlinePlaylist
          ? "application/vnd.apple.mpegurl"
          : item.sourceType || item.source_type || item.mimeType ||
            item.mime_type || "video/mp4",
        inlinePlaylist,
        variant: item.variant || item.name || item.id,
        title: movieDisplayName(movie) || code,
        quality: Number(item.quality || item.height || 0),
      }];
    });
  const variant =
    variants.find((item) => item.variant === "original") || variants[0] || null;
  if (!variant) {
    return null;
  }
  const orderedVariants = [variant, ...variants.filter((item) => item !== variant)];
  if (orderedVariants.length > 1) {
    orderedVariants.forEach((item, index) => {
      item.sourceName = videoVariantLabel(item, index, orderedVariants.length);
    });
  }

  return {
    ...variant,
    alternates: orderedVariants.slice(1),
  };
}

function subtitleCodec(subtitle) {
  const value = String(subtitle?.ext || "srt").toLowerCase();
  return /^[a-z0-9]+$/.test(value) ? value : "srt";
}

async function resolveSubtitles(movie, env, fetchImpl) {
  const code = movieNumber(movie) || movie.id || movie.title;
  if (!code) {
    return [];
  }

  const payload = await upstreamJson(
    `/api/subtitle?name=${encodeURIComponent(code)}`,
    env,
    fetchImpl,
  );
  if (payload?.code !== undefined && Number(payload.code) !== 0) {
    return [];
  }

  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const subtitles = [];
  const seen = new Set();
  for (const subtitle of rows) {
    if (subtitles.length >= 8) {
      break;
    }
    const value = String(subtitle?.url || "");
    let url;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      continue;
    }

    const id = String(subtitle.cid || subtitle.gcid || value);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    subtitles.push({
      id,
      url: url.toString(),
      codec: subtitleCodec(subtitle),
    });
  }
  // 字幕标题不再显示上传者（如“网友上传”），统一改成“字幕 1、字幕 2…”这类序号
  return subtitles.map((subtitle, index) => ({
    ...subtitle,
    title: `字幕 ${index + 1}`,
  }));
}

// 播放源 / 字幕解析结果缓存：解析服务冷启动很慢，缓存后再次点开、详情页预解析、
// 正式起播之间可以互相复用同一份结果，起播会明显更快。
function movieResolveCode(movie) {
  return String(movieNumber(movie) || movie?.id || movie?.title || "");
}

async function resolveVideoCached(movie, env, fetchImpl) {
  const code = movieResolveCode(movie);
  if (!code) {
    return resolveVideo(movie, env, fetchImpl);
  }
  const key = `${resolverOrigin(env)}${resolverResolvePath(env)}|${RESOLVE_VIDEO_CACHE_VERSION}|${code}`;
  return RESOLVE_VIDEO_CACHE.fetch(key, async () => {
    const shared = await edgeCacheRead(EDGE_NAMESPACE_VIDEO, key);
    if (shared !== undefined) {
      return shared;
    }
    const video = await resolveVideo(movie, env, fetchImpl);
    if (video) {
      await edgeCacheWrite(EDGE_NAMESPACE_VIDEO, key, video, RESOLVE_CACHE_TTL_MS / 1000);
    }
    return video;
  });
}

async function resolveSubtitlesCached(movie, env, fetchImpl) {
  const code = movieResolveCode(movie);
  if (!code) {
    return resolveSubtitles(movie, env, fetchImpl);
  }
  const key = `${upstreamOrigin(env)}|${code}`;
  return RESOLVE_SUBTITLE_CACHE.fetch(key, async () => {
    const shared = await edgeCacheRead(EDGE_NAMESPACE_SUBTITLE, key);
    if (shared !== undefined) {
      return shared;
    }
    const subtitles = await resolveSubtitles(movie, env, fetchImpl);
    // 空结果同样缓存:能确定“这部片没有字幕”,下次不用再等一次冷启动回源。
    if (Array.isArray(subtitles)) {
      await edgeCacheWrite(EDGE_NAMESPACE_SUBTITLE, key, subtitles, RESOLVE_CACHE_TTL_MS / 1000);
    }
    return subtitles;
  });
}
// 丢掉一部影片的“播放源解析”缓存（内存 + 边缘），下次点开会重新解析。
function forgetResolveVideoCache(movie, env) {
  const code = movieResolveCode(movie);
  if (!code) {
    return;
  }
  const key = `${resolverOrigin(env)}${resolverResolvePath(env)}|${RESOLVE_VIDEO_CACHE_VERSION}|${code}`;
  RESOLVE_VIDEO_CACHE.forget(key);
  forgetEdgeCache(EDGE_NAMESPACE_VIDEO, key);
}

// ---------- 字幕加速 ----------
// 1) 字幕流令牌:mediaSource 生成字幕流时把真实字幕地址登记下来,DeliveryUrl 上带一个 sid。
//    客户端取字幕时凭 sid 直接命中,不用再回源解析一遍字幕列表(字幕列表冷启动约 1.5s)。
// 2) 字幕文件优先直连字幕 CDN(实测 150-400ms),直连失败才回退上游代下接口(冷启动约 2.5s)。
// 3) 取回的字幕字节按地址缓存,二次起播 / 拖动进度条直接命中,不再等第二次回源。
const SUBTITLE_STREAM_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SUBTITLE_STREAM_TOKENS = 4000;
const MAX_SUBTITLE_BODY_CACHE_ENTRIES = 200;
const SUBTITLE_FETCH_TIMEOUT_MS = 8000;

function createTtlMap(ttlMs, maxEntries) {
  const entries = new Map();
  const read = (key) => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  };
  const write = (key, value) => {
    entries.set(key, { value, expires: Date.now() + ttlMs });
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  };
  return { read, write, forget: (key) => entries.delete(key) };
}

const SUBTITLE_STREAM_TOKENS = createTtlMap(SUBTITLE_STREAM_TTL_MS, MAX_SUBTITLE_STREAM_TOKENS);
const SUBTITLE_BODY_CACHE = createTtlMap(SUBTITLE_STREAM_TTL_MS, MAX_SUBTITLE_BODY_CACHE_ENTRIES);

function subtitleStreamCodec(subtitle) {
  return subtitle?.codec || subtitleCodec(subtitle);
}

// 登记一条件字幕并返回 sid:内容为 { itemId, url, codec, title }
function subtitleStreamToken(itemId, subtitle, index) {
  const token = md5(`${itemId}|${index}|${subtitle.url}|${subtitle.codec}`);
  SUBTITLE_STREAM_TOKENS.write(token, {
    itemId: String(itemId),
    url: subtitle.url,
    codec: subtitle.codec,
    title: subtitle.title,
  });
  return token;
}

// 凭 sid 取回登记过的字幕;令牌过期或换实例时返回 null,调用方按序号重新解析。
function subtitleFromToken(sid, itemId) {
  const entry = SUBTITLE_STREAM_TOKENS.read(String(sid || ""));
  if (!entry) return null;
  if (itemId && String(entry.itemId) !== String(itemId)) return null;
  return entry;
}

// 先直连字幕 CDN,失败再回退上游代下接口。
async function fetchSubtitleBody(subtitle, env, fetchImpl) {
  const direct = await fetchSubtitleBytes(subtitle.url, fetchImpl);
  if (direct) return direct;
  const target = new URL("/api/subtitle/file", upstreamOrigin(env));
  target.searchParams.set("url", subtitle.url);
  return fetchSubtitleBytes(target.toString(), fetchImpl);
}

// 判断一段文本是否像字幕(SRT / VTT / ASS),避免把上游的 JSON 错误体当成字幕。
function looksLikeSubtitleText(text) {
  const head = String(text || "").slice(0, 4096);
  return head.includes("-->") || /^\uFEFF?WEBVTT/i.test(head) ||
    head.includes("[Script Info]") || head.includes("[Events]");
}

async function fetchSubtitleBytes(url, fetchImpl) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), SUBTITLE_FETCH_TIMEOUT_MS);
  });
  const task = (async () => {
    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: "text/vtt,application/x-subrip,text/plain,*/*;q=0.8",
          referer: "https://www.javdb.com/",
          "user-agent": "Mozilla/5.0",
        },
        redirect: "follow",
      });
      if (!response || !response.ok || response.status === 204) {
        return null;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) {
        return null;
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (!looksLikeSubtitleText(text)) {
        return null;
      }
      return { bytes, contentType: response.headers.get("content-type") || "" };
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// 字幕字节的内存缓存:字幕文件很小,缓存后同一条字幕不再回源。
async function cachedSubtitleBody(subtitle, env, fetchImpl) {
  const key = md5(`${upstreamOrigin(env)}|${subtitle.url}|${subtitleStreamCodec(subtitle)}`);
  const cached = SUBTITLE_BODY_CACHE.read(key);
  if (cached) return cached;
  const result = await fetchSubtitleBody(subtitle, env, fetchImpl);
  if (result && result.bytes) {
    SUBTITLE_BODY_CACHE.write(key, result);
  }
  return result;
}

function mediaSource(item, requestUrl, token, video, subtitles = [], sourceId = item.Id) {
  const isHls = /mpegurl|m3u8/i.test(video.sourceType || video.sourceUrl);
  // ===== 媒体信息 STRM 化（旧逻辑以注释保留，便于恢复）=====
  // 旧版：容器提示是 HLS / M3U8，客户端媒体信息里会显示 “HLS / M3U8”：
  //   旧代码：const container = isHls ? "hls" : "mp4";
  // 新版：统一改成 STRM 提示，让客户端把每条资源当成一个 .strm 远程文件。
  // 真实播放地址仍是下方 streamExtension 生成的 .m3u8 / .mp4（未改动），播放不受影响。
  const container = "strm";
  // 实际播放/下载地址的后缀仍用 .m3u8 / .mp4，保持真实文件类型。
  const streamExtension = isHls ? "m3u8" : "mp4";
  const mediaSourceId = String(sourceId || item.Id);
  const height = Number(video.quality || 0);
  const width = height > 0 ? Math.round((height * 16) / 9 / 2) * 2 : undefined;
  const buildStreamUrl = (extension) => {
    const url = new URL(
      publicRoutePath(
        requestUrl,
        `/Videos/${encodeURIComponent(item.Id)}/stream.${extension}`,
      ),
      requestUrl,
    );
    url.searchParams.set("api_key", token);
    url.searchParams.set("static", "true");
    url.searchParams.set("mediaSourceId", mediaSourceId);
    if (video.sourceUrl) {
      url.searchParams.set("source", video.sourceUrl);
      url.searchParams.set("sourceType", video.sourceType || "video/mp4");
    }
    return url;
  };
  // 真正播放用的地址：后缀仍是 .mp4 / .m3u8，播放器靠它判断文件类型。
  const streamUrl = buildStreamUrl(streamExtension);
  // 展示用的地址：非 HLS 时后缀改成 .strm，客户端“媒体信息”读这个字段，
  // 不会再出现 mp4 提示。HLS 保持 .m3u8（本来就没有 mp4 字样，避免影响播放引擎判断）。
  const displayUrl = buildStreamUrl(isHls ? streamExtension : container);
  const subtitleStreams = subtitles.map((subtitle, index) => {
    const streamIndex = index + 2;
    const deliveryUrl = new URL(
      publicRoutePath(
        requestUrl,
        `/Videos/${encodeURIComponent(item.Id)}/${encodeURIComponent(item.Id)}/Subtitles/${streamIndex}/Stream.${subtitle.codec}`,
      ),
      requestUrl,
    );
    deliveryUrl.searchParams.set("api_key", token);
    // 带上字幕令牌:客户端取字幕时凭它直接拿到真实地址,不用再解析一次字幕列表。
    deliveryUrl.searchParams.set("sid", subtitleStreamToken(item.Id, subtitle, index));
    return {
      Type: "Subtitle",
      Codec: subtitle.codec,
      Language: "chi",
      DisplayLanguage: "中文",
      Title: subtitle.title,
      DisplayTitle: subtitle.title,
      Index: streamIndex,
      IsDefault: index === 0,
      IsForced: false,
      IsExternal: true,
      IsExternalUrl: false,
      IsTextSubtitleStream: true,
      SupportsExternalStream: true,
      DeliveryMethod: "External",
      DeliveryUrl: `${deliveryUrl.pathname}${deliveryUrl.search}`,
    };
  });
  return {
    Id: mediaSourceId,
    Name: String(video.sourceName || video.title || item.Name || "").trim() || item.Name || "",
    Path: displayUrl.toString(),
    DirectStreamUrl: `${streamUrl.pathname}${streamUrl.search}`,
    Protocol: "Http",
    Type: "Default",
    Container: container,
    VideoType: "VideoFile",
    IsRemote: true,
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: false,
    SupportsProbing: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiredHttpHeaders: {},
    RunTimeTicks: item.RunTimeTicks,
    DefaultAudioStreamIndex: 1,
    DefaultSubtitleStreamIndex: subtitleStreams[0]?.Index,
    MediaStreams: [
      // Emby 客户端会依据 MediaStreams 判断媒体源是否完整。这里保留最小化的
      // 视频轨和音频轨结构，但不下发编码/码率等详细媒体信息；容器仍显示 STRM。
      {
        Type: "Video",
        IsDefault: true,
        IsForced: false,
        IsExternal: false,
        Index: 0,
        Width: width,
        Height: height || undefined,
      },
      {
        Type: "Audio",
        IsDefault: true,
        IsForced: false,
        IsExternal: false,
        Index: 1,
      },
      ...subtitleStreams,
    ],
  };
}

function playbackVariants(video) {
  const list = [];
  if (video && typeof video === "object") {
    list.push(video);
  }
  if (Array.isArray(video?.alternates)) {
    list.push(...video.alternates);
  }
  const seen = new Set();
  return list.filter((variant) => {
    if (!variant || typeof variant !== "object") return false;
    const sourceKey = String(variant.sourceUrl || variant.inlinePlaylist || "");
    const key = [sourceKey, variant.variant || "", variant.sourceType || ""].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mediaSourceIdForIndex(itemId, index) {
  const base = String(itemId || "");
  return index <= 0 ? base : base + "-" + String(index + 1);
}

function mediaSourceVariantIndex(itemId, mediaSourceId) {
  const base = String(itemId || "");
  const value = String(mediaSourceId || "").trim();
  if (!value || value === base) return 0;
  const prefix = base + "-";
  if (!value.startsWith(prefix)) return -1;
  const number = Number(value.slice(prefix.length));
  return Number.isInteger(number) && number > 1 ? number - 1 : -1;
}

function selectedPlaybackVideo(video, itemId, requestUrl) {
  const variants = playbackVariants(video);
  if (variants.length <= 1) return video;
  const requestedIndex = mediaSourceVariantIndex(
    itemId,
    requestUrl.searchParams.get("mediaSourceId"),
  );
  if (requestedIndex <= 0 || requestedIndex >= variants.length) return video;
  const selected = variants[requestedIndex];
  return {
    ...selected,
    alternates: variants.filter((item, index) => index !== requestedIndex),
  };
}

function mediaSourcesForVideo(item, requestUrl, token, video, subtitles = []) {
  const variants = playbackVariants(video);
  return variants.map((variant, index) =>
    mediaSource(
      item,
      requestUrl,
      token,
      {
        ...variant,
        sourceName: variant.sourceName ||
          (variants.length > 1 ? videoVariantLabel(variant, index, variants.length) : ""),
      },
      subtitles,
      mediaSourceIdForIndex(item.Id, index),
    ));
}

function authenticationResponse(request, env, user, token) {
  const sessionId = crypto.randomUUID();
  return jsonResponse({
    User: user,
    SessionInfo: {
      Id: sessionId,
      UserId: USER_ID,
      UserName: user.Name,
      ServerId: serverId(env),
      Client: "Emby Compatible",
      DeviceName: "Emby Client",
      DeviceId: "bbjavdb-emby",
      ApplicationVersion: "1.0.0",
      RemoteEndPoint: new URL(request.url).hostname,
      PlayState: {},
      AdditionalUsers: [],
    },
    AccessToken: token,
    ServerId: serverId(env),
  });
}

async function authenticate(request, env, fetchImpl) {
  let input = {};
  try {
    input = await request.clone().json();
  } catch {
    try {
      const form = await request.clone().formData();
      input = Object.fromEntries(form.entries());
    } catch {
      input = {};
    }
  }

  const url = new URL(request.url);
  const username = String(input.Username || input.username || url.searchParams.get("username") || "").trim();
  const password = String(input.Pw || input.Password || input.password || url.searchParams.get("password") || "");

  // 没填用户名：只有显式开启“访客/免登录”（EMBY_GUEST_ACCESS=true）才放行，
  // 否则必须输入账号密码登录
  if (!username) {
    if (guestAccessEnabled(env)) {
      return authenticationResponse(
        request,
        env,
        virtualUser(env),
        guestToken(env),
      );
    }
    return errorResponse(401, "请输入用户名和密码");
  }

  // 必须输入密码才能登录
  if (!password) {
    return errorResponse(401, "请输入密码");
  }

  // 默认“本地信任登录”：不向 JavDB 验证账号密码，用户名可任意填写。
  // 密码校验：
  // 1) 若配置了固定密码 EMBY_LOGIN_PASSWORD，则登录必须使用该密码；
  // 2) 未配置时记住每个用户名“首次登录”使用的密码，之后同一用户名
  //    必须用相同密码登录，否则提示“密码不正确”。
  // 客户端显示的名称就是登录时输入的用户名，播放记录按用户名独立分桶。
  if (!realJavdbLoginEnabled(env)) {
    const expectedPassword = loginPassword(env);
    if (expectedPassword) {
      if (password !== expectedPassword) {
        return errorResponse(401, "密码不正确");
      }
    } else {
      // 没有固定密码时，记住该用户名首次登录使用的密码。
      const storedPassword = await readStoredLoginPassword(env, username);
      if (storedPassword) {
        if (password !== storedPassword) {
          return errorResponse(401, "密码不正确");
        }
      } else {
        await storeStoredLoginPassword(env, username, password);
      }
    }
    const token = crypto.randomUUID();
    await storeSessionUser(env, token, username, requestDeviceId(request), { trusted: true });
    return authenticationResponse(request, env, virtualUser(env, username, true), token);
  }

  // 可选：EMBY_REAL_JAVDB_LOGIN=true 时，仍按真实 JavDB 账号验证（原逻辑）
  const form = new FormData();
  form.set("username", username);
  form.set("password", password);
  form.set("device_uuid", "emby");
  form.set("device_name", "Emby Client");
  form.set("device_model", "Emby Compatible");
  form.set("platform", "android");
  form.set("system_version", "Emby Compatible");
  form.set("app_channel", "official");
  form.set("app_version", "emby-bridge");
  form.set("app_version_number", "1.0.0");

  try {
    const data = await javdbRequest("/v1/sessions", env, fetchImpl, {
      method: "POST",
      body: form,
    });
    const token = String(data?.token || "");
    if (!token) {
      return errorResponse(401, "JavDB authentication failed");
    }

    const accountName = String(data?.user?.username || username || "").trim();
    await storeSessionUser(env, token, accountName, requestDeviceId(request));

    return authenticationResponse(request, env, virtualUser(env, accountName, true), token);
  } catch (error) {
    return errorResponse(401, error instanceof Error ? error.message : "JavDB authentication failed");
  }
}

function systemInfo(requestUrl, env) {
  return {
    LocalAddress: new URL(requestUrl).origin,
    ServerName: PRODUCT_NAME,
    Version: "1.0.0",
    ProductName: "Emby Compatible Server",
    Id: serverId(env),
    OperatingSystem: "Cloudflare Workers",
    StartupWizardCompleted: true,
    SupportsLibraryMonitor: false,
  };
}

function rootItem(env) {
  return {
    Name: PRODUCT_NAME,
    SortName: PRODUCT_NAME,
    ServerId: serverId(env),
    Id: ROOT_ID,
    Guid: ROOT_ID,
    Type: "Folder",
    ChildCount: LIBRARIES.length,
    DisplayPreferencesId: "usersettings",
    IsFolder: true,
    LocationType: "Virtual",
    ImageTags: {},
    UserData: {
      Played: false,
      PlayCount: 0,
      IsFavorite: false,
      PlaybackPositionTicks: 0,
    },
  };
}

function libraryView(library, env) {
  return {
    Name: library.name,
    SortName: library.name,
    ServerId: serverId(env),
    ParentId: ROOT_ID,
    Id: library.id,
    Guid: library.id,
    Type: "CollectionFolder",
    CollectionType: "movies",
    ChildCount: 1000,
    DisplayPreferencesId: `usersettings-${library.id}`,
    IsFolder: true,
    LocationType: "Virtual",
    ImageTags: {},
    UserData: {
      Played: false,
      PlayCount: 0,
      IsFavorite: false,
      PlaybackPositionTicks: 0,
    },
  };
}

function virtualFolder(library) {
  return {
    Name: library.name,
    Locations: [],
    CollectionType: "movies",
    ItemId: library.id,
    Id: library.id,
    Guid: library.id,
  };
}

// 详情页“顺带解析播放源”的预算：超过就先返回元数据（真正播放时再完整解析）。
// 这份预算只约束播放源解析本身——字幕不再计入（见 itemResponse），
// 否则字幕稍慢就会把已经解析好的播放源一起丢掉，客户端详情页只能看到一条占位源。
const ITEM_DETAIL_RESOLVE_BUDGET_MS = 3000;
// 起播(/PlaybackInfo)时客户端马上就要播放,字幕流必须跟着这次响应一起下发,
// 否则会出现“视频已经播了、字幕还在加载”。这里比详情页多给一点时间。
const PLAYBACK_INFO_RESOLVE_BUDGET_MS = 3500;

// 后台预热:不阻塞当前响应,把播放源与字幕列表解析完写进缓存,
// 下次(真正点播放时)直接命中,起播和字幕出现都更快。
function prewarmResolve(movie, env, fetchImpl, ctx = null) {
  if (!movie?.id && !movie?.number) return;
  // 播放源与字幕并行解析,不要在后台排队等两次冷启动。
  const task = Promise.all([
    resolveVideoCached(movie, env, fetchImpl).catch(() => {}),
    resolveSubtitlesCached(movie, env, fetchImpl).catch(() => {}),
  ]);
  // Worker 响应返回后后台任务可能被直接杀掉:有 ctx.waitUntil 就登记上,
  // 让预解析真正跑完,下次点播放时字幕能直接命中缓存。
  keepAlive(task, ctx);
}

// 把后台任务登记到响应生命周期上:Worker 返回响应后可能被立刻回收,
// 只有 ctx.waitUntil 才能真正跑完并写进缓存。
function keepAlive(task, ctx) {
  try {
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task);
    }
  } catch {
    // 忽略:登记失败不影响本次响应。
  }
}

// 只查缓存、不触发回源:起播解析超时时,如果字幕之前已经预解析过,
// 仍然把字幕流一起下发,避免“视频已经播了字幕还没出来”。
function subtitleCacheKey(movie, env) {
  const code = movieResolveCode(movie);
  return code ? upstreamOrigin(env) + "|" + code : "";
}

async function peekCachedSubtitles(movie, env) {
  const key = subtitleCacheKey(movie, env);
  if (!key) return [];
  const memory = RESOLVE_SUBTITLE_CACHE.read(key);
  if (Array.isArray(memory)) return memory;
  try {
    const shared = await edgeCacheRead(EDGE_NAMESPACE_SUBTITLE, key);
    if (Array.isArray(shared)) return shared;
  } catch {
    // 边缘缓存读失败就按“暂时没有字幕”处理,不能拖慢响应。
  }
  return [];
}

function withTimeout(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("resolve timed out")), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// 带“已完成状态”的包装:整体超时时可以取回已经解析完的那部分结果,
// 而不是把已经拿到的播放源一起丢掉。
function trackResolution(promise) {
  const record = { done: false, value: undefined };
  const tracked = promise.then(
    (value) => {
      record.done = true;
      record.value = value;
      return value;
    },
    () => {
      record.done = true;
      record.value = undefined;
      return undefined;
    },
  );
  return { tracked, record };
}

async function itemResponse(id, request, env, fetchImpl, token, ctx = null) {
  // 演员条目：Id 为 person:<演员名> 时直接返回 Person 对象，不当作影片回源。
  const personNameFromId = personNameFromItemId(id);
  if (personNameFromId) {
    return jsonResponse(personItemDto(id, personNameFromId, env));
  }
  const movie = await getMovieCached(id, env, fetchImpl, token);
  if (!movie?.id && !movie?.number) {
    return errorResponse(404, "Movie not found");
  }

  const item = mapMovie(movie, request.url, env);
  attachPlaybackUserData(item, await readPlaybackState(env, token));

  // 详情页不应被“解析播放源/字幕”这类慢请求拖住：解析服务首次冷启动时
  // 会明显变慢（第二次通常命中缓存才快），旧逻辑在返回详情前一直等它，
  // 导致第一次点开影片详情时客户端长时间转圈。
  // 现在给播放源一份单独预算（超时先返回元数据，等点播放时由 /PlaybackInfo
  // 完整解析），字幕完全不参与这份预算。
  let video = null;
  let subtitles = [];
  let resolutionFinished = false;
  // 播放源与字幕彻底分开：
  // 旧写法把两者塞进同一个 Promise.all 再整体超时，字幕稍慢（冷启动约 1.5s）
  // 就会连已经解析好的播放源一起丢掉，只回退成 1 条占位源，
  // 客户端详情页因此只显示一个播放源。
  // 现在播放源单独用一份预算（能拿全所有播放源）；字幕永不阻塞详情页——
  // 先读缓存，没命中就后台预热，真正起播时由 /PlaybackInfo 随流下发。
  try {
    video = await withTimeout(
      resolveVideoCached(movie, env, fetchImpl),
      ITEM_DETAIL_RESOLVE_BUDGET_MS,
    );
    resolutionFinished = true;
  } catch {
    video = null;
    // 预算内没解析完:放进后台继续解析(内部会合并重复请求并写进缓存),
    // 用户真正点播放时 /PlaybackInfo 就能直接命中,不用再从冷启动等一次。
    prewarmResolve(movie, env, fetchImpl, ctx);
  }
  // 字幕只取缓存:已经预解析过的就直接带上,不再白等。
  subtitles = await peekCachedSubtitles(movie, env);
  if (resolutionFinished && !subtitles.length) {
    // 播放源已在预算内返回:后台把字幕也解析好缓存起来,不占用本次响应时间。
    keepAlive(resolveSubtitlesCached(movie, env, fetchImpl).catch(() => []), ctx);
  }

  const playbackToken = token || (guestAccessEnabled(env) ? guestToken(env) : "");

  if (!video) {
    if (resolutionFinished) {
      // 解析已完成但确实没有可播放源：明确标成不可播放，避免客户端去请求播放。
      item.PlayAccess = "None";
      item.MediaSources = [];
      item.MediaStreams = [];
      item.MediaSourceCount = 0;
      item.HasSubtitles = false;
      return jsonResponse(item);
    }
    // 解析超时/未在预算内完成：仍返回一条占位媒体源，保证客户端显示“播放”按钮。
    // 该占位地址只是入口，真正播放时会由 /PlaybackInfo 与 /Videos/{id}/stream
    // 重新完整解析出真实播放地址，因此不影响实际播放。
    const placeholders = mediaSourcesForVideo(
      item,
      request.url,
      playbackToken,
      { title: item.Name, sourceType: "video/mp4" },
      subtitles,
    );
    const placeholder = placeholders[0];
    item.Path = placeholder.Path;
    item.MediaSources = placeholders;
    item.MediaStreams = placeholder.MediaStreams;
    item.MediaSourceCount = placeholders.length;
    item.Container = placeholder.Container;
    item.HasSubtitles = subtitles.length > 0;
    return jsonResponse(item);
  }
  const mediaSources = mediaSourcesForVideo(
    item,
    request.url,
    playbackToken,
    video,
    subtitles,
  );
  const source = mediaSources[0];
  item.Path = source.Path;
  item.MediaSources = mediaSources;
  item.MediaStreams = source.MediaStreams;
  item.MediaSourceCount = mediaSources.length;
  item.Container = source.Container;
  item.HasSubtitles = subtitles.length > 0;
  return jsonResponse(item);
}

function itemQuery(items, startIndex = 0) {
  return {
    Items: items,
    TotalRecordCount: items.length,
    StartIndex: startIndex,
  };
}

function emptyItemQuery() {
  return itemQuery([]);
}

function displayPreferences(url) {
  return {
    Id: "usersettings",
    UserId: url.searchParams.get("UserId") || USER_ID,
    Client: url.searchParams.get("Client") || "emby",
    Configuration: {
      homesection0: "latestmedia",
      homesection1: "resume",
      homesection2: "none",
      homesection3: "none",
      homesection4: "none",
      homesection5: "none",
    },
    CustomPrefs: {},
  };
}

function noContentResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}
const PLAYBACK_STATE_KEY = "playback-state-v1";
const PLAYBACK_MAX_RESUME_ITEMS = 30;
// 进度距片尾不足 2 分钟也视为“已看完”：部分客户端在结尾前几秒/一两分钟退出时
// 不会上报 PlayedToCompletion，若仍按“没看完”处理会残留进度条并出现在“继续播放”里。
const PLAYBACK_FINISH_TAIL_TICKS = 120 * 10_000_000;
// 移除播放记录后的“抑制期”：客户端常在移除后不久又补发一次旧的进度/停止
// 上报，把刚删掉的条目又写回“继续观看”。这段时间内忽略该条目的残留上报。
// 抑制信息放在独立的“墓碑”key 里（见下），所以迟到的整份覆盖也冲不掉它。
// 抑制期要够长：客户端补发残留上报的时间点很不固定（重开 App、切后台回来…）。
// 真的重播另有出口（开始播放事件 / 进度明显往前播），不会因为抑制期长就记不上。
const PLAYBACK_DELETE_SUPPRESS_MS = 2 * 60 * 60 * 1000;
// 墓碑保留 30 天：脏写回把老记录带回来时，读取阶段也能按时间戳剪掉。
const PLAYBACK_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PLAYBACK_MAX_TOMBSTONES = 300;
// 同一实例内墓碑的短时缓存：进度上报很频繁，避免每次都多读一次 KV。
const PLAYBACK_TOMBSTONE_CACHE_MS = 5 * 1000;

// 播放记录的后备存储：
// - 优先用 KV 命名空间（PLAYBACK_KV）跨请求长期保存；
// - 即使没配置 KV，也会在内存里记一份，保证同一实例内“进度/已播”立刻生效。
const MAX_MEMORY_PLAYBACK_STATES = 500;

function playbackKv(env) {
  const kv = env && env.PLAYBACK_KV;
  return kv && typeof kv.get === "function" && typeof kv.put === "function" ? kv : null;
}

// —— 零配置持久化兜底 ——
// 不少部署是把这份代码直接粘进 Cloudflare，并没有在设置里绑定 PLAYBACK_KV。
// 那种情况下播放记录只能留在某个 Worker 实例的内存里：实例一被回收，
// “移除播放记录”就等于没做——刷新后条目又被迟到的旧上报带回来。
// Workers 自带的 Cache API（caches.default）不需要任何绑定，同一机房里的实例共享，
// 所以拿它当 KV 缺席时的备用存储，删除才真的留得住。
// 存进边缘缓存的两类数据：
//   playback  —— 播放进度 / 已播 / 收藏等播放状态；
//   tombstone —— “已移除”墓碑（比状态更关键：它负责挡住迟到的脏写回）。
const EDGE_NAMESPACE_PLAYBACK = "playback";
const EDGE_NAMESPACE_TOMBSTONE = "tombstone";
const PLAYBACK_CACHE_TTL_S = 30 * 24 * 60 * 60;

// 统一入口：优先 KV（绑定了就跨机房长期保存），没绑定时退到边缘缓存。
async function durableJsonRead(env, namespace, key) {
  const kv = playbackKv(env);
  if (kv) {
    try {
      const value = await kv.get(key, "json");
      if (value !== null && value !== undefined) {
        return value;
      }
      // KV 明确回答“没有”：不再往下看边缘缓存，免得拿到迁移前的过期副本。
      return null;
    } catch (error) {
      console.error(JSON.stringify({
        message: "Playback store read failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      // 读失败：调用方保留内存里的旧副本。
      return undefined;
    }
  }
  // 没有 KV 绑定：退到 Workers 自带的 Cache API（同样不需要任何配置）。
  const store = edgeCacheStore();
  const cacheKey = store ? edgeCacheRequest(namespace, key) : null;
  if (!store || !cacheKey) {
    // 连 Cache API 都没有（例如本机 Node 环境）：交回调用方走内存兜底。
    return undefined;
  }
  try {
    const hit = await store.match(cacheKey);
    if (!hit) {
      return null;
    }
    const value = await hit.json();
    return value === undefined ? null : value;
  } catch {
    return undefined;
  }
}

async function durableJsonWrite(env, namespace, key, value) {
  const kv = playbackKv(env);
  if (kv) {
    try {
      await kv.put(key, JSON.stringify(value));
      return;
    } catch (error) {
      console.error(JSON.stringify({
        message: "Playback store write failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  await edgeCacheWrite(namespace, key, value, PLAYBACK_CACHE_TTL_S);
}

const MEMORY_PLAYBACK_STATES = new Map();

function rememberPlaybackState(key, state) {
  try {
    MEMORY_PLAYBACK_STATES.set(key, state || {});
    if (MEMORY_PLAYBACK_STATES.size > MAX_MEMORY_PLAYBACK_STATES) {
      const oldestKey = MEMORY_PLAYBACK_STATES.keys().next().value;
      if (oldestKey !== undefined) {
        MEMORY_PLAYBACK_STATES.delete(oldestKey);
      }
    }
  } catch {
    // 内存兜底失败不能影响主流程
  }
}

function playbackTokenPart(token) {
  return md5(String(token || "").trim());
}

const SESSION_USER_KEY_PREFIX = "session-user:v1:";

function sessionUserKey(token) {
  return `${SESSION_USER_KEY_PREFIX}${playbackTokenPart(token)}`;
}

async function storeSessionUser(env, token, username, deviceId = "", extra = {}) {
  const kv = playbackKv(env);
  if (!kv || !token || !username) return;
  try {
    const record = { username: String(username), at: Date.now() };
    if (deviceId) {
      record.deviceId = String(deviceId);
    }
    if (extra && extra.trusted) {
      record.trusted = true;
    }
    await kv.put(sessionUserKey(token), JSON.stringify(record));
  } catch (error) {
    console.error(JSON.stringify({
      message: "Session user mapping write failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function lookupSessionRecord(env, token) {
  const kv = playbackKv(env);
  if (!kv || !token) return null;
  try {
    const value = await kv.get(sessionUserKey(token), "json");
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    return null;
  }
}

async function lookupSessionUsername(env, token) {
  const record = await lookupSessionRecord(env, token);
  return record && record.username ? String(record.username) : "";
}

// “记住首次登录密码”：同一用户名第二次登录时，密码必须与首次一致。
const LOGIN_PASSWORD_KEY_PREFIX = "login-password:v1:";
const MEMORY_LOGIN_PASSWORDS = new Map();

function normalizedLoginName(username) {
  return String(username || "").trim().toLowerCase();
}

function loginPasswordRecordKey(username) {
  return `${LOGIN_PASSWORD_KEY_PREFIX}u:${md5(normalizedLoginName(username))}`;
}

async function readStoredLoginPassword(env, username) {
  const name = normalizedLoginName(username);
  if (!name) return "";
  const kv = playbackKv(env);
  const memoryValue = MEMORY_LOGIN_PASSWORDS.get(name);
  if (!kv) {
    return typeof memoryValue === "string" ? memoryValue : "";
  }
  try {
    const value = await kv.get(loginPasswordRecordKey(username), "text");
    if (typeof value === "string" && value.length > 0) {
      MEMORY_LOGIN_PASSWORDS.set(name, value);
      return value;
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: "Stored login password read failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return typeof memoryValue === "string" ? memoryValue : "";
}

async function storeStoredLoginPassword(env, username, password) {
  const name = normalizedLoginName(username);
  const pw = String(password || "");
  if (!name || !pw) return;
  try {
    MEMORY_LOGIN_PASSWORDS.set(name, pw);
  } catch {
    // 内存兜底失败不影响主流程
  }
  const kv = playbackKv(env);
  if (!kv) return;
  try {
    await kv.put(loginPasswordRecordKey(username), pw);
  } catch (error) {
    console.error(JSON.stringify({
      message: "Stored login password write failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

// token -> 存储 key 的解析结果缓存：同一条请求链里会反复解析（读状态、写状态、
// 立墓碑），命中缓存可以少几次 KV 读取。用户名还没落到 KV 时不缓存，避免把
// 播放记录归错账号。
const MEMORY_PLAYBACK_KEYS = new Map();
const PLAYBACK_KEY_CACHE_MS = 5 * 60 * 1000;

async function playbackStateKey(env, token) {
  const scope = String(token || "").trim();
  if (!scope || scope === guestToken(env)) {
    return PLAYBACK_STATE_KEY;
  }
  const cached = MEMORY_PLAYBACK_KEYS.get(scope);
  if (cached && Date.now() - cached.at < PLAYBACK_KEY_CACHE_MS) {
    return cached.key;
  }
  const username = await lookupSessionUsername(env, scope);
  const key = username
    ? `${PLAYBACK_STATE_KEY}:u:${md5(username)}`
    : `${PLAYBACK_STATE_KEY}:${playbackTokenPart(scope)}`;
  if (username) {
    MEMORY_PLAYBACK_KEYS.set(scope, { key, at: Date.now() });
    if (MEMORY_PLAYBACK_KEYS.size > MAX_MEMORY_PLAYBACK_STATES) {
      const oldestKey = MEMORY_PLAYBACK_KEYS.keys().next().value;
      if (oldestKey !== undefined) {
        MEMORY_PLAYBACK_KEYS.delete(oldestKey);
      }
    }
  }
  return key;
}

async function loadPlaybackStateByKey(env, key) {
  const memoryState = MEMORY_PLAYBACK_STATES.get(key);
  const value = await durableJsonRead(env, EDGE_NAMESPACE_PLAYBACK, key);
  if (value && typeof value === "object") {
    rememberPlaybackState(key, value);
    return value;
  }
  return memoryState && typeof memoryState === "object" ? memoryState : {};
}

async function readPlaybackState(env, token) {
  const key = await playbackStateKey(env, token);
  const state = await loadPlaybackStateByKey(env, key);
  return pruneStalePlaybackRecords(env, key, state);
}

async function writePlaybackStateByKey(env, key, state) {
  const next = state && typeof state === "object" ? state : {};
  // 写入前的第二道闸门：即使读阶段因为内存缓存或并发没看到墓碑，也不允许已移除的
  // 条目被旧快照写回存储（这是“移除后过一会又出现”的最后一道防线，也是跨实例
  // 并发时唯一能兜住的检查）。这里强制读最新的墓碑表，不做缓存复用。
  const store = await readTombstones(env, key, { fresh: true });
  const filtered = filterStateByTombstones(next, store);
  if (filtered.cleared.length) {
    // 用户真的重新播放了（新会话 / 重新开始）：作废对应的墓碑
    await writeTombstones(env, key, store);
  }
  rememberPlaybackState(key, next);
  await durableJsonWrite(env, EDGE_NAMESPACE_PLAYBACK, key, next);
}

async function writePlaybackState(env, state, token) {
  await writePlaybackStateByKey(env, await playbackStateKey(env, token), state);
}

// —— 移除播放记录用的“墓碑” ——
// 墓碑和进度记录分成两个 key 存。旧做法是把“刚移除过”的时间戳塞在同一份
// 进度数据里：客户端往往几个请求同时在跑（进度上报、刷新列表、收藏…），
// 每个都是“整份读出 → 改一条 → 整份写回”，于是一份删除前的旧快照被迟到的
// 写回盖回存储，刚移除的记录就又冒出来了（就是“移除后过一会又出现”的主因）。
// 拆开后：覆盖只可能发生在进度记录上，墓碑始终还在，读取时能把脏数据剪掉。
const PLAYBACK_TOMBSTONE_SUFFIX = ":removed-v2";
const MAX_MEMORY_TOMBSTONE_STORES = 200;
const MEMORY_PLAYBACK_TOMBSTONES = new Map();

// 记住“这部片当前正在用哪个播放会话”:移除记录时把它写进墓碑,
// 之后同一会话补发的进度就不会再把条目带回来。
const MEMORY_PLAY_SESSIONS = new Map();
const MAX_MEMORY_PLAY_SESSIONS = 500;

function playSessionKey(stateKey, itemId) {
  return String(stateKey || "") + "|" + String(itemId || "");
}

function rememberPlaySession(stateKey, itemId, playSessionId) {
  const sid = String(playSessionId || "");
  if (!stateKey || !itemId || !sid) return;
  try {
    const key = playSessionKey(stateKey, itemId);
    MEMORY_PLAY_SESSIONS.delete(key);
    MEMORY_PLAY_SESSIONS.set(key, { sid, at: Date.now() });
    while (MEMORY_PLAY_SESSIONS.size > MAX_MEMORY_PLAY_SESSIONS) {
      const oldest = MEMORY_PLAY_SESSIONS.keys().next().value;
      if (oldest === undefined) break;
      MEMORY_PLAY_SESSIONS.delete(oldest);
    }
  } catch {
    // 内存兜底失败不能影响主流程
  }
}

function lastPlaySession(stateKey, itemId) {
  try {
    const entry = MEMORY_PLAY_SESSIONS.get(playSessionKey(stateKey, itemId));
    return entry ? String(entry.sid || "") : "";
  } catch {
    return "";
  }
}

function playbackTombstoneKey(stateKey) {
  return `${stateKey}${PLAYBACK_TOMBSTONE_SUFFIX}`;
}

function normalizeTombstone(raw) {
  if (!raw) return null;
  if (typeof raw === "number") {
    return raw > 0 ? { at: raw, positionTicks: 0, played: false } : null;
  }
  if (typeof raw !== "object") return null;
  const at = Number(raw.at) || 0;
  if (!at) return null;
  return {
    at,
    positionTicks: Math.max(0, Number(raw.positionTicks) || 0),
    played: raw.played === true,
    playSessionId: String(raw.playSessionId || ""),
  };
}

function pruneTombstoneStore(store) {
  const now = Date.now();
  let changed = false;
  for (const id of Object.keys(store || {})) {
    const marker = normalizeTombstone(store[id]);
    if (!marker || now - marker.at > PLAYBACK_TOMBSTONE_RETENTION_MS) {
      delete store[id];
      changed = true;
      continue;
    }
    store[id] = marker;
  }
  const ids = Object.keys(store || {});
  if (ids.length > PLAYBACK_MAX_TOMBSTONES) {
    const byAge = ids.sort((a, b) => store[a].at - store[b].at);
    for (const id of byAge.slice(0, byAge.length - PLAYBACK_MAX_TOMBSTONES)) {
      delete store[id];
    }
    changed = true;
  }
  return changed;
}

function rememberTombstones(key, store) {
  try {
    MEMORY_PLAYBACK_TOMBSTONES.set(key, { store: store || {}, at: Date.now() });
    if (MEMORY_PLAYBACK_TOMBSTONES.size > MAX_MEMORY_TOMBSTONE_STORES) {
      const oldestKey = MEMORY_PLAYBACK_TOMBSTONES.keys().next().value;
      if (oldestKey !== undefined) {
        MEMORY_PLAYBACK_TOMBSTONES.delete(oldestKey);
      }
    }
  } catch {
    // 内存兜底失败不能影响主流程
  }
}

async function readTombstones(env, stateKey, opts = {}) {
  const key = playbackTombstoneKey(stateKey);
  const cached = MEMORY_PLAYBACK_TOMBSTONES.get(key);
  const fallback = cached && cached.store && typeof cached.store === "object"
    ? cached.store
    : {};
  // 短时缓存：进度上报很频繁，不能每次都多读一次持久化存储。
  // 即使因此晚几秒才拿到别的实例刚写的墓碑也没关系：脏记录的时间戳早于移除
  // 时间，缓存过期后下一次读取仍会被剪掉。
  if (!opts.fresh && cached && Date.now() - cached.at < PLAYBACK_TOMBSTONE_CACHE_MS) {
    return cached.store && typeof cached.store === "object" ? cached.store : {};
  }
  const value = await durableJsonRead(env, EDGE_NAMESPACE_TOMBSTONE, key);
  if (value === undefined) {
    // 读取失败：沿用上一次的表，绝不把它当成“墓碑全没了”。
    return fallback;
  }
  const store = value && typeof value === "object" ? value : {};
  pruneTombstoneStore(store);
  // 即使读到的是空表也要记进内存缓存（短时），保持原有的“同实例 5 秒”语义。
  rememberTombstones(key, store);
  return store;
}

async function writeTombstones(env, stateKey, store) {
  const key = playbackTombstoneKey(stateKey);
  pruneTombstoneStore(store);
  rememberTombstones(key, store || {});
  await durableJsonWrite(env, EDGE_NAMESPACE_TOMBSTONE, key, store || {});
}

function recordTimestampMs(record) {
  if (!record) return 0;
  const raw = record.lastPlayedDate || record.lastActivityDate || "";
  const value = Date.parse(String(raw));
  return Number.isNaN(value) ? 0 : value;
}

// 脏写回把“已移除”的旧记录带回来时，在读取阶段按墓碑剪掉。
// 判据是时间戳而不是“抑制期是否结束”：早于移除时刻的数据永远是旧数据。
function suppressPlaybackRecord(state, itemId, record) {
  if (record && record.favorite === true) {
    // 收藏过：保留收藏状态，只清掉被带回来的进度与已播标记
    record.positionTicks = 0;
    record.played = false;
    return;
  }
  delete state[itemId];
}

// 按墓碑过滤一份播放记录。纯内存操作：不读写 KV，也不调用 writePlaybackStateByKey，
// 所以“读阶段”和“写阶段”可以共用同一套判据而不会互相递归。
// 返回 changed=记录是否被改动；cleared=可以作废的墓碑（用户真的重新播放了）。
function filterStateByTombstones(state, store) {
  const result = { changed: false, cleared: [] };
  if (!state || typeof state !== "object" || !store || typeof store !== "object") {
    return result;
  }
  for (const itemId of Object.keys(store)) {
    const marker = normalizeTombstone(store[itemId]);
    if (!marker) continue;
    const record = state[itemId];
    if (!record || typeof record !== "object") continue;
    if (!(Number(record.positionTicks) > 0 || Boolean(record.played))) {
      // 只剩收藏等状态，跟“继续观看”无关，不动它
      continue;
    }
    // 同一个播放会话的后续进度上报永远属于“移除前那次播放”:即使进度一直在往前走、
    // 时间戳一直在更新,也不能让它复活(这就是“移除后过一会又出现”的主因)。
    const recordSession = String(record.playSessionId || "");
    const markerSession = String(marker.playSessionId || "");
    if (recordSession && markerSession && recordSession === markerSession) {
      suppressPlaybackRecord(state, itemId, record);
      result.changed = true;
      continue;
    }
    // 只有一次明确的“从 0 重新开始播放”(带 startedAt)才算用户又播了。
    // 新会话号不能单独作准：客户端刷新、重建播放器时也会换会话号，并补发旧进度。
    const startedAt = Date.parse(String(record.startedAt || ""));
    const restarted = Number.isFinite(startedAt) && startedAt > marker.at;
    if (restarted) {
      delete store[itemId];
      result.cleared.push(itemId);
      continue;
    }
    suppressPlaybackRecord(state, itemId, record);
    result.changed = true;
  }
  return result;
}

// 脏写回把“已移除”的旧记录带回来时，在读取阶段按墓碑剪掉。
// 判据是“重新开始”而不是“抑制期是否结束”：残留上报永远不该复活。
async function pruneStalePlaybackRecords(env, stateKey, state) {
  if (!state || typeof state !== "object") return {};
  let stateChanged = Boolean(state.__removedAt);
  if (stateChanged) {
    // 旧版本把抑制标记塞在同一份数据里，已废弃：顺手清掉（无需迁移）
    delete state.__removedAt;
  }
  const store = await readTombstones(env, stateKey);
  const filtered = filterStateByTombstones(state, store);
  stateChanged = stateChanged || filtered.changed;
  if (filtered.cleared.length) {
    // 作废墓碑前重新读一次最新表，别把别的实例刚立的其它墓碑一起覆盖掉
    const latest = await readTombstones(env, stateKey, { fresh: true });
    for (const id of filtered.cleared) delete latest[id];
    await writeTombstones(env, stateKey, latest);
  }
  if (stateChanged) await writePlaybackStateByKey(env, stateKey, state);
  return state;
}

// 从记录里删掉某条目（收藏状态单独保留：移除播放记录不该把收藏一起删掉）
function dropPlaybackRecord(state, itemId) {
  const old = state && state[itemId];
  if (!old) return null;
  delete state[itemId];
  if (old.favorite === true) {
    state[itemId] = {
      itemId,
      positionTicks: 0,
      played: false,
      playCount: Math.max(0, Math.floor(Number(old.playCount) || 0)),
      lastPlayedDate: old.lastPlayedDate || "",
      favorite: true,
    };
  }
  return old;
}

// 移除一条播放记录：删条目 + 立墓碑（两者分开存，互相盖不掉）
async function removePlaybackRecord(env, token, state, itemId) {
  if (!state || !itemId) return false;
  const old = dropPlaybackRecord(state, itemId);
  const key = await playbackStateKey(env, token);
  // 写入前强制读一次最新的墓碑表，避免把别的实例刚立的墓碑覆盖掉
  const store = await readTombstones(env, key, { fresh: true });
  store[itemId] = {
    at: Date.now(),
    positionTicks: Math.max(0, Number(old && old.positionTicks) || 0),
    played: Boolean(old && old.played),
    // 记下移除时正在使用的播放会话:同一会话之后的进度上报都属于残留。
    playSessionId: String((old && old.playSessionId) || lastPlaySession(key, itemId) || ""),
  };
  // 即使当时手上没有这条记录也要立墓碑：并发的旧快照可能正把它写回来。
  await writeTombstones(env, key, store);
  return Boolean(old);
}

// 统一的闸门：返回 true 表示这次写入属于“移除之后补发的残留”，应当忽略。
async function playbackWriteSuppressed(env, token, itemId, opts = {}) {
  if (!itemId) return false;
  const key = await playbackStateKey(env, token);
  const store = await readTombstones(env, key);
  const marker = normalizeTombstone(store[itemId]);
  if (!marker) return false;
  // 客户端刷新时经常会换一个 PlaySessionId，但仍然是删除前那次播放的残留上报。
  // 因此“新会话”本身绝不能解除墓碑；只有明确用户操作，或从 0 真正重新起播才放行。
  const explicitAction = opts.explicit === true;
  const confirmedRestart =
    opts.restarted === true && Number(opts.positionTicks || 0) === 0;
  if (!explicitAction && !confirmedRestart) {
    return true;
  }
  const latest = await readTombstones(env, key, { fresh: true });
  if (latest[itemId]) {
    delete latest[itemId];
    await writeTombstones(env, key, latest);
  }
  return false;
}

// 客户端写用户数据时，参数可能在 body，也可能拼在 query string 上
// （?Played=true 或 ?UserData.Played=true 这类写法），这里统一取值。
function pickUserDataValue(body, params, names) {
  const source = body && typeof body === "object" ? body : {};
  const fromObject = (obj) => {
    if (!obj || typeof obj !== "object") return undefined;
    for (const name of names) {
      if (obj[name] !== undefined) return obj[name];
    }
    return undefined;
  };
  const direct = fromObject(source);
  if (direct !== undefined) return direct;
  for (const wrapper of ["UserData", "UserItemDataDto", "userItemDataDto"]) {
    const inner = fromObject(source[wrapper]);
    if (inner !== undefined) return inner;
  }
  if (params && typeof params.get === "function") {
    for (const name of names) {
      const plain = params.get(name);
      if (plain !== null && plain !== "") return plain;
      for (const prefix of ["UserData.", "UserItemDataDto.", "userData."]) {
        const prefixed = params.get(prefix + name);
        if (prefixed !== null && prefixed !== "") return prefixed;
      }
    }
  }
  return undefined;
}

function isTruthyUserDataFlag(value) {
  if (typeof value === "string") {
    return /^(?:1|true|yes|on)$/i.test(value.trim());
  }
  return Boolean(value);
}

// 是否算“已看完”：显式已播，或进度已到总时长 90% 以上，
// 或距片尾不足 PLAYBACK_FINISH_TAIL_TICKS（2 分钟）。
function isPlaybackFinished(record, runtimeTicks) {
  if (!record) return false;
  if (record.played) return true;
  const positionTicks = Math.max(0, Number(record.positionTicks) || 0);
  const runtime = Math.max(0, Number(runtimeTicks) || 0);
  if (runtime <= 0 || positionTicks <= 0) return false;
  if (positionTicks >= runtime * 0.9) return true;
  return runtime - positionTicks <= PLAYBACK_FINISH_TAIL_TICKS;
}

function userDataForRecord(record) {
  const positionTicks = Math.max(0, Math.floor(Number(record && record.positionTicks) || 0));
  const played = Boolean(record && record.played);
  return {
    Played: played,
    PlayCount: Math.max(0, Math.floor(Number(record && record.playCount) || (played ? 1 : 0))),
    IsFavorite: Boolean(record && record.favorite),
    PlaybackPositionTicks: positionTicks,
    LastPlayedDate: record && record.lastPlayedDate ? record.lastPlayedDate : null,
  };
}

// 把已存的播放进度挂到条目上：客户端详情页的“继续播放”进度条、
// 卡片上的已播放角标都读这里的 UserData。
function attachPlaybackUserData(item, state) {
  if (!item || !state) return item;
  const record = state[item.Id];
  if (record) {
    const data = userDataForRecord(record);
    const runtimeTicks =
      Math.max(0, Number(item.RunTimeTicks) || 0) ||
      Math.max(0, Number(record.runTimeTicks) || 0);
    if (isPlaybackFinished(record, runtimeTicks)) {
      // 已看完（含进度贴近片尾）：详情页/卡片上不再出现“继续播放”进度条，
      // 直接呈现“已播放”。
      data.Played = true;
      data.PlayCount = Math.max(1, Math.floor(Number(data.PlayCount) || 0));
      data.PlaybackPositionTicks = 0;
      data.PlayedPercentage = 100;
    } else {
      const positionTicks = Math.max(0, Number(data.PlaybackPositionTicks) || 0);
      if (runtimeTicks > 0 && positionTicks > 0) {
        data.PlayedPercentage = Math.min(99, Math.round((positionTicks / runtimeTicks) * 100));
      }
    }
    item.UserData = data;
  }
  return item;
}

// 收藏页：客户端会带 Filters=IsFavorite（或 IsFavorite=true）来取“我的收藏”。
// 之前完全没实现，所以收藏页把整个中文字幕片库都列了出来。
function wantsFavoriteOnly(query) {
  if (/^(?:1|true|yes)$/i.test(String(query.get("IsFavorite") || "").trim())) {
    return true;
  }
  const filters = String(query.get("Filters") || "").trim();
  return /(?:^|[,\s|])isfavorite(?:$|[,\s|])/i.test(filters);
}

function favoriteIncludeKinds(query) {
  const raw = String(query.get("IncludeItemTypes") || "").toLowerCase();
  if (!raw) {
    return { videos: true, persons: true };
  }
  return {
    videos: /movie|video|series|episode|boxset|trailer/.test(raw),
    persons: /person|people/.test(raw),
  };
}

// 把收藏状态（影片 + 演员）整理成客户端要的 QueryResult。
async function favoriteItemsPage(query, env, fetchImpl, token) {
  const state = await readPlaybackState(env, token);
  const kinds = favoriteIncludeKinds(query);
  const startIndex = Math.max(0, Number(query.get("StartIndex") || 0));
  const limit = Math.min(
    DEFAULT_PAGE_SIZE,
    Math.max(1, Number(query.get("Limit") || DEFAULT_PAGE_SIZE)),
  );
  const items = [];
  for (const record of Object.values(state)) {
    if (!record || !record.itemId || !record.favorite) {
      continue;
    }
    const personName = personNameFromItemId(record.itemId);
    if (personName) {
      if (kinds.persons) {
        items.push(personItemDto(record.itemId, personName, env));
      }
      continue;
    }
    if (!kinds.videos) {
      continue;
    }
    try {
      const movie = await getMovieCached(record.itemId, env, fetchImpl, token);
      if (!movie || (!movie.id && !movie.number)) continue;
      items.push(attachPlaybackUserData(
        mapMovie(movie, query.requestUrl || "https://localhost/", env),
        state,
      ));
    } catch {
      // 单条回源失败就跳过，不影响整个收藏页
    }
  }
  return {
    Items: items.slice(startIndex, startIndex + limit),
    TotalRecordCount: items.length,
    StartIndex: startIndex,
  };
}

// ================= 分类 / 片商 列表（客户端分类页用） =================
// 客户端进入“分类”页会请求 /Genres，“片商”页会请求 /Studios。
// 上游 /v1/tags、/v1/makers 本身就能给出清单，取一次缓存很久即可，
// 不必为了汇总标签把整个片库都爬一遍。
const FACET_CACHE_TTL_SECONDS = 6 * 60 * 60;
// 年份 / 时长属于“筛选条件”，放进分类页里点开没有意义，这里过滤掉。
const FACET_EXCLUDED_TAG_CATEGORIES = new Set(["year", "duration"]);

async function upstreamFacetNames(kind, env, fetchImpl, token) {
  const upstreamToken = await apiToken(token, env);
  const cacheKey = ["facets-v1", kind, apiOrigin(env), upstreamToken ? "u" : "g"].join("|");
  return LIST_CACHE.fetch(cacheKey, async () => {
    const shared = await edgeCacheRead(EDGE_NAMESPACE_LIST, cacheKey);
    if (Array.isArray(shared)) {
      return shared;
    }
    const names = new Set();
    const facetPath = kind === "studio" ? "/v1/makers" : "/v1/tags";
    for (const type of ["0", "1", "2"]) {
      try {
        const payload = await javdbRequest(facetPath, env, fetchImpl, {
          query: { type },
          token: upstreamToken,
        });
        if (kind === "studio") {
          for (const maker of payload?.makers || []) {
            const name = String(maker?.name || "").trim();
            if (name) names.add(name);
          }
        } else {
          for (const group of payload?.tags || []) {
            if (FACET_EXCLUDED_TAG_CATEGORIES.has(String(group?.category_id || ""))) {
              continue;
            }
            for (const tag of group?.tags || []) {
              const name = String(tag?.name || "").trim();
              if (name) names.add(name);
            }
          }
        }
      } catch {
        // 单个分类抓取失败不影响整体：能拿到多少算多少。
      }
    }
    const list = [...names].sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
    if (list.length) {
      await edgeCacheWrite(EDGE_NAMESPACE_LIST, cacheKey, list, FACET_CACHE_TTL_SECONDS);
    }
    return list;
  });
}

async function genreFacetNames(env, fetchImpl, token) {
  try {
    return await upstreamFacetNames("tag", env, fetchImpl, token);
  } catch {
    return [];
  }
}

async function genreFacetItems(env, fetchImpl, token) {
  const names = await genreFacetNames(env, fetchImpl, token);
  return names.map((name) => ({
    Name: name,
    Id: genreIdForName(name),
    ServerId: serverId(env),
    Type: "Genre",
    IsFolder: false,
    ImageTags: {},
    BackdropImageTags: [],
  }));
}

async function studioFacetItems(env, fetchImpl, token) {
  let names = [];
  try {
    names = await upstreamFacetNames("studio", env, fetchImpl, token);
  } catch {
    names = [];
  }
  return names.map((name) => ({
    Name: name,
    Id: studioIdForName(name),
    ServerId: serverId(env),
    Type: "Studio",
    IsFolder: false,
    ImageTags: {},
    BackdropImageTags: [],
  }));
}

// 单条影片元数据（不解析播放源）：批量取条目时用，保证标签/演员等字段齐全。
async function movieItemById(id, requestUrl, env, fetchImpl, token) {
  const personName = personNameFromItemId(id);
  if (personName) {
    return personItemDto(id, personName, env);
  }
  const movie = await getMovieCached(id, env, fetchImpl, token);
  if (!movie || (!movie.id && !movie.number)) {
    return null;
  }
  return mapMovie(movie, requestUrl, env);
}

function parseJsonBodyText(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function recordPlaybackEvent(path, request, env) {
  const token = getToken(request, new URL(request.url));
  let body = {};
  try {
    body = parseJsonBodyText(await request.clone().text());
  } catch {
    body = {};
  }
  const nowPlayingItem = body.NowPlayingItem || body.nowPlayingItem || {};
  const itemId = String(
    body.ItemId || body.itemId || nowPlayingItem.Id || nowPlayingItem.id || "",
  ).trim();
  if (!itemId) return;
  const playSessionId = String(
    body.PlaySessionId || body.playSessionId ||
    (body.PlaybackInfo && (body.PlaybackInfo.PlaySessionId || body.PlaybackInfo.playSessionId)) || "",
  ).trim();
  const positionTicks = Math.max(0, Number(body.PositionTicks ?? body.positionTicks ?? 0) || 0);
  const runTimeTicks = Math.max(0, Number(
    body.RunTimeTicks ?? body.runTimeTicks ?? nowPlayingItem.RunTimeTicks ?? 0,
  ) || 0);
  // 播完判断：客户端明确上报 PlayedToCompletion，或进度已到总时长 90% 以上，
  // 或进度距片尾已不足 2 分钟（部分客户端在结尾前退出时不带 PlayedToCompletion，
  // 用这些兜底也能标已播，避免“差一点没看完”还留在继续播放里）。
  const playedToCompletion =
    body.PlayedToCompletion === true ||
    body.playedToCompletion === true ||
    (runTimeTicks > 0 &&
      positionTicks > 0 &&
      (positionTicks >= runTimeTicks * 0.9 ||
        runTimeTicks - positionTicks <= PLAYBACK_FINISH_TAIL_TICKS));

  // 区分“刚移除后补发的旧进度”和“用户真的重新播放了”：
  // 不带 EventName 的 /Sessions/Playing 才是“开始播放”，暂停 / 继续 / 拖动进度
  // 条都会带 EventName，旧逻辑把这些也当成重新播放，播放器还开着就会解除抑制。
  const sessionEvent = String(body.EventName || body.eventName || "").trim();
  const restarted = path === "/Sessions/Playing" && !sessionEvent;
  if (await playbackWriteSuppressed(env, token, itemId, {
    positionTicks,
    playedToCompletion,
    restarted,
    playSessionId,
  })) {
    return;
  }
  const state = await readPlaybackState(env, token);
  const existing = state[itemId];
  const record = existing || {
    itemId,
    positionTicks: 0,
    played: false,
    playCount: 0,
    lastPlayedDate: "",
  };
  record.itemId = itemId;
  record.lastPlayedDate = new Date().toISOString();
  if (playSessionId) {
    record.playSessionId = playSessionId;
  }
  if (restarted) {
    // 只有明确“重新开始播放”才写这个标记,读取阶段的剪枝只认它。
    record.startedAt = new Date().toISOString();
  }
  if (runTimeTicks > 0) {
    // 记下客户端上报的总时长，之后判断“是否接近片尾/已看完”不需要再回源。
    record.runTimeTicks = runTimeTicks;
  }

  let touched = false;
  if (path === "/Sessions/Playing/Stopped") {
    if (playedToCompletion) {
      // 整部看完：标已播放、进度清零、播放次数 +1
      record.played = true;
      record.positionTicks = 0;
      record.playCount = Math.max(0, Math.floor(Number(record.playCount) || 0)) + 1;
      touched = true;
    } else if (positionTicks > 0) {
      // 中途退出：保留进度（未看完就不算已播）
      record.played = false;
      record.positionTicks = positionTicks;
      touched = true;
    } else if (!existing) {
      // 刚点开就退出（0 进度）：不生成无效记录
      return;
    } else {
      // 已有记录但这次 0 进度退出：清掉续播进度，保留“是否已播”的状态
      record.positionTicks = 0;
      touched = true;
    }
  } else if (positionTicks > 0) {
    // Playing / Progress：持续上报当前位置，用来画进度条和续播
    record.positionTicks = positionTicks;
    touched = true;
  }
  if (!touched) return;
  state[itemId] = record;
  await writePlaybackState(env, state, token);
}



function isEmbyClientRequest(request) {
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization") || "";
  return (
    url.pathname === "/emby" ||
    url.pathname.startsWith("/emby/") ||
    url.searchParams.has("api_key") ||
    url.searchParams.has("ApiKey") ||
    request.headers.has("x-emby-authorization") ||
    request.headers.has("x-emby-token") ||
    request.headers.has("x-mediabrowser-token") ||
    /^(?:MediaBrowser\b|Bearer\s+|Token\s*[=:])/i.test(authorization)
  );
}

async function imageResponse(id, request, env, fetchImpl, token) {
  // 图片是列表滚动时最密集的请求：先看 Cloudflare 边缘缓存能不能直接命中。
  const edgeCache = typeof caches !== "undefined" && caches && caches.default
    ? caches.default
    : null;
  const cacheKeyRequest = edgeCache && request.method === "GET"
    ? edgeImageCacheKey(new URL(request.url))
    : null;
  if (edgeCache && cacheKeyRequest) {
    try {
      const hit = await edgeCache.match(cacheKeyRequest);
      if (hit) {
        return hit;
      }
    } catch {}
  }
  const movie = await getMovieCached(id, env, fetchImpl, token);
  const imageUrl = safeMediaUrl(movie?.cover_url || movie?.thumb_url, env);
  if (!imageUrl) {
    return errorResponse(404, "Movie image not found");
  }

  const upstream = await fetchImpl(imageUrl.toString(), {
    headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
    redirect: "follow",
  });
  if (!upstream.ok) {
    return errorResponse(404, "Movie image not found");
  }
  const decoded = await decodeImageBody(upstream.body);
  const headers = new Headers({
    // 图片内容基本不变：长缓存 + 过期后仍可先用旧图，滚动列表时不再反复等待。
    "cache-control": "public, max-age=604800, stale-while-revalidate=86400",
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  });
  headers.set(
    "content-type",
    imageContentType(
      imageUrl,
      upstream.headers.get("content-type"),
      decoded.contentType,
    ),
  );
  for (const name of ["etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  const response = new Response(request.method === "HEAD" ? null : decoded.body, {
    status: upstream.status,
    headers,
  });
  if (edgeCache && cacheKeyRequest && response.ok) {
    // 写入边缘缓存放在响应之后，不额外拖慢这一次请求。
    try {
      edgeCache.put(cacheKeyRequest, response.clone()).catch(() => {});
    } catch {}
  }
  return response;
}

async function subtitleResponse(id, index, request, env, fetchImpl, token) {
  try {
    // 首选:详情/起播信息里登记过的 sid -> 直接用真实地址,省掉一次字幕列表解析。
    const requestUrl = new URL(request.url);
    let subtitle = subtitleFromToken(requestUrl.searchParams.get("sid"), id);
    if (!subtitle) {
      // 兜底(令牌过期 / 换了 Worker 实例):按序号重新解析字幕列表。
      const movie = await getMovieCached(id, env, fetchImpl, token);
      const subtitles = await resolveSubtitlesCached(movie, env, fetchImpl);
      const resolved = subtitles[index - 2] || subtitles[index - 1];
      if (!resolved) {
        return errorResponse(404, "Movie subtitle not found");
      }
      subtitle = {
        itemId: String(id),
        url: resolved.url,
        codec: resolved.codec,
        title: resolved.title,
      };
    }

    // 直连字幕 CDN 优先(实测 0.2s 左右),拿到就先返回;
    // 直连不通才回退上游代下接口,不会因为直连失败影响播放。
    const fetched = await cachedSubtitleBody(subtitle, env, fetchImpl);
    if (!fetched) {
      return errorResponse(404, "Movie subtitle not found");
    }

    const codec = subtitleStreamCodec(subtitle);
    const contentType = codec === "vtt"
      ? "text/vtt; charset=utf-8"
      : "application/x-subrip; charset=utf-8";
    return new Response(request.method === "HEAD" ? null : fetched.bytes, {
      status: 200,
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=3600",
        "content-disposition": 'inline; filename="subtitle.' + codec + '"',
        "content-type": contentType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(502, error instanceof Error ? error.message : "Movie subtitle unavailable");
  }
}

async function streamResponse(id, request, env, fetchImpl, token) {
  if (!token && !guestAccessEnabled(env)) {
    return errorResponse(401, "Emby token is required for playback");
  }

  try {
    const requestUrl = new URL(request.url);
    const suppliedSourceValue = ["source", "sourceUrl", "source_url", "url"]
      .map((name) => requestUrl.searchParams.get(name))
      .find(Boolean);
    const suppliedSource = safeMediaUrl(suppliedSourceValue, env);
    const sourceOrigin = upstreamOrigin(env);
    const requestHeaders = new Headers({
      accept: request.headers.get("accept") || "video/*,*/*;q=0.8",
      origin: sourceOrigin,
      referer: `${sourceOrigin}/`,
      "user-agent": "Mozilla/5.0",
    });
    for (const name of ["range", "if-range", "if-none-match", "if-modified-since"]) {
      const value = request.headers.get(name);
      if (value) {
        requestHeaders.set(name, value);
      }
    }

    const triedSources = new Set();
    let lastStatus = 404;
    const tryVideo = async (video) => {
      const candidates = [video, ...(video?.alternates || [])].filter(Boolean);
      for (const candidate of candidates) {
        if (candidate.inlinePlaylist) {
          return new Response(
            request.method === "HEAD" ? null : candidate.inlinePlaylist,
            {
              status: 200,
              headers: {
                "access-control-allow-origin": "*",
                "cache-control": "no-store",
                "content-disposition": `inline; filename="${encodeURIComponent(id)}.m3u8"`,
                "content-type": "application/vnd.apple.mpegurl; charset=utf-8",
                "x-content-type-options": "nosniff",
              },
            },
          );
        }

        const sourceUrl = safeMediaUrl(candidate.sourceUrl, env);
        if (!sourceUrl || triedSources.has(sourceUrl.toString())) {
          continue;
        }
        triedSources.add(sourceUrl.toString());
        const upstream = await fetchImpl(sourceUrl.toString(), {
          method: request.method,
          headers: requestHeaders,
          redirect: "follow",
        });
        if (
          !upstream.ok &&
          (upstream.status === 403 ||
            upstream.status === 404 ||
            upstream.status === 410 ||
            upstream.status === 429 ||
            upstream.status >= 500)
        ) {
          lastStatus = upstream.status;
          await upstream.body?.cancel().catch(() => {});
          continue;
        }

        const responseHeaders = new Headers({
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
          "cache-control": "no-store",
          "content-disposition": `inline; filename="${encodeURIComponent(id)}.${/mpegurl|m3u8/i.test(candidate.sourceType || candidate.sourceUrl) ? "m3u8" : "mp4"}"`,
          "x-content-type-options": "nosniff",
        });
        for (const name of [
          "accept-ranges",
          "content-length",
          "content-range",
          "content-type",
          "etag",
          "last-modified",
        ]) {
          const value = upstream.headers.get(name);
          if (value) {
            responseHeaders.set(name, value);
          }
        }
        if (!responseHeaders.has("content-type")) {
          responseHeaders.set("content-type", candidate.sourceType || "video/mp4");
        }
        return new Response(request.method === "HEAD" ? null : upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      }
      return null;
    };

    if (suppliedSource) {
      const response = await tryVideo({
        sourceUrl: suppliedSource.toString(),
        sourceType: safeMediaContentType(requestUrl.searchParams.get("sourceType")),
      });
      if (response) {
        return response;
      }
    }

    const movieForStream = await getMovieCached(id, env, fetchImpl, token);
    const resolvedVideo = await resolveVideoCached(movieForStream, env, fetchImpl);
    const response = await tryVideo(selectedPlaybackVideo(resolvedVideo, id, requestUrl));
    if (response) {
      return response;
    }
    // 缓存里那份直链已经失效（媒体源拒绝）：清掉缓存重新解析一次再试，
    // 避免“一个人遇到过期的地址，之后所有人都用不了”。
    if (resolvedVideo) {
      forgetResolveVideoCache(movieForStream, env);
      triedSources.clear();
      const retriedVideo = await resolveVideoCached(movieForStream, env, fetchImpl);
      const retriedResponse = await tryVideo(selectedPlaybackVideo(retriedVideo, id, requestUrl));
      if (retriedResponse) {
        return retriedResponse;
      }
    }
    return errorResponse(
      lastStatus === 404 ? 404 : 502,
      "No playable video source was found",
    );
  } catch (error) {
    return errorResponse(502, error instanceof Error ? error.message : "Video source unavailable");
  }
}

function isHandledPath(path) {
  return (
    path === "/System/Info/Public" ||
    path === "/System/Info" ||
    path === "/System/Endpoint" ||
    path === "/System/Configuration" ||
    path === "/Users/Public" ||
    path === "/Users/AuthenticateByName" ||
    path === "/Users" ||
    path === "/Users/Me" ||
    path === "/Users/bbjavdb-user" ||
    path === "/Users/bbjavdb-user/Views" ||
    path === "/Library/VirtualFolders" ||
    path === "/Library/VirtualFolders/Query" ||
    path === "/Library/MediaFolders" ||
    path === "/Items" ||
    path === "/Items/Root" ||
    path === "/Items/Latest" ||
    path === "/Items/Resume" ||
    path === "/Items/Filters" ||
    path === "/Items/Filters2" ||
    path === "/UserViews" ||
    path === "/Shows/NextUp" ||
    path === "/Shows/Upcoming" ||
    path === "/Movies/Recommendations" ||
    path === "/Genres" ||
    path === "/Studios" ||
    path === "/Persons" ||
    /^\/Persons\/[^/]+$/i.test(path) ||
    path === "/SearchHints" ||
    path === "/Sessions" ||
    path === "/Sessions/Capabilities" ||
    path === "/Sessions/Capabilities/Full" ||
    path === "/Sessions/Viewing" ||
    path === "/Sessions/Playing" ||
    path === "/Sessions/Playing/Progress" ||
    path === "/Sessions/Playing/Stopped" ||
    path === "/DisplayPreferences/usersettings" ||
    path === "/Branding/Configuration" ||
    path === "/Startup/Configuration" ||
    path === "/Items/Counts" ||
    path === "/Suggestions" ||
    path === "/LiveTv/Programs/Recommended" ||
    path === "/Channels" ||
    path === "/Trailers" ||
    path === "/Artists/AlbumArtists" ||
    /^\/Users\/[^/]+$/i.test(path) ||
    /^\/Users\/[^/]+\/GroupingOptions$/i.test(path) ||
    /^\/Users\/[^/]+\/Views$/i.test(path) ||
    /^\/Users\/[^/]+\/Suggestions$/i.test(path) ||
    /^\/Users\/[^/]+\/Items(?:\/|$)/i.test(path) ||
    /^\/Users\/[^/]+\/(?:PlayedItems|UnplayedItems|PlayingItems|FavoriteItems)(?:\/[^/]+)?$/i.test(path) ||
    /^\/Users\/[^/]+\/Resume(?:\/[^/]+)?$/i.test(path) ||
    /^\/User(?:Played|Favorite)Items\/[^/]+$/i.test(path) ||
    path.toLowerCase().startsWith("/items/") ||
    path.toLowerCase().startsWith("/videos/") ||
    path.toLowerCase().startsWith("/emby-media/")
  );
}

async function userForRequest(request, url, env) {
  const token = getToken(request, url);
  if (token && token !== guestToken(env)) {
    const username = await lookupSessionUsername(env, token);
    if (username) {
      return virtualUser(env, username, true);
    }
  }
  return virtualUser(env, undefined, guestAccessEnabled(env) ? false : true);
}

function notFoundPage() {
  return new Response(
    "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>404 Not Found</title>" +
      "<body style=\"font-family:system-ui,-apple-system,sans-serif;text-align:center;padding-top:14vh;color:#444\">" +
      "<h1 style=\"font-size:64px;margin:0\">404</h1><p>Not Found</p></body></html>",
    {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

// 识别“浏览器直接打开网页”的请求：限制浏览器访问，直接返回 404。
// EMBY 客户端（APP/TV/第三方）走的接口请求不会被拦截。
function browserPageBlocked(request) {
  const mode = String(request.headers.get("sec-fetch-mode") || "");
  if (mode === "navigate" || mode === "nested-navigate") {
    return true;
  }
  const accept = String(request.headers.get("accept") || "").toLowerCase();
  return accept.includes("text/html") && !accept.includes("application/json");
}

// 媒体投递类请求（播放/字幕/图片/下载）：URL 自带 api_key，播放器不带设备头，跳过设备校验
function isMediaDeliveryPath(path) {
  return (
    path.startsWith("/Videos/") ||
    /^\/Items\/[^/]+\/Images\//i.test(path) ||
    /^\/Items\/[^/]+\/Download$/i.test(path) ||
    path.startsWith("/emby-media/")
  );
}

// token 绑定登录设备：非媒体接口从别的设备使用同一 token 一律 401
async function deviceBindingFailure(request, url, env, path) {
  // 登录 / 切换账号的请求不应被旧 token 的设备绑定拦住
  if (path === "/Users/AuthenticateByName") {
    return null;
  }
  const token = getToken(request, url);
  if (!token || token === guestToken(env)) {
    return null;
  }
  if (isMediaDeliveryPath(path)) {
    return null;
  }
  // 播放进度上报/已播标记来自播放器，放行并允许带 token 上报，不做设备绑定拦截
  if (/^\/(?:Sessions\/Playing(?:\/Progress|\/Stopped)?|Items\/[^/]+\/UserData|Users\/[^/]+\/(?:PlayedItems|UnplayedItems|PlayingItems|FavoriteItems)\/[^/]+)$/i.test(path)) {
    return null;
  }
  const record = await lookupSessionRecord(env, token);
  if (!record || !record.deviceId) {
    return null; // 旧版未绑定/无法识别的 token：放行，重新登录后即绑定
  }
  const deviceId = requestDeviceId(request);
  if (!deviceId) {
    return errorResponse(401, "无法验证设备，请重新登录后再试");
  }
  if (deviceId !== record.deviceId) {
    return errorResponse(401, "Token 与登录设备不匹配（禁止跨设备使用），请重新登录");
  }
  return null;
}

// 从删除类请求的路径里猜出条目 Id。不同客户端写法差异很大：
//   /Users/{uid}/PlayedItems/{id}
//   /Users/{uid}/Items/{id}/UserData
//   /Items/{id}/UserData
//   /Users/{uid}/Items/Resume/{id}
const DELETE_PATH_KEYWORDS = new Set([
  "users",
  "items",
  "useritems",
  "videos",
  "emby",
  "me",
  "userdata",
  "playeditems",
  "unplayeditems",
  "playingitems",
  "favoriteitems",
  "resume",
  "sessions",
  "playing",
  "stopped",
  "progress",
  "viewing",
  "download",
  "delete",
  "remove",
  "stop",
  "start",
  "stream",
  "streaming",
  "original",
  "playback",
]);

function deleteTargetIdFromPath(path) {
  const segments = String(path || "")
    .split("?")[0]
    .split("/")
    .filter(Boolean);
  const candidates = [];
  for (const segment of segments) {
    let value = segment;
    try {
      value = decodeURIComponent(segment);
    } catch {
      value = segment;
    }
    if (value && !DELETE_PATH_KEYWORDS.has(value.toLowerCase())) {
      candidates.push(value);
    }
  }
  return candidates.length ? candidates[candidates.length - 1] : "";
}

// 各客户端“标记已播/未播 / 移除播放记录 / 从继续观看中移除 / 取消收藏”的写法五花八门
// （/PlayedItems、/UnplayedItems、/UserData、/UserPlayedItems …），这里统一成一套
// “条目级用户数据”处理，避免客户端拿到 404。
async function applyItemUserDataAction(itemId, action, request, env, token) {
  const method = request.method;
  const state = await readPlaybackState(env, token);
  const existing = state[itemId];
  const isMarkAction =
    action === "playeditems" || action === "unplayeditems" || action === "favoriteitems";
  if (method === "DELETE" && (action === "playingitems" || action === "userdata")) {
    // 结束播放 / 移除续播记录：整条删掉，条目立刻从“继续观看”消失；
    // 同时立墓碑（单独存储），抑制客户端随后补发的残留上报。
    await removePlaybackRecord(env, token, state, itemId);
    await writePlaybackState(env, state, token);
    return userDataForRecord(undefined);
  }
  if (action === "unplayeditems") {
    // “标记未播放”等于把条目移出继续观看，按移除处理（同样立墓碑）。
    await removePlaybackRecord(env, token, state, itemId);
    await writePlaybackState(env, state, token);
    return userDataForRecord(state[itemId]);
  }
  if (!existing && !isMarkAction) {
    // 本来就没有这条记录，就别凭空写一条（例如重复“结束播放”）。
    return userDataForRecord(existing);
  }
  if (action !== "favoriteitems" && await playbackWriteSuppressed(env, token, itemId, {
    explicit: action === "playeditems" && method !== "DELETE",
    playedToCompletion: action === "playeditems" && method !== "DELETE",
  })) {
    return userDataForRecord(state[itemId]);
  }
  const record = existing || {
    itemId,
    positionTicks: 0,
    played: false,
    playCount: 0,
    lastPlayedDate: "",
  };
  record.itemId = itemId;
  if (action === "playeditems") {
    if (method === "DELETE") {
      record.played = false;
      record.positionTicks = 0;
    } else {
      record.played = true;
      record.positionTicks = 0;
      record.playCount = Math.max(0, Math.floor(Number(record.playCount) || 0)) + 1;
      record.lastPlayedDate = new Date().toISOString();
    }
  } else if (action === "favoriteitems") {
    record.favorite = method !== "DELETE";
  } else {
    // UserData / Resume / Progress：按“清掉续播进度”处理。
    record.positionTicks = 0;
  }
  state[itemId] = record;
  await writePlaybackState(env, state, token);
  return userDataForRecord(record);
}

// 路径里能看出客户端想做哪种操作时就照做，看不出就当成“移除续播记录”。
function fallbackItemAction(path) {
  const lower = String(path || "").toLowerCase();
  if (lower.includes("unplayed")) return "unplayeditems";
  if (lower.includes("played")) return "playeditems";
  if (lower.includes("favorite")) return "favoriteitems";
  if (lower.includes("playing") || lower.includes("progress") || lower.includes("stopped")) return "playingitems";
  return "userdata";
}

// 从路径里取条目 Id：跳过用户 Id（/Users/{uid}/… 里的那一段），
// 免得把用户名当成影片 Id 去改记录。
function fallbackTargetId(path) {
  const segments = String(path || "").split("?")[0].split("/").filter(Boolean);
  const candidates = [];
  for (let i = 0; i < segments.length; i += 1) {
    const previous = (segments[i - 1] || "").toLowerCase();
    let value = segments[i];
    try {
      value = decodeURIComponent(value);
    } catch {
      value = segments[i];
    }
    if (!value) continue;
    if (DELETE_PATH_KEYWORDS.has(value.toLowerCase())) continue;
    if (previous === "users" || previous === "me") continue;
    candidates.push(value);
  }
  return candidates.length ? candidates[candidates.length - 1] : "";
}

// 兜底：只要是针对某一个条目的增删改，就当作成功处理，
// 避免客户端在“移除播放记录 / 继续观看”时报 404。
async function handleFallbackDelete(path, request, env, url) {
  const method = request.method;
  if (method !== "DELETE" && method !== "POST" && method !== "PUT") {
    return null;
  }
  const requestPath = String(path || "");
  const looksLikeItemDelete = /^\/(?:Users|UserItems|Items|Videos|Sessions|emby-media)\//i.test(requestPath);
  if (method === "DELETE") {
    const targetId = deleteTargetIdFromPath(requestPath);
    if (!looksLikeItemDelete && !targetId) {
      return null;
    }
    if (targetId) {
      const token = getToken(request, url);
      await applyItemUserDataAction(targetId, fallbackItemAction(requestPath), request, env, token);
    }
    return noContentResponse();
  }
  // POST/PUT 只在“看得出是在改某条目的用户数据”时兜底，
  // 免得把 PlaybackInfo 之类的正常接口也吞掉。
  const hasDataHint = /(userdata|played|unplayed|playing|progress|favorite|resume|stop|delete|remove)/i.test(requestPath);
  const targetId = fallbackTargetId(requestPath);
  if (!hasDataHint || (!targetId && !looksLikeItemDelete)) {
    return null;
  }
  if (targetId) {
    const token = getToken(request, url);
    await applyItemUserDataAction(targetId, fallbackItemAction(requestPath), request, env, token);
  }
  return noContentResponse();
}

export async function handleEmby(request, env = {}, fetchImpl = fetch, ctx = null) {
  // 有的入口会把 ExecutionContext 当第三个参数传进来(这样才有 waitUntil 可用),
  // 这里做个兼容:识别到就把它当成 ctx。
  if (ctx === null && fetchImpl && typeof fetchImpl.waitUntil === "function") {
    ctx = fetchImpl;
    fetchImpl = fetch;
  }
  const url = new URL(request.url);
  // 记下客户端访问用的域名：边缘缓存的键必须落在当前站点上。
  edgeCacheOrigin = url.origin;
  if (browserPageBlocked(request)) {
    return notFoundPage();
  }
  const requestPath = routePath(request.url);
  if (requestPath === "/" && /^\/emby\/?$/i.test(url.pathname)) {
    return jsonResponse(systemInfo(request.url, env));
  }
  if (!isHandledPath(requestPath)) {
    // 删除类请求（移除播放记录/收藏）先按“删除即成功”兜底，避免客户端 404。
    const earlyFallbackDelete = await handleFallbackDelete(requestPath, request, env, url);
    if (earlyFallbackDelete) {
      return earlyFallbackDelete;
    }
    if (isEmbyClientRequest(request)) {
      console.error(JSON.stringify({
        message: "Unhandled Emby endpoint",
        method: request.method,
        path: requestPath,
      }));
      return errorResponse(404, `Emby endpoint not found: ${request.method} ${requestPath}`);
    }
    return null;
  }
  const path = normalizeClientPath(requestPath);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,HEAD,POST,OPTIONS",
        "access-control-allow-headers": "*",
      },
    });
  }

  const deviceFailure = await deviceBindingFailure(request, url, env, path);
  if (deviceFailure) {
    return deviceFailure;
  }

  if (path === "/System/Info/Public" || path === "/System/Info") {
    return jsonResponse(systemInfo(request.url, env));
  }
  if (path === "/System/Endpoint") {
    return jsonResponse({ IsLocal: false, IsInNetwork: false });
  }
  if (path === "/System/Configuration") {
    return jsonResponse({ EnableFolderView: true });
  }
  if (path === "/Branding/Configuration" || path === "/Startup/Configuration") {
    return jsonResponse({});
  }
  if (path === "/Users/Public") {
    // 不返回任何“公开用户”：客户端会显示手动输入账号密码，
    // 避免它把 JAVDB Guest 当作用户名发给上游而报“账号不存在”。
    return jsonResponse([]);
  }
  if (path === "/Users") {
    const currentUser = await userForRequest(request, url, env);
    const hasToken = Boolean(getToken(request, url));
    return jsonResponse(hasToken ? [currentUser] : []);
  }
  if (path === "/Users/AuthenticateByName") {
    return authenticate(request, env, fetchImpl);
  }
  if (path === "/Users/Me" || /^\/Users\/[^/]+$/i.test(path)) {
    return jsonResponse(await userForRequest(request, url, env));
  }
  if (/^\/Users\/[^/]+\/GroupingOptions$/i.test(path)) {
    return jsonResponse([]);
  }
  if (/^\/Users\/[^/]+\/Views$/i.test(path) || path === "/UserViews") {
    return jsonResponse(itemQuery(
      LIBRARIES.map((library) => libraryView(library, env)),
    ));
  }
  if (path === "/Library/MediaFolders") {
    return jsonResponse(itemQuery(
      LIBRARIES.map((library) => libraryView(library, env)),
    ));
  }
  if (path === "/Library/VirtualFolders") {
    return jsonResponse(LIBRARIES.map(virtualFolder));
  }
  if (path === "/Library/VirtualFolders/Query") {
    return jsonResponse(itemQuery(LIBRARIES.map(virtualFolder)));
  }
  if (path === "/Sessions") {
    return jsonResponse([]);
  }
  if (path === "/DisplayPreferences/usersettings") {
    return jsonResponse(displayPreferences(url));
  }
  if (
    path === "/Sessions/Capabilities" ||
    path === "/Sessions/Capabilities/Full" ||
    path === "/Sessions/Viewing"
  ) {
    return noContentResponse();
  }
  if (
    path === "/Sessions/Playing" ||
    path === "/Sessions/Playing/Progress" ||
    path === "/Sessions/Playing/Stopped"
  ) {
    try {
      await recordPlaybackEvent(path, request, env);
    } catch (error) {
      console.error(JSON.stringify({
        message: "Playback event handling failed",
        path,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return noContentResponse();
  }

  const token = getToken(request, url);
  if (path === "/Items/Root") {
    return jsonResponse(rootItem(env));
  }
  if (path === "/Items") {
    try {
      const query = new URLSearchParams(url.search);
      query.requestUrl = request.url;
      // 收藏页（Filters=IsFavorite / IsFavorite=true）：只回收藏过的影片和演员。
      if (wantsFavoriteOnly(query)) {
        return jsonResponse(await favoriteItemsPage(query, env, fetchImpl, token));
      }
      // 点击演员后的“该演员出演作品”列表：客户端会带 PersonIds=person:<演员名>。
      // 走专门的演员检索，只返回可播放作品；没有 PersonIds 才是普通浏览/搜索。
      if (query.has("PersonIds") && !query.get("SearchTerm")) {
        const personResult = await personMoviesPage(query, env, fetchImpl, token);
        const personState = await readPlaybackState(env, token);
        personResult.Items = personResult.Items.map((item) =>
          attachPlaybackUserData({ ...item, Path: item.Path }, personState),
        );
        return jsonResponse(personResult);
      }
      // 点击“类别 / 标签 / 片商 / 系列”后的列表：客户端会带
      // GenreIds / TagIds / StudioIds / SeriesId（或名称形式的 Genres / Tags / Studios）回来。
      // 这里统一还原成名字，再走和演员一样的回源搜索，同样只返回可播放作品。
      if (!query.get("SearchTerm") && !query.has("PersonIds")) {
        const collectionName = collectionFilterName(query);
        if (collectionName) {
          const collectionResult = await collectionMoviesPage(
            query,
            env,
            fetchImpl,
            token,
            collectionName,
          );
          const collectionState = await readPlaybackState(env, token);
          collectionResult.Items = collectionResult.Items.map((item) =>
            attachPlaybackUserData({ ...item, Path: item.Path }, collectionState),
          );
          return jsonResponse(collectionResult);
        }
      }
      // 有些客户端用“批量取条目”的方式打开详情（/Items?Ids=xxx）。
      // 这里也要带上标签 / 演员 / 片商 / 系列，否则详情页看起来就是“什么都没有”。
      const batchIdsParam = query.get("Ids");
      if (batchIdsParam && !query.get("SearchTerm")) {
        const wantedIds = String(batchIdsParam)
          .split(",")
          .map((value) => safeDecodeComponent(value.trim()))
          .filter(Boolean);
        if (wantedIds.length) {
          const batchState = await readPlaybackState(env, token);
          const batchItems = [];
          for (const wantedId of wantedIds.slice(0, 100)) {
            const batchItem = await movieItemById(
              wantedId,
              request.url,
              env,
              fetchImpl,
              token,
            );
            if (batchItem) {
              batchItems.push(attachPlaybackUserData(batchItem, batchState));
            }
          }
          return jsonResponse(itemQuery(batchItems));
        }
      }
      const result = await getMoviePage(query, env, fetchImpl, token);
      const userDataState = await readPlaybackState(env, token);
      result.Items = result.Items.map((item) => attachPlaybackUserData({ ...item, Path: item.Path }, userDataState));
      return jsonResponse(result);
    } catch (error) {
      return errorResponse(502, error instanceof Error ? error.message : "Movie catalog unavailable");
    }
  }
  if (path === "/Items/Latest") {
    try {
      const query = new URLSearchParams(url.search);
      query.set("StartIndex", "0");
      query.requestUrl = request.url;
      const result = await getMoviePage(query, env, fetchImpl, token);
      const userDataState = await readPlaybackState(env, token);
      return jsonResponse(result.Items.map((item) => attachPlaybackUserData(item, userDataState)));
    } catch (error) {
      return errorResponse(502, error instanceof Error ? error.message : "Latest movies unavailable");
    }
  }
  if (path === "/Items/Resume") {
    try {
      const resumeState = await readPlaybackState(env, token);
      const resumeLimit = Math.min(
        PLAYBACK_MAX_RESUME_ITEMS,
        Math.max(1, Number(url.searchParams.get("Limit")) || PLAYBACK_MAX_RESUME_ITEMS),
      );
      const candidates = Object.values(resumeState)
        .filter((record) => record && record.itemId && !record.played && Number(record.positionTicks) > 0)
        .sort((a, b) => String(b.lastPlayedDate || "").localeCompare(String(a.lastPlayedDate || "")));
      const resumeItems = [];
      let stateChanged = false;
      for (const record of candidates) {
        if (resumeItems.length >= resumeLimit) break;
        // 优先用播放时上报过的总时长判断是否已基本看完；没有才回源影片数据。
        const recordRuntime = Math.max(0, Number(record.runTimeTicks) || 0);
        if (recordRuntime > 0 && isPlaybackFinished(record, recordRuntime)) {
          record.played = true;
          record.positionTicks = 0;
          record.playCount = Math.max(1, Math.floor(Number(record.playCount) || 0));
          stateChanged = true;
          continue;
        }
        try {
          const movie = await getMovieCached(record.itemId, env, fetchImpl, token);
          if (!movie || (!movie.id && !movie.number)) continue;
          const item = mapMovie(movie, request.url, env);
          const runtimeTicks = recordRuntime || Math.max(0, Number(item.RunTimeTicks) || 0);
          if (isPlaybackFinished(record, runtimeTicks)) {
            // 已看完但只差片尾几秒/一两分钟：从“继续播放”里清掉，并补上“已播放”标记。
            record.played = true;
            record.positionTicks = 0;
            record.playCount = Math.max(1, Math.floor(Number(record.playCount) || 0));
            stateChanged = true;
            continue;
          }
          resumeItems.push(attachPlaybackUserData(item, resumeState));
        } catch {
          // Item may no longer be resolvable upstream; skip silently.
        }
      }
      if (stateChanged) await writePlaybackState(env, resumeState, token);
      return jsonResponse(itemQuery(resumeItems));
    } catch (error) {
      console.error(JSON.stringify({
        message: "Resume list failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      return jsonResponse(emptyItemQuery());
    }
  }
  // 演员单条详情：/Persons/<演员名>（部分客户端点演员后先请求这个接口）
  const personSingleMatch = path.match(/^\/Persons\/([^/]+)$/i);
  if (personSingleMatch) {
    const personName = decodeURIComponent(personSingleMatch[1]);
    return jsonResponse(personItemDto(personIdForName(personName), personName, env));
  }
  // 分类页 / 片商页：给客户端的列表填上真实条目。
  // 点进去以后客户端会带 GenreIds / StudioIds 回来，再转成上游搜索。
  if (path === "/Genres") {
    return jsonResponse(itemQuery(await genreFacetItems(env, fetchImpl, token)));
  }
  if (path === "/Studios") {
    return jsonResponse(itemQuery(await studioFacetItems(env, fetchImpl, token)));
  }
  if (
    path === "/Shows/NextUp" ||
    path === "/Shows/Upcoming" ||
    path === "/Persons"
  ) {
    return jsonResponse(emptyItemQuery());
  }
  // 收藏列表：/Users/{uid}/FavoriteItems（部分客户端直接打这个地址）
  if (/^\/Users\/[^/]+\/FavoriteItems$/i.test(path) && request.method === "GET") {
    const favoriteQuery = new URLSearchParams(url.search);
    favoriteQuery.requestUrl = request.url;
    return jsonResponse(await favoriteItemsPage(favoriteQuery, env, fetchImpl, token));
  }
  const userDataMatch = path.match(/^\/Items\/([^/]+)\/UserData$/i);
  if (userDataMatch) {
    const userDataItemId = decodeURIComponent(userDataMatch[1]);
    const userDataState = await readPlaybackState(env, token);
    if (request.method === "DELETE") {
      await removePlaybackRecord(env, token, userDataState, userDataItemId);
      await writePlaybackState(env, userDataState, token);
      return noContentResponse();
    }
    if (request.method === "POST" || request.method === "PUT") {
      let body = {};
      try {
        body = parseJsonBodyText(await request.clone().text());
      } catch {
        body = {};
      }
      // 有的客户端把这些参数拼在 query string 上而不是放 body
      const playedParam = pickUserDataValue(body, url.searchParams, ["Played", "played"]);
      const positionParam = pickUserDataValue(body, url.searchParams, [
        "PlaybackPositionTicks",
        "playbackPositionTicks",
        "PositionTicks",
        "positionTicks",
      ]);
      const playCountParam = pickUserDataValue(body, url.searchParams, ["PlayCount", "playCount"]);
      const favoriteParam = pickUserDataValue(body, url.searchParams, [
        "IsFavorite",
        "isFavorite",
        "Favorite",
      ]);
      const incomingPosition = Math.max(0, Number(positionParam) || 0);
      const incomingPlayed = playedParam === undefined
        ? undefined
        : isTruthyUserDataFlag(playedParam);
      if (incomingPosition > 0 || incomingPlayed === true) {
        // 客户端退出后常会补发一次“最后的进度”，刚移除过的条目不能被它复活
        if (await playbackWriteSuppressed(env, token, userDataItemId, {
          positionTicks: incomingPosition,
          playedToCompletion: incomingPlayed === true,
        })) {
          return noContentResponse();
        }
      }
      const record = userDataState[userDataItemId] || {
        itemId: userDataItemId,
        positionTicks: 0,
        played: false,
        playCount: 0,
        lastPlayedDate: "",
      };
      record.itemId = userDataItemId;
      if (incomingPlayed !== undefined) {
        record.played = incomingPlayed;
        if (record.played) {
          record.positionTicks = 0;
          if (record.playCount <= 0) {
            record.playCount = 1;
          }
          record.lastPlayedDate = new Date().toISOString();
        }
      }
      if (positionParam !== undefined) {
        record.positionTicks = incomingPosition;
        if (incomingPosition > 0) {
          record.lastPlayedDate = new Date().toISOString();
        }
      }
      if (playCountParam !== undefined) {
        record.playCount = Math.max(0, Math.floor(Number(playCountParam) || 0));
      }
      if (favoriteParam !== undefined) {
        record.favorite = isTruthyUserDataFlag(favoriteParam);
      }
      record.lastPlayedDate = record.lastPlayedDate || new Date().toISOString();
      userDataState[userDataItemId] = record;
      await writePlaybackState(env, userDataState, token);
      return noContentResponse();
    }
    const userDataRecord = userDataState[userDataItemId];
    if (userDataRecord && !userDataRecord.played && Number(userDataRecord.positionTicks) > 0) {
      const recordRuntime = Math.max(0, Number(userDataRecord.runTimeTicks) || 0);
      let runtimeTicks = recordRuntime;
      if (runtimeTicks <= 0) {
        try {
          const userDataMovie = await getMovieCached(userDataItemId, env, fetchImpl, token);
          if (userDataMovie && (userDataMovie.id || userDataMovie.number)) {
            runtimeTicks = Math.max(0, Number(mapMovie(userDataMovie, request.url, env).RunTimeTicks) || 0);
          }
        } catch {
          // 回源失败不阻断，保持原样返回
        }
      }
      if (runtimeTicks > 0 && isPlaybackFinished(userDataRecord, runtimeTicks)) {
        // 进度贴近片尾：补上“已播放”标记并清掉进度，避免详情/继续播放残留进度条。
        userDataRecord.played = true;
        userDataRecord.positionTicks = 0;
        userDataRecord.playCount = Math.max(1, Math.floor(Number(userDataRecord.playCount) || 0));
        userDataState[userDataItemId] = userDataRecord;
        await writePlaybackState(env, userDataState, token);
      }
    }
    return jsonResponse(userDataForRecord(userDataState[userDataItemId]));
  }
  // 兼容旧版客户端的“标记已播/取消已播/上报进度”接口
  const playedItemsMatch = path.match(/^\/Users\/[^/]+\/PlayedItems\/([^/]+)$/i);
  if (playedItemsMatch && (request.method === "POST" || request.method === "PUT")) {
    const playedItemId = decodeURIComponent(playedItemsMatch[1]);
    const playedState = await readPlaybackState(env, token);
    // 手动点“标记已播”是用户的明确操作,即使刚移除过记录也要生效
    // (标记为已播不会回到“继续观看”,不会造成记录复活)。
    if (await playbackWriteSuppressed(env, token, playedItemId, {
      playedToCompletion: true,
      explicit: true,
    })) {
      // 刚移除过：客户端补发的“已播放”不写回，直接回当前状态
      return jsonResponse(userDataForRecord(playedState[playedItemId]));
    }
    const playedRecord = playedState[playedItemId] || {
      itemId: playedItemId,
      positionTicks: 0,
      played: false,
      playCount: 0,
      lastPlayedDate: "",
    };
    playedRecord.itemId = playedItemId;
    playedRecord.played = true;
    playedRecord.positionTicks = 0;
    playedRecord.playCount = Math.max(0, Math.floor(Number(playedRecord.playCount) || 0)) + 1;
    playedRecord.lastPlayedDate = new Date().toISOString();
    playedState[playedItemId] = playedRecord;
    await writePlaybackState(env, playedState, token);
    // Emby 这两个接口会回传更新后的 UserData，客户端按对象解析。
    return jsonResponse(userDataForRecord(playedRecord));
  }
  // “移除播放记录 / 标记未播放”：Emby 官方接口就是
  // DELETE /Users/{uid}/PlayedItems/{id}。旧代码只处理了 POST/PUT，
  // 所以客户端一点“移除播放记录”就会拿到 404。
  if (playedItemsMatch && request.method === "DELETE") {
    const removedPlayedId = decodeURIComponent(playedItemsMatch[1]);
    const removedPlayedState = await readPlaybackState(env, token);
    await removePlaybackRecord(env, token, removedPlayedState, removedPlayedId);
    await writePlaybackState(env, removedPlayedState, token);
    return jsonResponse(userDataForRecord(removedPlayedState[removedPlayedId]));
  }
  const unplayedItemsMatch = path.match(/^\/Users\/[^/]+\/UnplayedItems\/([^/]+)$/i);
  if (unplayedItemsMatch && (request.method === "POST" || request.method === "DELETE")) {
    const unplayedItemId = decodeURIComponent(unplayedItemsMatch[1]);
    const unplayedState = await readPlaybackState(env, token);
    // “标记未播放”就是把条目移出继续观看：删记录 + 立墓碑，
    // 否则客户端紧接着补发的旧进度会把它又写回来。
    await removePlaybackRecord(env, token, unplayedState, unplayedItemId);
    await writePlaybackState(env, unplayedState, token);
    return jsonResponse(userDataForRecord(unplayedState[unplayedItemId]));
  }
  const playingItemsMatch = path.match(/^\/Users\/[^/]+\/PlayingItems\/([^/]+)$/i);
  if (playingItemsMatch && (request.method === "POST" || request.method === "PUT")) {
    let playingBody = {};
    try {
      playingBody = parseJsonBodyText(await request.clone().text());
    } catch {
      playingBody = {};
    }
    const playingItemId = decodeURIComponent(playingItemsMatch[1]);
    const playingPosition = Math.max(0, Number(
      pickUserDataValue(playingBody, url.searchParams, [
        "PositionTicks",
        "positionTicks",
        "PlaybackPositionTicks",
        "playbackPositionTicks",
      ]) ?? 0,
    ) || 0);
    if (playingPosition > 0) {
      // 这条接口就是“上报续播位置”，是记录复活最常见的来源之一
      if (await playbackWriteSuppressed(env, token, playingItemId, {
        positionTicks: playingPosition,
      })) {
        return noContentResponse();
      }
      const playingState = await readPlaybackState(env, token);
      const playingRecord = playingState[playingItemId] || {
        itemId: playingItemId,
        positionTicks: 0,
        played: false,
        playCount: 0,
        lastPlayedDate: "",
      };
      playingRecord.itemId = playingItemId;
      playingRecord.positionTicks = playingPosition;
      playingRecord.lastPlayedDate = new Date().toISOString();
      playingState[playingItemId] = playingRecord;
      await writePlaybackState(env, playingState, token);
    }
    return noContentResponse();
  }
  // 结束播放：DELETE /Users/{uid}/PlayingItems/{id}
  if (playingItemsMatch && request.method === "DELETE") {
    const stoppedItemId = decodeURIComponent(playingItemsMatch[1]);
    const stoppedState = await readPlaybackState(env, token);
    await removePlaybackRecord(env, token, stoppedState, stoppedItemId);
    await writePlaybackState(env, stoppedState, token);
    return noContentResponse();
  }
  // 收藏 / 取消收藏：POST 与 DELETE /Users/{uid}/FavoriteItems/{id}
  const favoriteItemsMatch = path.match(/^\/Users\/[^/]+\/FavoriteItems\/([^/]+)$/i);
  if (favoriteItemsMatch && ["POST", "PUT", "DELETE"].includes(request.method)) {
    const favoriteItemId = decodeURIComponent(favoriteItemsMatch[1]);
    const favoriteState = await readPlaybackState(env, token);
    const favoriteRecord = favoriteState[favoriteItemId] || {
      itemId: favoriteItemId,
      positionTicks: 0,
      played: false,
      playCount: 0,
      lastPlayedDate: "",
    };
    favoriteRecord.itemId = favoriteItemId;
    favoriteRecord.favorite = request.method !== "DELETE";
    favoriteState[favoriteItemId] = favoriteRecord;
    await writePlaybackState(env, favoriteState, token);
    // 关键修复：Emby 的收藏/取消收藏会回传更新后的 UserData，客户端按对象解析；
    // 旧实现返回 204 空响应，于是点“收藏演员 / 收藏影片”时报
    // SerializationException: Expected start of the object '{', but had 'EOF'。
    return jsonResponse(userDataForRecord(favoriteRecord));
  }
  if (favoriteItemsMatch && request.method === "GET") {
    const favoriteItemId = decodeURIComponent(favoriteItemsMatch[1]);
    return jsonResponse(userDataForRecord((await readPlaybackState(env, token))[favoriteItemId]));
  }
  if (path === "/Movies/Recommendations") {
    return jsonResponse([]);
  }
  if (path === "/Items/Filters" || path === "/Items/Filters2") {
    // 筛选面板里的“类型”也填上真实条目（同样来自上游标签清单，长缓存）。
    return jsonResponse({
      Genres: await genreFacetNames(env, fetchImpl, token),
      Tags: [],
      OfficialRatings: [],
      Years: [],
    });
  }
  if (path === "/Items/Counts") {
    return jsonResponse({
      MovieCount: 1000,
      SeriesCount: 0,
      EpisodeCount: 0,
      ArtistCount: 0,
      ProgramCount: 0,
      TrailerCount: 0,
      SongCount: 0,
      AlbumCount: 0,
      MusicVideoCount: 0,
      BoxSetCount: 0,
      BookCount: 0,
      ItemCount: 1000,
    });
  }
  if (
    path === "/Suggestions" ||
    path === "/LiveTv/Programs/Recommended" ||
    path === "/Channels" ||
    path === "/Trailers" ||
    path === "/Artists/AlbumArtists"
  ) {
    return jsonResponse(emptyItemQuery());
  }
  if (path === "/SearchHints") {
    try {
      const hintQuery = new URLSearchParams();
      hintQuery.set("SearchTerm", url.searchParams.get("SearchTerm") || "");
      const hintStart = Number(url.searchParams.get("StartIndex") || 0);
      const hintLimit = Number(url.searchParams.get("Limit") || 100);
      if (Number.isFinite(hintStart) && hintStart > 0) hintQuery.set("StartIndex", String(hintStart));
      if (Number.isFinite(hintLimit) && hintLimit > 0) hintQuery.set("Limit", String(hintLimit));
      const result = await getMoviePage(hintQuery, env, fetchImpl, token);
      return jsonResponse({
        SearchHints: result.Items.map((item) => ({
          ItemId: item.Id,
          Id: item.Id,
          Name: item.Name,
          Type: "Movie",
          MediaType: "Video",
          ProductionYear: item.ProductionYear,
          PrimaryImageTag: item.ImageTags?.Primary,
        })),
      });
    } catch (error) {
      return errorResponse(502, error instanceof Error ? error.message : "Search unavailable");
    }
  }

  // 多种客户端把“标记已播/未播、收藏、结束播放、移除续播”写成
  // /Items/{id}/PlayedItems 这类路径（带 /Users/{uid} 前缀的写法已在
  // normalizeClientPath 里统一掉）。这里显式接住，免得落到 404。
  const itemActionMatch = path.match(
    /^\/Items\/([^/]+)\/(PlayedItems|UnplayedItems|PlayingItems|FavoriteItems)$/i,
  );
  if (itemActionMatch && ["POST", "PUT", "DELETE"].includes(request.method)) {
    return jsonResponse(await applyItemUserDataAction(
      decodeURIComponent(itemActionMatch[1]),
      itemActionMatch[2].toLowerCase(),
      request,
      env,
      token,
    ));
  }
  // 旧版 / 第三方客户端的写法：/UserPlayedItems/{id}、/UserFavoriteItems/{id}
  const legacyUserItemMatch = path.match(/^\/User(Played|Favorite)Items\/([^/]+)$/i);
  if (legacyUserItemMatch) {
    const legacyItemId = decodeURIComponent(legacyUserItemMatch[2]);
    const legacyAction =
      legacyUserItemMatch[1].toLowerCase() === "played" ? "playeditems" : "favoriteitems";
    if (["POST", "PUT", "DELETE"].includes(request.method)) {
      return jsonResponse(await applyItemUserDataAction(legacyItemId, legacyAction, request, env, token));
    }
    if (request.method === "GET") {
      const legacyState = await readPlaybackState(env, token);
      return jsonResponse(userDataForRecord(legacyState[legacyItemId]));
    }
  }

  // 统一兜底：走到这里说明前面所有具体删除处理都没匹配上。
  // 退一步按“删除/标记 = 清掉该条目的播放记录”处理，避免客户端报 404。
  const genericFallbackDelete = await handleFallbackDelete(path, request, env, url);
  if (genericFallbackDelete) {
    return genericFallbackDelete;
  }

  const imageMatch = path.match(/^\/Items\/([^/]+)\/Images\/Primary$/i);
  if (imageMatch) {
    try {
      return await imageResponse(decodeURIComponent(imageMatch[1]), request, env, fetchImpl, token);
    } catch (error) {
      return errorResponse(502, error instanceof Error ? error.message : "Movie image unavailable");
    }
  }

  const playbackMatch = path.match(/^\/Items\/([^/]+)\/PlaybackInfo$/i);
  if (playbackMatch) {
    try {
      const movie = await getMovieCached(decodeURIComponent(playbackMatch[1]), env, fetchImpl, token);
      const item = mapMovie(movie, request.url, env);
      const playbackToken = token || (guestAccessEnabled(env) ? guestToken(env) : "");
      // 与详情页一致：给解析一小段预算时间，超时就先返回占位媒体源，让客户端马上能起播
      // （真正播放时由 /Videos/{id}/stream 再做完整解析；后台解析完成后会写进缓存）。
      const videoResolution = trackResolution(resolveVideoCached(movie, env, fetchImpl));
      const subtitleResolution = trackResolution(
        resolveSubtitlesCached(movie, env, fetchImpl).catch(() => []),
      );
      // 播放源与字幕一起给预算，但超时时分别取回“已经完成”的那部分：
      // 慢字幕不能再把已经解析好的播放源一起丢掉。
      try {
        await withTimeout(
          Promise.all([videoResolution.tracked, subtitleResolution.tracked]),
          PLAYBACK_INFO_RESOLVE_BUDGET_MS,
        );
      } catch {
        // 忽略:超时后下面按各自的实际完成情况取值。
      }
      const video = videoResolution.record.done ? videoResolution.record.value : null;
      const resolutionFinished = videoResolution.record.done;
      const subtitles = subtitleResolution.record.done
        ? subtitleResolution.record.value || []
        : await peekCachedSubtitles(movie, env);
      if (!resolutionFinished) {
        // 播放源没赶上预算:后台继续解析,下次起播直接命中缓存。
        prewarmResolve(movie, env, fetchImpl, ctx);
      } else if (!subtitleResolution.record.done) {
        // 播放源已经拿到:让字幕在后台继续解析完并写进缓存。
        keepAlive(subtitleResolution.tracked, ctx);
      }

      const mediaSources = video
        ? mediaSourcesForVideo(item, request.url, playbackToken, video, subtitles)
        : resolutionFinished
          ? []
          : mediaSourcesForVideo(
            item,
            request.url,
            playbackToken,
            { title: item.Name, sourceType: "video/mp4" },
            subtitles,
          );

      const playSessionId = crypto.randomUUID();
      // 记住这次播放用的会话号:之后“移除播放记录”才能认出哪些上报是残留。
      rememberPlaySession(await playbackStateKey(env, playbackToken), item.Id, playSessionId);
      return jsonResponse({
        PlaySessionId: playSessionId,
        ItemId: item.Id,
        MediaSources: mediaSources,
      });
    } catch (error) {
      return errorResponse(502, error instanceof Error ? error.message : "Playback metadata unavailable");
    }
  }
  const downloadMatch = path.match(/^\/Items\/([^/]+)\/Download$/i);
  if (downloadMatch) {
    return streamResponse(
      decodeURIComponent(downloadMatch[1]),
      request,
      env,
      fetchImpl,
      token,
    );
  }

  const itemMatch = path.match(/^\/Items\/([^/]+)$/i);
  if (itemMatch) {
    try {
      return await itemResponse(decodeURIComponent(itemMatch[1]), request, env, fetchImpl, token, ctx);
    } catch (error) {
      return errorResponse(502, error instanceof Error ? error.message : "Movie metadata unavailable");
    }
  }

  const subtitleMatch = path.match(
    /^\/Videos\/([^/]+)\/[^/]+\/Subtitles\/(\d+)\/Stream\.[a-z0-9]+$/i,
  );
  if (subtitleMatch) {
    return subtitleResponse(
      decodeURIComponent(subtitleMatch[1]),
      Number(subtitleMatch[2]),
      request,
      env,
      fetchImpl,
      token,
    );
  }

  const streamMatch = path.match(
    /^\/Videos\/([^/]+)(?:\/[^/]+)?\/(?:stream(?:ing)?|original|download|playback)(?:[._-][^/]*)?$/i,
  );
  if (streamMatch) {
    return streamResponse(
      decodeURIComponent(streamMatch[1]),
      request,
      env,
      fetchImpl,
      token,
    );
  }

  if (path.startsWith("/emby-media/")) {
    const mediaUrl = safeMediaUrl(url.searchParams.get("url"), env);
    if (!mediaUrl) {
      return errorResponse(403, "Media URL is not allowed");
    }
    const headers = new Headers();
    const range = request.headers.get("range");
    if (range) {
      headers.set("range", range);
    }
    const upstream = await fetchImpl(mediaUrl.toString(), {
      method: request.method,
      headers,
      redirect: "follow",
    });
    const responseHeaders = new Headers();
    for (const name of ["accept-ranges", "content-length", "content-range", "content-type"]) {
      const value = upstream.headers.get(name);
      if (value) {
        responseHeaders.set(name, value);
      }
    }
    responseHeaders.set("access-control-allow-origin", "*");
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  const lateFallbackDelete = await handleFallbackDelete(path, request, env, url);
  if (lateFallbackDelete) {
    return lateFallbackDelete;
  }

  return errorResponse(404, `Emby endpoint not found: ${request.method} ${path}`);
}
