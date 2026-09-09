const DEFAULT_API_ORIGIN = "https://jdforrepam.com/api";
const DEFAULT_UPSTREAM_ORIGIN = "https://catembylegacy.fastcdn.dpdns.org";
const DEFAULT_RESOLVER_ORIGIN = "https://javstrm.emby-59f.workers.dev";
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
const MAX_INLINE_HLS_LENGTH = 2_000_000;
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
  return new Response(JSON.stringify(value), {
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

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(fetchImpl, url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchWithTimeout(fetchImpl, url, options);
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  throw lastError;
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
  });
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
function movieDisplayName(movie) {
  const title = String(movie?.title || movie?.name || "").trim();
  const number = String(movie?.number || movie?.code || "").trim();
  if (number && title && !title.toUpperCase().startsWith(number.toUpperCase())) {
    return `${number} ${title}`.trim();
  }
  return title || number || String(movie?.id || "");
}

function mapMovie(movie, requestUrl, env = {}, parentId = CHINESE_PLAYABLE_LIBRARY_ID) {
  const id = String(movie.id ?? movie.number ?? "");
  const image = movie.cover_url || movie.thumb_url || "";
  const date = movie.release_date || movie.released_at || "";
  const year = Number.parseInt(String(date).slice(0, 4), 10);
  const duration = Number(movie.duration || 0);
  const tags = (movie.tags || []).map(tagName).filter(Boolean);
  if (hasChineseSubtitles(movie)) {
    tags.unshift("中文字幕");
  }
  if (movie.can_play) {
    tags.unshift("可播放");
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
    OriginalTitle: movie.title || movie.number || id,
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
    Container: "mp4",
    Overview: movie.summary || "",
    PremiereDate: date || undefined,
    ProductionYear: Number.isFinite(year) ? year : undefined,
    RunTimeTicks: duration > 0 ? Math.round(duration * 60 * 10_000_000) : undefined,
    Genres: uniqueTags,
    Tags: uniqueTags,
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

  if (movie.maker_name) {
    item.Studios = [{ Name: movie.maker_name, Id: String(movie.maker_id || "") }];
  }
  if (movie.director_name) {
    item.People.push({
      Name: movie.director_name,
      Type: "Director",
      Id: String(movie.director_id || movie.director_name),
    });
  }
  if (movie.series_name) {
    item.SeriesName = movie.series_name;
    item.SeriesId = String(movie.series_id || "");
  }

  return item;
}

async function apiToken(token, env) {
  const value = String(token || "").trim();
  if (!value || value === guestToken(env)) {
    return "";
  }
  const record = await lookupSessionRecord(env, value);
  // 只有“真实 JavDB 会话”的 token 才透传给上游数据接口；
  // “本地信任登录”生成的随机 token 一律不带，避免被 JavDB 当成无效会话拒绝。
  if (!record || record.trusted === true) {
    return "";
  }
  return value;
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
  const sortComparators = buildSortComparators(query.get("SortBy"));
  // 默认“最新上架”顺序走原有快速路径；
  // 一旦客户端明确要求“按年份/名称”等排序，就抓全量后再排序分页，保证排序真的生效。
  const needsFullCatalog = !isNaturalCatalogOrder(sortComparators, sortOrder);

  if (searchTerm) {
    // 搜索：上游 /v2/search 每页最多返回 50 条，且里面混着“不可播放”的条目。
    // 因此按页翻找、过滤并去重，把该片库里匹配的结果尽量都找出来，
    // 避免客户端只能看到第一页里筛剩下的几条（例如明明有几十上百部，却只显示 2 部）。
    const matchingMovies = [];
    const seen = new Set();
    let sourcePage = 1;
    let sourceExhausted = false;

    while (
      sourcePage <= SEARCH_MAX_SOURCE_PAGES &&
      !sourceExhausted &&
      (needsFullCatalog || matchingMovies.length < requiredCount)
    ) {
      const payload = await javdbRequest("/v2/search", env, fetchImpl, {
        query: {
          q: searchTerm,
          page: sourcePage,
          type: "movie",
          movie_filter_by: library.sourceFilter,
          limit: SEARCH_SOURCE_PAGE_SIZE,
        },
        token: await apiToken(token, env),
      });
      const movies = moviesFromPayload(payload);
      if (movies.length === 0) {
        sourceExhausted = true;
        break;
      }
      for (const movie of movies) {
        if (!library.matches(movie)) {
          continue;
        }
        const key = String(movie.id ?? movie.number ?? "");
        if (key && !seen.has(key)) {
          seen.add(key);
          matchingMovies.push(movie);
        }
      }
      // 这一页不足一页，说明已经翻到结果末尾
      if (movies.length < SEARCH_SOURCE_PAGE_SIZE) {
        sourceExhausted = true;
        break;
      }
      sourcePage += 1;
    }

    const orderedMovies = needsFullCatalog
      ? sortMoviesForClient(matchingMovies, sortComparators, sortOrder)
      : matchingMovies;
    const pageMovies = orderedMovies.slice(startIndex, requiredCount);
    return {
      Items: pageMovies.map((movie) => mapMovie(
        movie,
        query.requestUrl || "https://localhost/",
        env,
        parentId,
      )),
      // 已翻到末尾时用真实数量；否则略多报，让客户端能继续往下翻页
      TotalRecordCount: sourceExhausted
        ? matchingMovies.length
        : matchingMovies.length + 1,
      StartIndex: startIndex,
    };
  }

  const matchingMovies = [];
  const seen = new Set();
  let sourcePage = 1;
  let hasMoreSource = true;
  let sourceExhausted = false;

  while (
    sourcePage <= HOME_MAX_SOURCE_PAGES &&
    hasMoreSource &&
    (needsFullCatalog || matchingMovies.length < requiredCount)
  ) {
    const payload = await javdbRequest("/v1/movies/latest", env, fetchImpl, {
      query: {
        page: sourcePage,
        filter_by: library.sourceFilter,
        type: library.sourceType,
        limit: HOME_SOURCE_PAGE_SIZE,
      },
      token: await apiToken(token, env),
    });
    const movies = moviesFromPayload(payload);
    hasMoreSource = movies.length >= HOME_SOURCE_PAGE_SIZE;
    for (const movie of movies) {
      if (!library.matches(movie)) {
        continue;
      }
      const key = String(movie.id ?? movie.number ?? "");
      if (key && !seen.has(key)) {
        seen.add(key);
        matchingMovies.push(movie);
      }
    }
    if (movies.length < HOME_SOURCE_PAGE_SIZE) {
      sourceExhausted = true;
      break;
    }
    sourcePage += 1;
  }

  const orderedMovies = needsFullCatalog
    ? sortMoviesForClient(matchingMovies, sortComparators, sortOrder)
    : matchingMovies;
  const movies = orderedMovies.slice(startIndex, requiredCount);
  const totalRecordCount = sourceExhausted
    ? matchingMovies.length
    : matchingMovies.length + 1;
  return {
    Items: movies.map((movie) => mapMovie(
      movie,
      query.requestUrl || "https://localhost/",
      env,
      parentId,
    )),
    TotalRecordCount: totalRecordCount,
    StartIndex: startIndex,
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

// 按演员名回源搜索其“可播放”作品（跨分类汇总、去重后返回）。
// 客户端点演员后带的请求一般是 /Items?PersonIds=person:<名字>&...
async function personMoviesPage(query, env, fetchImpl, token) {
  const startIndex = Math.max(0, Number(query.get("StartIndex") || 0));
  const limit = Math.min(
    DEFAULT_PAGE_SIZE,
    Math.max(1, Number(query.get("Limit") || DEFAULT_PAGE_SIZE)),
  );
  const requiredCount = startIndex + limit;
  // 若请求指定了某个分类（ParentId），只在该分类里搜；否则跨四个分类汇总，
  // 因为同一个演员的作品可能分散在“中文字幕/有码/无码/欧美”里。
  const requestedParentId = query.get("ParentId") || "";
  const singleLibrary = LIBRARIES.find((lib) => lib.id === requestedParentId) || null;
  const libraryList = singleLibrary ? [singleLibrary] : LIBRARIES;

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
    return { Items: [], TotalRecordCount: 0, StartIndex: startIndex };
  }

  // 与分类列表一致：客户端点演员后也可能按“年份/名称/添加时间”排序。
  // 需要排序时就把该演员的作品抓全（各分类都翻到底）再排序分页，
  // 否则排序只会作用在某一页的局部数据上，看起来就是“排序不生效”。
  // 默认“最新上架”顺序才走快速分页，边抓边够当前页就提前返回。
  const sortOrder = /^asc/i.test(String(query.get("SortOrder") || "")) ? "asc" : "desc";
  const sortComparators = buildSortComparators(query.get("SortBy"));
  const needsFullCatalog = !isNaturalCatalogOrder(sortComparators, sortOrder);

  const matches = [];
  const seen = new Set();
  const libraryByKey = new Map();
  let fullyScanned = true;

  for (const library of libraryList) {
    if (!needsFullCatalog && matches.length >= requiredCount) break;
    let sourcePage = 1;
    let sourceExhausted = false;
    while (sourcePage <= SEARCH_MAX_SOURCE_PAGES && !sourceExhausted) {
      const payload = await javdbRequest("/v2/search", env, fetchImpl, {
        query: {
          q: searchTerm,
          page: sourcePage,
          type: "movie",
          movie_filter_by: library.sourceFilter,
          limit: SEARCH_SOURCE_PAGE_SIZE,
        },
        token: await apiToken(token, env),
      });
      const movies = moviesFromPayload(payload);
      if (movies.length === 0) {
        sourceExhausted = true;
        break;
      }
      for (const movie of movies) {
        if (!library.matches(movie)) {
          continue;
        }
        const key = String(movie.id ?? movie.number ?? "");
        if (key && !seen.has(key)) {
          seen.add(key);
          matches.push(movie);
          libraryByKey.set(key, library);
        }
      }
      // 这一页不足一页，说明已经翻到结果末尾
      if (movies.length < SEARCH_SOURCE_PAGE_SIZE) {
        sourceExhausted = true;
        break;
      }
      if (!needsFullCatalog && matches.length >= requiredCount) break;
      sourcePage += 1;
    }
    if (!sourceExhausted) {
      fullyScanned = false;
    }
  }

  const orderedMovies = needsFullCatalog
    ? sortMoviesForClient(matches, sortComparators, sortOrder)
    : matches;
  const pageMovies = orderedMovies.slice(startIndex, requiredCount);
  return {
    Items: pageMovies.map((movie) => mapMovie(
      movie,
      query.requestUrl || "https://localhost/",
      env,
      libraryByKey.get(String(movie.id ?? movie.number ?? ""))?.id ||
        (singleLibrary ? singleLibrary.id : ""),
    )),
    // 已把相关分类都翻到底时用真实数量；否则略多报，让客户端能继续往下翻页
    TotalRecordCount: fullyScanned ? matches.length : matches.length + 1,
    StartIndex: startIndex,
  };
}


async function resolveVideo(movie, env, fetchImpl) {
  const code = movie.number || movie.code || movie.id || movie.title;
  if (!code) {
    return null;
  }

  const payload = await resolverJson(
    `/api/resolve?code=${encodeURIComponent(code)}&lang=zh`,
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

  return {
    ...variant,
    alternates: variants.filter((item) => item !== variant),
  };
}

function subtitleCodec(subtitle) {
  const value = String(subtitle?.ext || "srt").toLowerCase();
  return /^[a-z0-9]+$/.test(value) ? value : "srt";
}

async function resolveSubtitles(movie, env, fetchImpl) {
  const code = movie.number || movie.code || movie.id || movie.title;
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

function mediaSource(item, requestUrl, token, video, subtitles = []) {
  const isHls = /mpegurl|m3u8/i.test(video.sourceType || video.sourceUrl);
  // ===== 媒体信息 STRM 化（旧逻辑以注释保留，便于恢复）=====
  // 旧版：容器提示是 HLS / M3U8，客户端媒体信息里会显示 “HLS / M3U8”：
  //   旧代码：const container = isHls ? "hls" : "mp4";
  // 新版：改成 STRM 提示，让客户端把每条资源当成一个 .strm 远程文件。
  // 真实播放地址仍是下方 streamExtension 生成的 .m3u8 / .mp4（未改动），播放不受影响。
  const container = isHls ? "strm" : "mp4";
  // 实际播放/下载地址的后缀仍用 .m3u8 / .mp4，保持真实文件类型。
  const streamExtension = isHls ? "m3u8" : "mp4";
  const height = Number(video.quality || 0);
  const width = height > 0 ? Math.round((height * 16) / 9 / 2) * 2 : undefined;
  const streamUrl = new URL(
    publicRoutePath(
      requestUrl,
      `/Videos/${encodeURIComponent(item.Id)}/stream.${streamExtension}`,
    ),
    requestUrl,
  );
  streamUrl.searchParams.set("api_key", token);
  streamUrl.searchParams.set("static", "true");
  streamUrl.searchParams.set("mediaSourceId", item.Id);
  if (video.sourceUrl) {
    streamUrl.searchParams.set("source", video.sourceUrl);
    streamUrl.searchParams.set("sourceType", video.sourceType || "video/mp4");
  }
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
    Id: item.Id,
    Name: video.title,
    Path: streamUrl.toString(),
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
    DefaultSubtitleStreamIndex: subtitleStreams.length > 0 ? 2 : undefined,
    MediaStreams: [
      // ===== 媒体信息精简（第 2 步）：视频轨/音频轨整段停用，不再下发给客户端 =====
      // 上一版虽然隐藏了“编码/分辨率/码率”，但客户端媒体信息里仍会显示
      // “视频 编号 0”“音频 编号 1 默认 true 强制 false 外部 false”这类行。
      // 现按需求把视频流、音频流整段注释掉，媒体信息不再出现这两条轨道，
      // 只保留外部字幕流（供播放器选择“字幕 1 / 字幕 2…”）。
      // 需要恢复时，把下面两段“// 原视频流 / // 原音频流”中的代码取消注释即可。
      //
      // 原视频流（含 Type/Index/IsDefault/IsForced/IsExternal 结构字段）：
      // {
      //   Type: "Video",
      //   // Codec: isHls ? "hls" : "h264",
      //   // CodecTag: isHls ? undefined : "avc1",
      //   // DisplayTitle: height > 0 ? (height + "p H264 SDR") : "H264 SDR", // 原行（显示 分辨率+H264）
      //   IsDefault: true,
      //   IsForced: false,
      //   IsExternal: false,
      //   Index: 0,
      //   // Width: width,
      //   // Height: height || undefined,
      //   // AspectRatio: "16:9",
      //   // VideoRange: "SDR",
      //   // VideoRangeType: "SDR",
      //   // IsInterlaced: false,
      //   // IsAVC: !isHls,
      //   // IsAnamorphic: false,
      //   // TimeBase: "1/10000000",
      // },
      // 原音频流（含 Type/Index/IsDefault/IsForced/IsExternal 结构字段）：
      // {
      //   Type: "Audio",
      //   // Codec: "aac",
      //   // CodecTag: "mp4a",
      //   // Language: "und",
      //   // DisplayLanguage: "Undetermined",
      //   // DisplayTitle: "AAC stereo",
      //   Index: 1,
      //   // Channels: 2,
      //   // ChannelLayout: "stereo",
      //   // SampleRate: 48000,
      //   IsDefault: true,
      //   IsForced: false,
      //   IsExternal: false,
      // },
      ...subtitleStreams,
    ],
  };
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

// 详情页内“顺带解析播放源”的预算时间：超过即先返回元数据，播放时再完整解析。
const ITEM_DETAIL_RESOLVE_BUDGET_MS = 2000;

function withTimeout(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("resolve timed out")), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

async function itemResponse(id, request, env, fetchImpl, token) {
  // 演员条目：Id 为 person:<演员名> 时直接返回 Person 对象，不当作影片回源。
  const personNameFromId = personNameFromItemId(id);
  if (personNameFromId) {
    return jsonResponse(personItemDto(id, personNameFromId, env));
  }
  const movie = await getMovie(id, env, fetchImpl, token);
  if (!movie?.id && !movie?.number) {
    return errorResponse(404, "Movie not found");
  }

  const item = mapMovie(movie, request.url, env);
  attachPlaybackUserData(item, await readPlaybackState(env, token));

  // 详情页不应被“解析播放源/字幕”这类慢请求拖住：解析服务首次冷启动时
  // 会明显变慢（第二次通常命中缓存才快），旧逻辑在返回详情前一直等它，
  // 导致第一次点开影片详情时客户端长时间转圈。
  // 这里只给一小段预算时间，能在预算内解析完成（通常是缓存命中）就顺带
  // 返回 MediaSources；超时/失败就立刻先返回影片元数据，等用户真正点播放时
  // 由 /PlaybackInfo 再做完整解析。
  let video = null;
  let subtitles = [];
  let resolutionFinished = false;
  try {
    [video, subtitles] = await withTimeout(
      Promise.all([
        resolveVideo(movie, env, fetchImpl),
        hasChineseSubtitles(movie)
          ? resolveSubtitles(movie, env, fetchImpl).catch(() => [])
          : Promise.resolve([]),
      ]),
      ITEM_DETAIL_RESOLVE_BUDGET_MS,
    );
    resolutionFinished = true;
  } catch {
    video = null;
    subtitles = [];
  }

  if (!video) {
    if (resolutionFinished) {
      // 解析已完成但确实没有可播放源：明确标成不可播放，避免客户端去请求播放。
      item.PlayAccess = "None";
      item.MediaSources = [];
      item.MediaStreams = [];
      item.MediaSourceCount = 0;
      item.HasSubtitles = false;
    }
    // 解析超时/失败时不清空 PlayAccess，只返回元数据；
    // 播放动作会再走 PlaybackInfo，届时能拿到最新解析结果。
    return jsonResponse(item);
  }
  const source = mediaSource(
    item,
    request.url,
    token || (guestAccessEnabled(env) ? guestToken(env) : ""),
    video,
    subtitles,
  );
  item.Path = source.Path;
  item.MediaSources = [source];
  item.MediaStreams = source.MediaStreams;
  item.MediaSourceCount = 1;
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

// 播放记录的后备存储：
// - 优先用 KV 命名空间（PLAYBACK_KV）跨请求长期保存；
// - 即使没配置 KV，也会在内存里记一份，保证同一实例内“进度/已播”立刻生效。
const MAX_MEMORY_PLAYBACK_STATES = 500;

function playbackKv(env) {
  const kv = env && env.PLAYBACK_KV;
  return kv && typeof kv.get === "function" && typeof kv.put === "function" ? kv : null;
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

async function playbackStateKey(env, token) {
  const scope = String(token || "").trim();
  if (!scope || scope === guestToken(env)) {
    return PLAYBACK_STATE_KEY;
  }
  const username = await lookupSessionUsername(env, scope);
  if (username) {
    return `${PLAYBACK_STATE_KEY}:u:${md5(username)}`;
  }
  return `${PLAYBACK_STATE_KEY}:${playbackTokenPart(scope)}`;
}

async function readPlaybackState(env, token) {
  const key = await playbackStateKey(env, token);
  const memoryState = MEMORY_PLAYBACK_STATES.get(key);
  const kv = playbackKv(env);
  if (!kv) {
    return memoryState && typeof memoryState === "object" ? memoryState : {};
  }
  try {
    const value = await kv.get(key, "json");
    if (value && typeof value === "object") {
      rememberPlaybackState(key, value);
      return value;
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: "Playback state read failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return memoryState && typeof memoryState === "object" ? memoryState : {};
}

async function writePlaybackState(env, state, token) {
  const key = await playbackStateKey(env, token);
  rememberPlaybackState(key, state || {});
  const kv = playbackKv(env);
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(state || {}));
  } catch (error) {
    console.error(JSON.stringify({
      message: "Playback state write failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
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
    IsFavorite: false,
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
  const movie = await getMovie(id, env, fetchImpl, token);
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
    "cache-control": "public, max-age=3600",
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
  return new Response(request.method === "HEAD" ? null : decoded.body, {
    status: upstream.status,
    headers,
  });
}

async function subtitleResponse(id, index, request, env, fetchImpl, token) {
  try {
    const movie = await getMovie(id, env, fetchImpl, token);
    const subtitles = await resolveSubtitles(movie, env, fetchImpl);
    const subtitle = subtitles[index - 2] || subtitles[index - 1];
    if (!subtitle) {
      return errorResponse(404, "Movie subtitle not found");
    }

    const target = new URL("/api/subtitle/file", upstreamOrigin(env));
    target.searchParams.set("url", subtitle.url);
    const upstream = await fetchImpl(target.toString(), {
      method: request.method,
      headers: {
        accept: "text/vtt,application/x-subrip,text/plain,*/*;q=0.8",
        "user-agent": "Mozilla/5.0",
      },
      redirect: "follow",
    });
    if (!upstream.ok) {
      return errorResponse(404, "Movie subtitle not found");
    }

    const contentType = subtitle.codec === "vtt"
      ? "text/vtt; charset=utf-8"
      : "application/x-subrip; charset=utf-8";
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=3600",
        "content-disposition": `inline; filename="subtitle.${subtitle.codec}"`,
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

    const resolvedVideo = await resolveVideo(
      await getMovie(id, env, fetchImpl, token),
      env,
      fetchImpl,
    );
    const response = await tryVideo(resolvedVideo);
    if (response) {
      return response;
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
    /^\/Users\/[^/]+\/PlayedItems\/[^/]+$/i.test(path) ||
    /^\/Users\/[^/]+\/UnplayedItems\/[^/]+$/i.test(path) ||
    /^\/Users\/[^/]+\/PlayingItems\/[^/]+$/i.test(path) ||
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
  if (/^\/(?:Sessions\/Playing(?:\/Progress|\/Stopped)?|Items\/[^/]+\/UserData|Users\/[^/]+\/(?:PlayedItems|UnplayedItems|PlayingItems)\/[^/]+)$/i.test(path)) {
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

export async function handleEmby(request, env = {}, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (browserPageBlocked(request)) {
    return notFoundPage();
  }
  const requestPath = routePath(request.url);
  if (requestPath === "/" && /^\/emby\/?$/i.test(url.pathname)) {
    return jsonResponse(systemInfo(request.url, env));
  }
  if (!isHandledPath(requestPath)) {
    if (isEmbyClientRequest(request)) {
      console.error(JSON.stringify({
        message: "Unhandled Emby endpoint",
        method: request.method,
        path: requestPath,
      }));
      return errorResponse(404, "Emby endpoint not found");
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
          const movie = await getMovie(record.itemId, env, fetchImpl, token);
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
  if (
    path === "/Shows/NextUp" ||
    path === "/Shows/Upcoming" ||
    path === "/Genres" ||
    path === "/Studios" ||
    path === "/Persons"
  ) {
    return jsonResponse(emptyItemQuery());
  }
  const userDataMatch = path.match(/^\/Items\/([^/]+)\/UserData$/i);
  if (userDataMatch) {
    const userDataItemId = decodeURIComponent(userDataMatch[1]);
    const userDataState = await readPlaybackState(env, token);
    if (request.method === "DELETE") {
      delete userDataState[userDataItemId];
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
      const record = userDataState[userDataItemId] || {
        itemId: userDataItemId,
        positionTicks: 0,
        played: false,
        playCount: 0,
        lastPlayedDate: "",
      };
      if (body.Played !== undefined) {
        record.played = Boolean(body.Played);
        if (record.played) {
          record.positionTicks = 0;
          if (record.playCount <= 0) {
            record.playCount = 1;
          }
        }
      }
      if (body.PlaybackPositionTicks !== undefined) {
        record.positionTicks = Math.max(0, Number(body.PlaybackPositionTicks) || 0);
      }
      if (body.PlayCount !== undefined) {
        record.playCount = Math.max(0, Math.floor(Number(body.PlayCount) || 0));
      }
      if (body.IsFavorite !== undefined) {
        record.favorite = Boolean(body.IsFavorite);
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
          const userDataMovie = await getMovie(userDataItemId, env, fetchImpl, token);
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
    return noContentResponse();
  }
  const unplayedItemsMatch = path.match(/^\/Users\/[^/]+\/UnplayedItems\/([^/]+)$/i);
  if (unplayedItemsMatch && (request.method === "POST" || request.method === "DELETE")) {
    const unplayedItemId = decodeURIComponent(unplayedItemsMatch[1]);
    const unplayedState = await readPlaybackState(env, token);
    const unplayedRecord = unplayedState[unplayedItemId] || {
      itemId: unplayedItemId,
      positionTicks: 0,
      played: false,
      playCount: 0,
      lastPlayedDate: "",
    };
    unplayedRecord.itemId = unplayedItemId;
    unplayedRecord.played = false;
    unplayedState[unplayedItemId] = unplayedRecord;
    await writePlaybackState(env, unplayedState, token);
    return noContentResponse();
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
      playingBody.PositionTicks ?? playingBody.positionTicks ?? 0,
    ) || 0);
    if (playingPosition > 0) {
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
  if (path === "/Movies/Recommendations") {
    return jsonResponse([]);
  }
  if (path === "/Items/Filters" || path === "/Items/Filters2") {
    return jsonResponse({ Genres: [], Tags: [], OfficialRatings: [], Years: [] });
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
      const movie = await getMovie(decodeURIComponent(playbackMatch[1]), env, fetchImpl, token);
      const item = mapMovie(movie, request.url, env);
      const [video, subtitles] = await Promise.all([
        resolveVideo(movie, env, fetchImpl),
        resolveSubtitles(movie, env, fetchImpl).catch(() => []),
      ]);
      if (!video) {
        return jsonResponse({ PlaySessionId: crypto.randomUUID(), MediaSources: [] });
      }
      return jsonResponse({
        PlaySessionId: crypto.randomUUID(),
        ItemId: item.Id,
        MediaSources: [
          mediaSource(
            item,
            request.url,
            token || (guestAccessEnabled(env) ? guestToken(env) : ""),
            video,
            subtitles,
          ),
        ],
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
      return await itemResponse(decodeURIComponent(itemMatch[1]), request, env, fetchImpl, token);
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

  return errorResponse(404, "Emby endpoint not found");
}

