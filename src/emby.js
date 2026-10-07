const DEFAULT_API_ORIGIN = "https://jdforrepam.com/api";
const DEFAULT_UPSTREAM_ORIGIN = "https://catembylegacy.fastcdn.dpdns.org";
const DEFAULT_RESOLVER_ORIGIN = "https://catembylegacy.fastcdn.dpdns.org";
// 配置了 JAVSTRM_ORIGIN 时使用独立解析器的 /api/resolve；未配置时继续走
// 原站公开接口 /api/v/resolve。两条链路不同，不能共用一个默认路径。
const DEFAULT_RESOLVER_RESOLVE_PATH = "/api/resolve";
const PUBLIC_RESOLVER_RESOLVE_PATH = "/api/v/resolve";
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
// 旧版客户端仍可能请求早期版本暴露的“可播放”片库。入口已从可见片库移除，
// 这里只保留隐藏的兼容映射，避免旧请求落空或误落到“中文字幕”筛选。
const LEGACY_PLAYABLE_LIBRARY_ID = "bbjavdb-playable";
// 全局搜索（客户端不带 ParentId 的搜索）默认用的视图：只要求“可播放”，
// 不要求中文字幕。它不是片库，不出现在 /Views 列表里，只是搜索的默认过滤条件；
// 仍然按 libraryForRequestedId 解析，所以客户端带着这个 ParentId 回访也不会落空。
const PLAYABLE_SEARCH_LIBRARY_ID = "bbjavdb-playable-search";
const PLAYABLE_SEARCH_LIBRARY = {
  id: PLAYABLE_SEARCH_LIBRARY_ID,
  name: "可播放",
  sourceType: "all",
  sourceFilter: "can_play",
  matches: (movie) => Boolean(movie?.can_play),
};
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

function libraryForRequestedId(parentId) {
  if (parentId === LEGACY_PLAYABLE_LIBRARY_ID) {
    return {
      id: CHINESE_PLAYABLE_LIBRARY_ID,
      name: "中文字幕",
      sourceType: "all",
      sourceFilter: "can_play",
      matches: (movie) => Boolean(movie?.can_play),
    };
  }
  if (parentId === PLAYABLE_SEARCH_LIBRARY_ID) {
    return PLAYABLE_SEARCH_LIBRARY;
  }
  return LIBRARIES.find((item) => item.id === parentId) ||
    LIBRARIES.find((item) => item.id === CHINESE_PLAYABLE_LIBRARY_ID);
}

const MEDIA_HOSTS = new Set([
  "fast-stream.jav.si",
  "jdforrepam.com",
  "lh3.googleusercontent.com",
  "tp.spfcas.com",
  "h1.gzankun.com",
  "static.worldstatic.com",
  "www.fcjav.com",
]);
const MEDIA_SUFFIXES = [
  ".spfcas.com",
  ".gzankun.com",
  ".cloudvexario.xyz",
  ".startupmarketingaid.cfd",
  ".vendorconnection.shop",
  ".summitdigitalhub.space",
  ".tiktokcdn.com",
];
const GETAV_MEDIA_REFERER = "https://getav.net/";
const INLINE_HLS_CONTENT_TYPES = new Set([
  "application/mpegurl",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
]);
// 解析器有时会把整段 HLS 清单塞进 data URL。不同资源的清单大小差异很大，
// 旧上限会把稍大的备用线路直接过滤掉，客户端就只剩一条播放源。
const MAX_INLINE_HLS_LENGTH = 12_000_000;
const MAX_HLS_REWRITE_DEPTH = 8;
// 校验播放源时只需要看清单的“开头几条”就能判断第一条分片/子清单是否可播。
// 解析器会把整份清单（实测 RCTD-740 约 2MB）塞进 data: URL，如果按行全量
// 展开再逐条探测，单次 PlaybackInfo 就会吃掉大量 CPU/内存并触发 Cloudflare
// 1102。这里给扫描加上字符数与行数上限，超出部分按“未验证”处理（fail-open），
// 保证多线路都能保留，同时把冷启动开销压到常量级。
const HLS_PLAYLIST_SCAN_MAX_CHARS = 64 * 1024;
const HLS_PLAYLIST_SCAN_MAX_LINES = 128;
// DTO 结构变化时提升版本，客户端会把它当成新的实体版本并刷新旧详情页缓存。
// v16：所有媒体源名称在响应出口统一去掉“解析中”，并把无源兜底保留为
// 可播放的按需线路。旧 DTO 版本必须失效，否则客户端本地数据库里的
// “自动线路（解析中）”详情页会继续显示。
// v15：无源时不再返回 PlayAccess=None + 空 MediaSources（那会让客户端把
// 条目判为不可用并清掉本地播放记录/进度条/播放按钮），改成按需占位源。
// 结构变化必须提升版本，客户端才会把本地库里那份旧 DTO 当成新实体重新拉取。
const ITEM_DTO_ETAG_VERSION = "item-dto-v19";
// 部署标记：客户端忽略这个未知字段，运维侧可据此确认“新代码是否真的上线”，
// 用来区分“修了没生效”和“根本没部署”。
const SERVER_BUILD_ID = "2026-10-08-numeric-code-and-cover-art-23";
// 播放源还没解析完的详情 DTO 会带上“时间桶”参与 ETag 计算：同一个桶内
// ETag 稳定（客户端可以正常命中 304），跨桶后 ETag 必然变化。
// Emby 客户端会把整份 DTO 缓存在本地库里，只有 ETag 变化才会真正替换缓存；
// 有了这个桶，用户退出详情页 ~20 秒后再进来，客户端一定会重新拉一份
// （此时后台解析通常已经完成，播放按钮和全部线路都会出现）。
const PENDING_SOURCES_ETAG_BUCKET_MS = 20 * 1000;
const REMOTE_HLS_PROBE_TIMEOUT_MS = 3500;
// 整个“播放源可用性校验”的总预算。校验是逐条线路探测上游分片，慢 CDN 上
// 单条就可能超过 3 秒；如果让所有线路都校验完再返回，冷启动详情/PlaybackInfo
// 很容易突破客户端的 HTTP 超时，甚至把 Worker 打到 Cloudflare 1102。
// 超预算的线路按“未验证”保留（fail-open），只有拿到明确失败证据的线路才剔除，
// 这样既不会只剩一条源，也不会把已经坏掉的源当作权威结果。
const REMOTE_HLS_VALIDATION_BUDGET_MS = 2600;
// A resolver response can contain several HLS variants. Validate them in
// parallel, but keep each variant's probe chain short so PlaybackInfo cannot
// be held open by a slow CDN.
// 并发越高越容易在同时校验 8 条线路时把 Worker 推到 CPU/内存上限
// （Cloudflare 1102 / 503），这里降到 2，够快又不至于整请求被杀。
const REMOTE_HLS_VARIANT_CONCURRENCY = 2;
// 每条线路一份独立预算（不是所有线路共用），且必须够走完
// “主清单 → 子清单 → 首个分片”这条最深的验证链（可选再带一次 AES 取密钥），
// 否则预算一旦耗尽，代码会 fail-open 把小预算当成“可用”，坏的线路就混进
// 播放源下拉框（选中后其实回退播放 GG 线路，表现为“源数量不对/放出来是别的源”）。
// 主清单 + 子清单 + 分片探测 + AES 密钥 = 4 次请求，正好覆盖最深链。
const REMOTE_HLS_PROBE_BUDGET = 4;
const REMOTE_HLS_PROBE_DEPTH = 2;
const REMOTE_MEDIA_PROBE_BYTES = 512;
// 上游媒体 CDN（尤其直链 / HLS 分片）会偶发“TCP 已经连上，但迟迟不回响应头”。
// 旧实现直接 await fetchImpl(...)，没有任何超时：Worker 会一直挂在那里，客户端
// 看到的就是“点了播放一直加载中”，最后自己弹 Connection timeout。
// 这里给“拿到响应头”这一步单独设一个超时：超时就当成该线路不可用（合成 504），
// 交给上层立刻换下一条线路。响应头一到达就清掉定时器，真正的响应体流式传输
// 不受影响，不会把一个大文件的正常播放中途掐断。
const MEDIA_UPSTREAM_HEADERS_TIMEOUT_MS = 6000;
// 合成超时响应用的标记头：带上它表示“是我们主动放弃的”，
// 上层据此跳过 5xx 立即重试，避免又多等一个超时周期。
const MEDIA_UPSTREAM_TIMEOUT_HEADER = "x-catemby-upstream-timeout";
// 一次播放请求在“拿到上游响应头”之前允许消耗的总时间。多线路时逐条换线，
// 但总时间必须有界，否则线路全部挂起时客户端早就自己超时了。
const STREAM_HEADERS_BUDGET_MS = 20000;
const REMOTE_MEDIA_DEFINITIVE_FAILURE_STATUSES = new Set([
  401,
  403,
  404,
  410,
  429,
]);
// 修改播放源结构或解析回退逻辑后提升缓存版本，避免已经缓存成“只有一条”的旧结果继续命中。
const RESOLVE_VIDEO_CACHE_VERSION = "sources-v37";
const MEDIA_SEGMENT_CACHE_MAX_AGE_SECONDS = 90;
const MEDIA_SEGMENT_PREFIX_ADJUSTED_HEADER = "x-emby-ts-prefix-adjusted";
const DEFAULT_PAGE_SIZE = 1000;
const HOME_SOURCE_PAGE_SIZE = 50;
const HOME_MAX_SOURCE_PAGES = 40;
// 上游 /v2/search 会遵守 limit（实测 limit=20 → 每页 20 条；limit=50 → 每页 50 条），
// 但最多只翻到第 20 页左右，所以“每页条数”直接决定能搜到的总量。
// 原先用 20：单库最多 ~19 页 ×20 ≈ 380 条（“母亲”“母”只有 300 多条的根因）。
// 改成 50 后单库最多 ~19 页 ×50 = 950 条，恢复客户端以前看到的数量级。
const SEARCH_SOURCE_PAGE_SIZE = 50;
// 上游在第 20 页（limit=50 时）会返回空页，循环会自然结束；给一个宽松上界即可。
const SEARCH_MAX_SOURCE_PAGES = 40;
// 详情页“艺术图（Backdrop）”最多暴露多少张图（含固定排在第一位的资源封面）。
const BACKDROP_IMAGE_LIMIT = 20;
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
      "expires": "0",
      "pragma": "no-cache",
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

function temporaryPlaybackResponse(message, retryAfterSeconds = 1) {
  return jsonResponse({
    error: message,
    ErrorCode: "ServiceUnavailable",
    Message: message,
  }, 503, {
    "retry-after": String(Math.max(1, Math.floor(Number(retryAfterSeconds) || 1))),
    "x-emby-retryable": "1",
  });
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
  const configured = String(env.JAVSTRM_RESOLVE_PATH || "").trim();
  if (configured) {
    return configured.startsWith("/") ? configured : `/${configured}`;
  }
  const value = env.JAVSTRM_ORIGIN
    ? DEFAULT_RESOLVER_RESOLVE_PATH
    : PUBLIC_RESOLVER_RESOLVE_PATH;
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

// 一条解析线路算不算“已经拿到可用播放源”：
// 1) 绝对 URL 或上游根相对路径，走 safeMediaUrl 统一做协议与媒体主机白名单
//    校验，避免把相对地址误判为需要启动自建回退；
// 2) data: 内联 HLS 清单。上游（服务器tiful / 服务器GG）经常把整份 m3u8
//    内联成 data: URI 返回，这种线路本身可以直接播放，必须算作可用线路。
//    旧实现只认 http(s)，于是“上游三份线路全是内联 HLS”的片子（RCTD-740）
//    在这里被判成 0 条可用线路，详情页直接回落到占位源，客户端首屏就只剩
//    “自动线路”。
// 注意：这里只判断“是不是一份能解析出线路的清单”，真正的伪 HLS（分片是
// 图片/字体）仍由 validatedResolvedVideo 在收尾时按分片内容剔除。
function resolverPayloadItemIsPlayable(item, env) {
  const raw = sourceUrlValue(item);
  return Boolean(safeMediaUrl(raw, env)) || Boolean(decodeInlineHls(raw));
}

function resolverPayloadHasUsableSource(payload, env) {
  return sourceVariants(payload).some((item) =>
    resolverPayloadItemIsPlayable(item, env));
}

function resolverPayloadUsableSourceCount(payload, env) {
  const seen = new Set();
  for (const item of sourceVariants(payload)) {
    const sourceUrl = safeMediaUrl(sourceUrlValue(item), env);
    if (sourceUrl) {
      seen.add(sourceUrl.toString());
      continue;
    }
    if (decodeInlineHls(sourceUrlValue(item))) {
      // 内联清单可能有好几 MB，用长度 + 首尾片段的 md5 作为身份，
      // 避免为去重把整份清单塞进 Set（CPU / 内存都吃不消）。
      seen.add(canonicalResolverSource(item));
    }
  }
  return seen.size;
}

function canonicalResolverSource(item) {
  const raw = String(sourceUrlValue(item) || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:")) {
    // 内联清单可能有数 MB，不能为了去重对整个字符串做 md5（会同步吃满
    // Worker CPU）。长度 + 首尾片段足以区分不同资源，且是轻量常量级开销。
    const length = raw.length;
    const prefix = raw.slice(0, 96);
    const suffix = raw.slice(-96);
    return `data:${length}:${md5(`${length}|${prefix}|${suffix}`)}`;
  }
  try {
    const url = new URL(raw);
    url.hash = "";
    const search = [...url.searchParams.entries()].sort(([left], [right]) =>
      left.localeCompare(right));
    url.search = "";
    for (const [name, value] of search) {
      url.searchParams.append(name, value);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function resolverVariantKey(item) {
  const source = canonicalResolverSource(item);
  const variant = String(item?.variant || item?.name || item?.id || "")
    .trim()
    .toLowerCase();
  const label = String(item?.label || item?.displayName || "").trim().toLowerCase();
  if (source) {
    // 同一线路名可能由多个来源返回，不能只按 original/reducing 等名称去重；
    // URL 相同且名称也相同才算重复，保留不同 CDN 的真实备用线路。
    return `source:${source}|variant:${variant}|label:${label}`;
  }
  if (variant) {
    return `variant:${variant}`;
  }
  return label ? `label:${label}` : "";
}

function mergeResolverVariants(payloads) {
  const variants = [];
  const seen = new Set();
  payloads.forEach((payload, payloadIndex) => {
    sourceVariants(payload).forEach((item, itemIndex) => {
      const key = resolverVariantKey(item) ||
        `payload:${payloadIndex}:item:${itemIndex}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      variants.push(item);
    });
  });
  return variants;
}

// 解析器偶发把图片 CDN URL 伪装成 HLS 分片（伪 HLS）。这类线路能返回 200
// 的清单，但客户端加载分片后无法解码，表现就是“一直加载中”。
// 只按明确的图片 / 字体资源路径过滤，不能按整个 CDN 域名封禁：同一 CDN
// 也可能承载无扩展名的真实媒体分片。
const INLINE_HLS_SEGMENT_PATTERN = /\.(?:ts|m4s|mp4|aac|m4a)(?:[?#]|$)/i;
const GOOGLE_DRIVE_MEDIA_PATH_PATTERN = /^\/d\/[^/?#]+=d(?:[?#]|$)/i;
const HLS_EMBEDDED_TS_IMAGE_PATTERN = /\.image(?:[?#]|$)/i;
const INLINE_HLS_RESOURCE_PATTERN =
  /[/_.-](?:thumb|cover|css|js)(?:[?#]|$)|[?&](?:contentType|response-content-type)=image\//i;
const HLS_FONT_RESOURCE_PATTERN = /\.(?:woff2?|ttf|otf)(?:[?#]|$)/i;
const HLS_IMAGE_RESOURCE_PATTERN = /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:[?#]|$)/i;
const HLS_AES_KEY_LENGTH = 16;
const HLS_AES_BLOCK_LENGTH = 16;

function hlsPathLooksLikeMediaSegment(pathname) {
  return INLINE_HLS_SEGMENT_PATTERN.test(pathname) ||
    GOOGLE_DRIVE_MEDIA_PATH_PATTERN.test(pathname) ||
    HLS_FONT_RESOURCE_PATTERN.test(pathname) ||
    HLS_EMBEDDED_TS_IMAGE_PATTERN.test(pathname);
}

function hlsPathLooksLikeNonVideo(pathname, search = "") {
  return HLS_IMAGE_RESOURCE_PATTERN.test(pathname) ||
    INLINE_HLS_RESOURCE_PATTERN.test(`${pathname}${search}`);
}

function absoluteHlsUri(value, baseUrl) {
  try {
    return new URL(String(value || "").trim(), baseUrl).toString();
  } catch {
    return "";
  }
}

function hlsUriLooksLikeNonVideo(value, baseUrl) {
  const uri = absoluteHlsUri(value, baseUrl);
  if (!uri) return true;
  try {
    const url = new URL(uri);
    return hlsPathLooksLikeNonVideo(url.pathname, url.search);
  } catch {
    return true;
  }
}

function hlsUriLooksLikeMediaSegment(value, baseUrl) {
  const uri = absoluteHlsUri(value, baseUrl);
  if (!uri) return false;
  try {
    const url = new URL(uri);
    return hlsPathLooksLikeMediaSegment(url.pathname);
  } catch {
    return false;
  }
}

function bytesLookLikeFont(bytes) {
  const signatures = [
    [0x77, 0x4f, 0x46, 0x32], // wOF2
    [0x77, 0x4f, 0x46, 0x46], // wOFF
    [0x4f, 0x54, 0x54, 0x4f], // OTTO
    [0x74, 0x72, 0x75, 0x65], // true
    [0x74, 0x74, 0x63, 0x66], // ttcf
    [0x00, 0x01, 0x00, 0x00],
  ];
  return signatures.some((signature) => bytesStartWith(bytes, signature));
}

function embeddedMpegTsOffset(bytes) {
  if (!bytes?.length) return -1;
  const scanEnd = Math.min(bytes.length - 1, REMOTE_MEDIA_PROBE_BYTES - 1);
  for (let offset = 0; offset <= scanEnd; offset += 1) {
    if (bytes[offset] !== 0x47) continue;
    if (offset > 0) {
      // A PNG/JPEG prefix can contain arbitrary bytes. Require a full TS
      // packet train before accepting a non-zero offset.
      if (
        offset + 376 >= bytes.length ||
        bytes[offset + 188] !== 0x47 ||
        bytes[offset + 376] !== 0x47
      ) {
        continue;
      }
    } else {
      if (
        offset + 188 < bytes.length &&
        bytes[offset + 188] !== 0x47
      ) {
        continue;
      }
      if (
        offset + 376 < bytes.length &&
        bytes[offset + 376] !== 0x47
      ) {
        continue;
      }
    }
    return offset;
  }
  return -1;
}

function bytesLookLikeMpegTs(bytes) {
  return embeddedMpegTsOffset(bytes) >= 0;
}

function responseLooksLikeTextDocument(bytes) {
  const prefix = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 64))
    .trimStart()
    .toLowerCase();
  return prefix.startsWith("<!doctype") || prefix.startsWith("<html") ||
    prefix.startsWith("{") || prefix.startsWith("[");
}

function parseHlsAttributeList(value) {
  const source = String(value || "");
  const attributes = {};
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /[\s,]/.test(source[index])) index += 1;
    const nameStart = index;
    while (index < source.length && source[index] !== "=" && source[index] !== ",") {
      index += 1;
    }
    const name = source.slice(nameStart, index).trim().toUpperCase();
    if (!name || source[index] !== "=") {
      while (index < source.length && source[index] !== ",") index += 1;
      if (source[index] === ",") index += 1;
      continue;
    }
    index += 1;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    let attributeValue = "";
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      const valueStart = index;
      while (index < source.length && source[index] !== quote) index += 1;
      attributeValue = source.slice(valueStart, index);
      if (source[index] === quote) index += 1;
    } else {
      const valueStart = index;
      while (index < source.length && source[index] !== ",") index += 1;
      attributeValue = source.slice(valueStart, index).trim();
    }
    attributes[name] = attributeValue;
    if (source[index] === ",") index += 1;
  }
  return attributes;
}

function hlsMediaSequence(playlist) {
  const match = /^#EXT-X-MEDIA-SEQUENCE:(\d+)\s*$/mi.exec(String(playlist || ""));
  const value = Number(match?.[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function hlsSequenceIv(sequence) {
  const iv = new Uint8Array(HLS_AES_BLOCK_LENGTH);
  let value = BigInt(Math.max(0, Math.floor(Number(sequence) || 0)));
  for (let index = iv.length - 1; index >= 0; index -= 1) {
    iv[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return iv;
}

function hlsIvFromHex(value) {
  const normalized = String(value || "").trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]{32}$/i.test(normalized)) return null;
  return Uint8Array.from(
    normalized.match(/.{2}/g),
    (byte) => Number.parseInt(byte, 16),
  );
}

async function decryptHlsAes128FirstBlock(
  encryptedBlock,
  keyContext,
  sequence,
) {
  // WebCrypto AES-CBC always removes PKCS#7 padding. A lone 16-byte block can
  // therefore fail even when it decrypts correctly. Build one synthetic final
  // block containing valid padding so WebCrypto returns only the real first
  // block, without trusting that block's last byte as padding.
  const key = await crypto.subtle.importKey(
    "raw",
    keyContext.keyBytes,
    { name: "AES-CBC" },
    false,
    ["decrypt", "encrypt"],
  );
  const iv = keyContext.explicitIv || hlsSequenceIv(sequence);
  const paddingBlock = new Uint8Array(HLS_AES_BLOCK_LENGTH).fill(
    HLS_AES_BLOCK_LENGTH,
  );
  const syntheticTail = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: "AES-CBC",
      iv: encryptedBlock,
    },
    key,
    paddingBlock,
  )).subarray(0, HLS_AES_BLOCK_LENGTH);
  const encrypted = new Uint8Array(HLS_AES_BLOCK_LENGTH * 2);
  encrypted.set(encryptedBlock, 0);
  encrypted.set(syntheticTail, HLS_AES_BLOCK_LENGTH);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    {
      name: "AES-CBC",
      iv,
    },
    key,
    encrypted,
  ));
  return plaintext.length === HLS_AES_BLOCK_LENGTH ? plaintext : null;
}

function remoteHlsValidationExpiredError() {
  const error = new Error("Remote HLS validation budget exhausted");
  error.code = "REMOTE_HLS_VALIDATION_EXPIRED";
  return error;
}

function isRemoteHlsValidationExpired(error) {
  return error?.code === "REMOTE_HLS_VALIDATION_EXPIRED";
}

function remoteHlsValidationBudget(deadline) {
  return {
    deadline: Math.max(0, Number(deadline) || 0),
    remaining: REMOTE_HLS_PROBE_BUDGET,
  };
}

async function fetchRemoteHlsResponse(url, fetchImpl, options = {}) {
  const headers = new Headers({
    accept: options.accept ||
      "application/vnd.apple.mpegurl,application/x-mpegurl,video/*,*/*;q=0.8",
    "user-agent": "Mozilla/5.0",
  });
  headers.set(
    "referer",
    mediaProxyRefererForSource(url, "https://www.javdb.com/"),
  );
  if (options.range) {
    headers.set("range", `bytes=0-${REMOTE_MEDIA_PROBE_BYTES - 1}`);
  }
  const timeoutMs = remainingRequestMs(
    options.budget?.deadline,
    REMOTE_HLS_PROBE_TIMEOUT_MS,
  );
  if (timeoutMs <= 0) {
    throw remoteHlsValidationExpiredError();
  }
  return fetchWithTimeout(
    fetchImpl,
    url,
    { headers, redirect: "follow" },
    timeoutMs,
  );
}

async function fetchRemoteHlsAesKey(url, fetchImpl, budget) {
  if (!budget || budget.remaining <= 0) {
    throw remoteHlsValidationExpiredError();
  }
  budget.remaining -= 1;
  try {
    const response = await fetchRemoteHlsResponse(url, fetchImpl, {
      accept: "application/octet-stream,*/*;q=0.8",
      budget,
    });
    if (!response?.ok) return null;
    const keyBytes = new Uint8Array(await response.arrayBuffer());
    return keyBytes.length === HLS_AES_KEY_LENGTH ? keyBytes : null;
  } catch (error) {
    if (isRemoteHlsValidationExpired(error)) throw error;
    return null;
  }
}

async function hlsKeyContextFromTag(
  line,
  baseUrl,
  fetchImpl,
  budget,
) {
  const attributes = parseHlsAttributeList(
    String(line || "").replace(/^#EXT-X-KEY:/i, ""),
  );
  const method = String(attributes.METHOD || "").trim().toUpperCase();
  if (method === "NONE") {
    return { key: null };
  }
  if (method !== "AES-128" || !attributes.URI) {
    return { invalid: true };
  }
  const keyUrl = absoluteHlsUri(attributes.URI, baseUrl);
  if (!keyUrl) {
    return { invalid: true };
  }
  let explicitIv = null;
  if (attributes.IV) {
    explicitIv = hlsIvFromHex(attributes.IV);
    if (!explicitIv) {
      return { invalid: true };
    }
  }
  const keyBytes = await fetchRemoteHlsAesKey(keyUrl, fetchImpl, budget);
  if (!keyBytes) {
    return { invalid: true };
  }
  return {
    key: {
      method: "AES-128",
      keyBytes,
      explicitIv,
    },
  };
}

async function hlsPlaylistMediaEntries(
  playlist,
  baseUrl,
  fetchImpl,
  budget,
  inheritedKey = null,
) {
  const text = String(playlist || "");
  const entries = [];
  let activeKey = inheritedKey;
  let sequence = hlsMediaSequence(text);
  const scanEnd = Math.min(text.length, HLS_PLAYLIST_SCAN_MAX_CHARS);
  let lineStart = 0;
  let linesScanned = 0;
  let truncated = scanEnd < text.length;
  while (
    lineStart < scanEnd &&
    linesScanned < HLS_PLAYLIST_SCAN_MAX_LINES
  ) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 || newline > scanEnd ? scanEnd : newline;
    const line = text.slice(lineStart, lineEnd).trim();
    lineStart = newline === -1 || newline >= scanEnd ? scanEnd : newline + 1;
    linesScanned += 1;
    if (!line) {
      continue;
    }
    if (/^#EXT-X-KEY:/i.test(line)) {
      const resolved = await hlsKeyContextFromTag(
        line,
        baseUrl,
        fetchImpl,
        budget,
      );
      if (resolved.invalid) {
        return { entries: null, truncated };
      }
      activeKey = resolved.key;
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    const uri = absoluteHlsUri(line, baseUrl);
    if (!uri) {
      return { entries: null, truncated };
    }
    entries.push({
      uri,
      key: activeKey,
      sequence,
    });
    sequence += 1;
  }
  // 扫描被行数/字符数上限截断时，剩余内容没有看过，标记 truncated 交由
  // 调用方降级为“未验证”，避免把有效线路误判为坏源。
  if (lineStart < text.length) {
    truncated = true;
  }
  return { entries, truncated };
}

async function probeRemoteHlsSegment(
  url,
  fetchImpl,
  budget,
  keyContext = null,
  sequence = 0,
) {
  if (budget.remaining <= 0) return true;
  budget.remaining -= 1;
  try {
    const response = await fetchRemoteHlsResponse(url, fetchImpl, {
      range: true,
      budget,
    });
    if (!response?.ok) return false;
    const bytes = new Uint8Array(await response.arrayBuffer())
      .subarray(0, REMOTE_MEDIA_PROBE_BYTES);
    if (!bytes.length) return false;
    if (keyContext?.method === "AES-128") {
      const encryptedBlock = bytes.subarray(0, HLS_AES_BLOCK_LENGTH);
      if (encryptedBlock.length !== HLS_AES_BLOCK_LENGTH) return false;
      try {
        const plaintext = await decryptHlsAes128FirstBlock(
          encryptedBlock,
          keyContext,
          sequence,
        );
        return plaintext.length > 0 && plaintext[0] === 0x47;
      } catch {
        return false;
      }
    }
    if (bytesLookLikeMpegTs(bytes)) return true;
    if (bytesLookLikeFont(bytes) || sniffImageContentType(bytes)) return false;
    if (responseLooksLikeTextDocument(bytes)) return false;
    return true;
  } catch {
    // A transient network failure is not evidence that an otherwise valid
    // source is fake. Keep it and let the player decide.
    return true;
  }
}

async function validateHlsPlaylistSource(
  playlist,
  baseUrl,
  fetchImpl,
  budget,
  depth = 0,
  inheritedKey = null,
) {
  if (!String(playlist || "").trimStart().startsWith("#EXTM3U")) {
    return false;
  }
  const { entries, truncated } = await hlsPlaylistMediaEntries(
    playlist,
    baseUrl,
    fetchImpl,
    budget,
    inheritedKey,
  );
  if (!entries) return false;
  // 清单被扫描上限截断且前段没有任何可探测条目时，无法证明它是坏源，
  // 按未验证保留（fail-open）。
  if (!entries.length) return truncated;

  let attemptedSegment = false;
  const childEntries = [];
  for (const entry of entries) {
    if (hlsUriLooksLikeNonVideo(entry.uri, baseUrl)) {
      continue;
    }
    if (hlsUriLooksLikeMediaSegment(entry.uri, baseUrl)) {
      attemptedSegment = true;
      if (await probeRemoteHlsSegment(
        entry.uri,
        fetchImpl,
        budget,
        entry.key,
        entry.sequence,
      )) {
        return true;
      }
      continue;
    }
    childEntries.push(entry);
  }

  // 截断的清单里，前缀分片探测失败不足以否定整条线路，按未验证保留。
  if (attemptedSegment) return truncated;
  if (budget.remaining <= 0 || depth >= REMOTE_HLS_PROBE_DEPTH) {
    return true;
  }
  for (const entry of childEntries.slice(0, 2)) {
    if (await validateRemoteHlsPlaylist(
      entry.uri,
      fetchImpl,
      budget,
      depth + 1,
      entry.key,
    )) {
      return true;
    }
  }
  // 子清单都探测失败时，若清单本身已被截断，剩余子清单可能仍可播放，
  // 同样降级为未验证保留，而不是直接剔除线路。
  return truncated;
}

async function validateRemoteHlsPlaylist(
  url,
  fetchImpl,
  budget,
  depth = 0,
  inheritedKey = null,
) {
  if (budget.remaining <= 0) return true;
  budget.remaining -= 1;

  let response;
  try {
    response = await fetchRemoteHlsResponse(url, fetchImpl, { budget });
  } catch {
    return true;
  }
  if (!response?.ok) return false;

  let playlist;
  try {
    playlist = await response.text();
  } catch {
    return true;
  }
  return validateHlsPlaylistSource(
    playlist,
    url,
    fetchImpl,
    budget,
    depth,
    inheritedKey,
  );
}

function remoteHlsVariant(variant) {
  if (!variant) return false;
  if (variant.inlinePlaylist) return true;
  if (!variant.sourceUrl) return false;
  return /mpegurl|m3u8/i.test(`${variant.sourceType || ""} ${variant.sourceUrl || ""}`);
}

async function httpMediaVariantLooksPlayable(variant, fetchImpl, budget) {
  if (!variant?.sourceUrl) return true;
  let response;
  try {
    response = await fetchRemoteHlsResponse(
      variant.sourceUrl,
      fetchImpl,
      {
        accept:
          "video/*,application/vnd.apple.mpegurl,application/x-mpegurl," +
          "application/octet-stream;q=0.9,*/*;q=0.5",
        range: true,
        budget,
      },
    );
  } catch {
    // A transient DNS / TLS / timeout failure is not enough evidence to drop
    // a source that the resolver advertised.
    return true;
  }
  if (!response) return true;
  if (REMOTE_MEDIA_DEFINITIVE_FAILURE_STATUSES.has(response.status)) {
    return false;
  }
  if (!response.ok) return true;
  const mediaFailure = String(
    response.headers.get("x-media-failure") || "",
  ).toLowerCase();
  if (
    mediaFailure.includes("metadata_invalid_reference") ||
    mediaFailure.includes("invalid_reference")
  ) {
    return false;
  }

  const contentType = String(response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (
    contentType === "text/html" ||
    contentType === "application/xhtml+xml" ||
    contentType === "application/json" ||
    contentType.endsWith("+json")
  ) {
    return false;
  }

  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer())
      .subarray(0, REMOTE_MEDIA_PROBE_BYTES);
  } catch {
    return true;
  }
  if (!bytes.length) return false;
  // GG 的媒体 CDN 会把 MPEG-TS 藏在 PNG 文件头后面，并且返回 image/png。
  // 必须先检查 TS 包，再按普通图片/字体内容做拒绝。
  if (bytesLookLikeMpegTs(bytes)) return true;
  if (contentType.startsWith("image/")) return false;
  if (sniffImageContentType(bytes) || bytesLookLikeFont(bytes)) return false;
  if (responseLooksLikeTextDocument(bytes)) return false;
  return true;
}

async function videoVariantLooksPlayable(variant, fetchImpl, budget) {
  if (!remoteHlsVariant(variant)) {
    return httpMediaVariantLooksPlayable(variant, fetchImpl, budget);
  }
  if (variant.inlinePlaylist) {
    return validateHlsPlaylistSource(
      variant.inlinePlaylist,
      "https://inline.invalid/",
      fetchImpl,
      budget,
    );
  }
  return validateRemoteHlsPlaylist(
    variant.sourceUrl,
    fetchImpl,
    budget,
  );
}

async function validatedVideoVariants(
  video,
  fetchImpl,
  budgetMs = REMOTE_HLS_VALIDATION_BUDGET_MS,
) {
  const variants = playbackVariants(video);
  if (!variants.length) return [];
  const deadline = Date.now() +
    Math.max(1, Number(budgetMs) || REMOTE_HLS_VALIDATION_BUDGET_MS);

  const results = new Array(variants.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(REMOTE_HLS_VARIANT_CONCURRENCY, variants.length) },
    async () => {
      while (nextIndex < variants.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await videoVariantLooksPlayable(
            variants[index],
            fetchImpl,
            remoteHlsValidationBudget(deadline),
          );
        } catch (error) {
          // 预算耗尽（REMOTE_HLS_VALIDATION_EXPIRED）或任何探测异常都按
          // “未验证”保留线路（fail-open）。否则一条慢 CDN 会让整个
          // PlaybackInfo 抛错，客户端表现为 Connection timeout / 503。
          if (!isRemoteHlsValidationExpired(error)) {
            // 保留一个可观测信号，便于线上排查，但不影响返回。
            console.warn?.("variant validation failed", error?.message || error);
          }
          results[index] = true;
        }
      }
    },
  );
  await Promise.all(workers);
  const playable = variants.filter((_, index) => results[index]);
  assignUniqueSourceNames(playable);
  return playable;
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

// 多条线路复用同一个上游标签时（例如 4 条 GG 线路都叫“去码版 (服务器GG)”），
// Emby 客户端会按名称把重名源折叠成一条，用户就只看到一个播放源。
// 这里给重名的线路补一个序号，保证每个 MediaSource 名称唯一。
function assignUniqueSourceNames(variants) {
  if (!Array.isArray(variants) || !variants.length) return variants;
  if (variants.length === 1) {
    delete variants[0].sourceName;
    return variants;
  }
  const counts = new Map();
  const bases = variants.map((variant, index) => {
    const base = String(variant?.sourceName || "").trim() ||
      videoVariantLabel(variant, index, variants.length);
    counts.set(base, (counts.get(base) || 0) + 1);
    return base;
  });
  const seen = new Map();
  variants.forEach((variant, index) => {
    const base = bases[index];
    if ((counts.get(base) || 0) > 1) {
      const ordinal = (seen.get(base) || 0) + 1;
      seen.set(base, ordinal);
      variant.sourceName = `${base} · ${ordinal}`;
    } else {
      variant.sourceName = base;
    }
  });
  return variants;
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

function mediaProxyRefererForSource(sourceUrl, fallbackReferer) {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    // GetAV 的媒体 CDN 会对缺少站内 Referer 的请求返回 403。
    if (host === "worldstatic.com" || host.endsWith(".worldstatic.com")) {
      return GETAV_MEDIA_REFERER;
    }
  } catch {}
  return fallbackReferer;
}

function mediaProxyRequestHeaders(request, env, sourceUrl = "", options = {}) {
  const upstream = upstreamOrigin(env);
  const headers = new Headers({
    accept: request.headers.get("accept") ||
      "application/vnd.apple.mpegurl,application/x-mpegurl,video/*,*/*;q=0.8",
    origin: upstream,
    "user-agent": request.headers.get("user-agent") || "Mozilla/5.0",
  });
  headers.set(
    "referer",
    mediaProxyRefererForSource(sourceUrl, `${upstream}/`),
  );
  // HLS 清单必须拿到完整文本，Range/条件请求可能只返回前缀或 304，
  // 后续就无法重写清单中的密钥和分片地址。
  if (!options.hlsManifest) {
    for (const name of ["range", "if-range", "if-none-match", "if-modified-since"]) {
      const value = request.headers.get(name);
      if (value) {
        headers.set(name, value);
      }
    }
  }
  return headers;
}

function requestUsesMediaSegmentCache(request, sourceUrl, options = {}) {
  if (request.method !== "GET") return false;
  const requestUrl = new URL(request.url);
  const kind = String(requestUrl.searchParams.get("kind") || "").toLowerCase();
  if (kind === "key" || kind === "manifest" || kind === "map") {
    return false;
  }
  if (options.hlsManifest) return false;
  if (kind === "segment") return true;

  let pathname = "";
  try {
    pathname = new URL(sourceUrl).pathname;
  } catch {
    return false;
  }
  return /\.(?:ts|m4s|aac|m4a)(?:[?#]|$)/i.test(pathname) ||
    GOOGLE_DRIVE_MEDIA_PATH_PATTERN.test(pathname) ||
    HLS_FONT_RESOURCE_PATTERN.test(pathname) ||
    HLS_EMBEDDED_TS_IMAGE_PATTERN.test(pathname);
}

function mediaSegmentCacheKey(sourceUrl) {
  return `media-segment-v1|${md5(String(sourceUrl || ""))}`;
}

function mediaSegmentNeedsEmbeddedTsNormalization(sourceUrl) {
  let pathname = "";
  try {
    pathname = new URL(sourceUrl).pathname;
  } catch {
    return false;
  }
  return HLS_EMBEDDED_TS_IMAGE_PATTERN.test(pathname);
}

function parseSingleByteRange(value, total) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value).trim());
  if (!match || (!match[1] && !match[2])) {
    return { invalid: true };
  }
  const size = Math.max(0, Math.floor(Number(total) || 0));
  if (size <= 0) return { unsatisfiable: true };

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Math.floor(Number(match[2]) || 0);
    if (suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Math.floor(Number(match[1]) || 0);
    end = match[2] ? Math.floor(Number(match[2]) || 0) : size - 1;
  }
  if (start >= size) return { unsatisfiable: true };
  end = Math.min(end, size - 1);
  if (end < start) return { invalid: true };
  return { start, end };
}

function parseMediaContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(
    String(value || "").trim(),
  );
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    (total !== null && (!Number.isSafeInteger(total) || total <= end))
  ) {
    return null;
  }
  return { start, end, total };
}

function mediaSegmentPrefixMetadata(
  prefixLength,
  upstreamTotal,
  contentType = "video/mp2t",
) {
  const prefix = Math.floor(Number(prefixLength));
  const total = Math.floor(Number(upstreamTotal));
  if (
    !Number.isSafeInteger(prefix) ||
    !Number.isSafeInteger(total) ||
    prefix < 0 ||
    total <= prefix
  ) {
    return null;
  }
  return {
    prefixLength: prefix,
    upstreamTotal: total,
    contentType: contentType || "video/mp2t",
  };
}

function embeddedTsVirtualRange(value, metadata) {
  const virtualTotal = metadata.upstreamTotal - metadata.prefixLength;
  return parseSingleByteRange(value, virtualTotal);
}

function embeddedTsMappedRange(range, metadata) {
  return `bytes=${range.start + metadata.prefixLength}-${
    range.end + metadata.prefixLength
  }`;
}

function embeddedTsRangeResponse(body, metadata, range) {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "no-store",
    "content-length": String(body.byteLength),
    "content-range": `bytes ${range.start}-${range.end}/${
      metadata.upstreamTotal - metadata.prefixLength
    }`,
    "content-type": metadata.contentType || "video/mp2t",
    [MEDIA_SEGMENT_PREFIX_ADJUSTED_HEADER]: "1",
  });
  return new Response(body, {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

function embeddedTsMappedResponse(upstream, metadata, range) {
  if (!upstream.body || upstream.headers.has("content-encoding")) {
    return null;
  }
  const headers = new Headers();
  for (const name of [
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "no-store");
  headers.set("content-length", String(range.end - range.start + 1));
  headers.set(
    "content-range",
    `bytes ${range.start}-${range.end}/${
      metadata.upstreamTotal - metadata.prefixLength
    }`,
  );
  headers.set("content-type", metadata.contentType || "video/mp2t");
  headers.set(MEDIA_SEGMENT_PREFIX_ADJUSTED_HEADER, "1");
  return new Response(upstream.body, {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

function normalizedMediaSegmentBytes(bytes, contentType = "") {
  const embeddedOffset = embeddedMpegTsOffset(bytes);
  if (embeddedOffset < 0) {
    return {
      bytes,
      contentType,
      embedded: false,
    };
  }
  return {
    bytes: embeddedOffset > 0 ? bytes.slice(embeddedOffset) : bytes,
    contentType: "video/mp2t",
    embedded: true,
  };
}

function mediaRecordResponse(record, request) {
  if (!record?.bytes) return null;
  const headers = new Headers();
  for (const [name, value] of record.headers || []) {
    headers.set(name, value);
  }
  headers.set("content-length", String(record.bytes.byteLength));
  if (record.contentRange) {
    headers.set("content-range", record.contentRange);
  } else {
    headers.delete("content-range");
  }
  return new Response(record.bytes, {
    status: record.status || 200,
    statusText: record.statusText || "OK",
    headers,
  });
}

async function bufferMediaSegmentResponse(upstream, sourceUrl) {
  const originalContentType = String(
    upstream.headers.get("content-type") || "",
  ).split(";")[0].trim().toLowerCase();

  const bytes = new Uint8Array(await upstream.arrayBuffer());
  const embeddedOffset = embeddedMpegTsOffset(bytes);
  const normalized = normalizedMediaSegmentBytes(bytes, originalContentType);
  let pathname = "";
  try {
    pathname = new URL(sourceUrl).pathname;
  } catch {}
  const imageCandidate = originalContentType.startsWith("image/") ||
    HLS_EMBEDDED_TS_IMAGE_PATTERN.test(pathname);

  const headers = new Headers();
  for (const name of [
    "accept-ranges",
    "content-type",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("content-length", String(bytes.byteLength));
  headers.set(
    "content-type",
    normalized.contentType || originalContentType || "application/octet-stream",
  );
  const upstreamContentRange = upstream.headers.get("content-range") || "";
  const contentRange = normalized.embedded && upstreamContentRange
    ? adjustedContentRangeAfterPrefix(
      upstreamContentRange,
      embeddedOffset,
      normalized.bytes.byteLength,
    )
    : upstreamContentRange;
  if (!normalized.embedded) {
    for (const name of ["etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
  }
  headers.set("accept-ranges", "bytes");

  // 只有完整的 200 响应才能作为本地断点续传缓存；真实图片、错误响应和
  // 上游自行返回的 206 仍原样返回，避免把 PNG 前缀当成完整视频分片。
  const rangeable = upstream.ok &&
    upstream.status === 200 &&
    !(imageCandidate && !normalized.embedded);
  const cacheable = rangeable &&
    bytes.byteLength > 0 &&
    bytes.byteLength <= MAX_CACHED_MEDIA_SEGMENT_BYTES;

  return {
    record: {
      bytes: normalized.bytes,
      headers: [...headers.entries()],
      status: upstream.status,
      statusText: upstream.statusText,
      contentRange,
      rangeable,
    },
    cacheable,
    embeddedOffset,
    originalContentType,
  };
}

async function readMediaResponsePrefix(upstream, maxBytes) {
  const limit = Math.max(1, Math.floor(Number(maxBytes) || 0));
  if (!upstream.body) {
    return { bytes: new Uint8Array(), complete: true };
  }
  const reader = upstream.body.getReader();
  const chunks = [];
  let total = 0;
  let complete = false;
  try {
    while (total < limit) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        break;
      }
      const chunk = result.value instanceof Uint8Array
        ? result.value
        : new Uint8Array(result.value);
      const remaining = limit - total;
      if (chunk.byteLength > remaining) {
        chunks.push(chunk.slice(0, remaining));
        total += remaining;
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    if (!complete) {
      try {
        await reader.cancel();
      } catch {}
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, complete };
}

function responseFromBufferedBytes(upstream, bytes) {
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.set("content-length", String(bytes.byteLength));
  return new Response(bytes, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function mediaSegmentRecordHeaders(upstream, byteLength) {
  const headers = new Headers();
  for (const name of [
    "accept-ranges",
    "content-type",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("content-length", String(byteLength));
  headers.set("accept-ranges", "bytes");
  return headers;
}

function mediaSegmentRecordForBytes(upstream, bytes) {
  const headers = mediaSegmentRecordHeaders(upstream, bytes.byteLength);
  return {
    bytes,
    headers: [...headers.entries()],
    status: upstream.status,
    statusText: upstream.statusText,
    rangeable: true,
  };
}

function streamCompleteMediaSegmentResponse(upstream, cacheKey) {
  if (
    upstream.status !== 200 ||
    !upstream.body ||
    upstream.headers.has("content-encoding")
  ) {
    return null;
  }
  const contentLength = Number(upstream.headers.get("content-length"));
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return null;
  }
  if (contentLength > MAX_CACHED_MEDIA_SEGMENT_BYTES) {
    return upstream;
  }

  const cacheBytes = new Uint8Array(contentLength);
  let cacheOffset = 0;
  let cacheComplete = true;
  const reader = upstream.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      let result;
      try {
        result = await reader.read();
      } catch (error) {
        controller.error(error);
        return;
      }
      if (result.done) {
        if (cacheComplete && cacheOffset === cacheBytes.byteLength) {
          MEDIA_SEGMENT_BODY_CACHE.write(
            cacheKey,
            mediaSegmentRecordForBytes(upstream, cacheBytes),
          );
        }
        controller.close();
        return;
      }
      const chunk = result.value instanceof Uint8Array
        ? result.value
        : new Uint8Array(result.value);
      if (cacheComplete) {
        if (cacheOffset + chunk.byteLength <= cacheBytes.byteLength) {
          cacheBytes.set(chunk, cacheOffset);
          cacheOffset += chunk.byteLength;
        } else {
          cacheComplete = false;
        }
      }
      controller.enqueue(chunk);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: mediaProxyResponseHeaders(upstream),
  });
}

function cachedMediaSegmentResponse(record, request) {
  if (!record?.bytes) return null;
  const headers = new Headers(record.headers || []);
  headers.set("accept-ranges", "bytes");
  const rangeHeader = request.headers.get("range");
  if (!rangeHeader || record.rangeable === false || record.status !== 200) {
    return mediaRecordResponse(record, request);
  }

  const range = parseSingleByteRange(rangeHeader, record.bytes.byteLength);
  // Malformed or unsupported ranges are allowed to fall back to the complete
  // representation. An empty response here would make the player abandon an
  // otherwise valid segment.
  if (!range || range.invalid) return mediaRecordResponse(record, request);
  if (range.unsatisfiable) {
    headers.set("content-range", `bytes */${record.bytes.byteLength}`);
    headers.set("content-length", "0");
    return new Response(null, {
      status: 416,
      statusText: "Range Not Satisfiable",
      headers,
    });
  }
  const body = record.bytes.slice(range.start, range.end + 1);
  headers.set(
    "content-range",
    `bytes ${range.start}-${range.end}/${record.bytes.byteLength}`,
  );
  headers.set("content-length", String(body.byteLength));
  headers.set("cache-control", "no-store");
  return new Response(body, {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

async function fetchMediaUpstreamResponse(
  request,
  sourceUrl,
  env,
  fetchImpl,
  options = {},
) {
  const headers = mediaProxyRequestHeaders(request, env, sourceUrl, options);
  const usesMediaSegmentCache = requestUsesMediaSegmentCache(
    request,
    sourceUrl,
    options,
  );
  const needsEmbeddedTsNormalization =
    mediaSegmentNeedsEmbeddedTsNormalization(sourceUrl);
  const headersTimeoutMs = positiveEnvMilliseconds(
    env,
    "MEDIA_UPSTREAM_HEADERS_TIMEOUT_MS",
    MEDIA_UPSTREAM_HEADERS_TIMEOUT_MS,
  );
  const headersDeadline = Number(options.headersDeadline) > 0
    ? Number(options.headersDeadline)
    : 0;
  const upstreamTimeoutResponse = () => new Response(null, {
    status: 504,
    statusText: "Gateway Timeout",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      [MEDIA_UPSTREAM_TIMEOUT_HEADER]: "1",
    },
  });
  const fetchUpstream = async (requestHeaders = headers) => {
    const budgetMs = headersDeadline > 0
      ? Math.min(headersTimeoutMs, headersDeadline - Date.now())
      : headersTimeoutMs;
    if (budgetMs <= 0) {
      // 本次播放请求的“响应头预算”已经用完：不要再发起注定超时的请求，
      // 直接告诉上层这条线路不可用，让它换线或尽快回错误。
      return upstreamTimeoutResponse();
    }
    try {
      return await fetchWithTimeout(
        fetchImpl,
        sourceUrl,
        {
          method: request.method,
          headers: requestHeaders,
          redirect: "follow",
        },
        budgetMs,
      );
    } catch {
      // 连接被中断、DNS 失败、上游不回响应头 —— 统一按“这条线路不可用”处理。
      return upstreamTimeoutResponse();
    }
  };
  // 上游 CDN 偶发 5xx 时，直接把它转发给播放器会让客户端弹
  // “Playback failed: Could not fetch …”。这里对媒体请求做一次立即重试，
  // 只有连续两次都 5xx 才交给播放器处理。
  const fetchUpstreamWithRetry = async (requestHeaders = headers) => {
    const first = await fetchUpstream(requestHeaders);
    if (
      first.status >= 500 &&
      first.status < 600 &&
      !first.headers.get(MEDIA_UPSTREAM_TIMEOUT_HEADER)
    ) {
      try {
        first.body?.cancel?.();
      } catch {}
      return fetchUpstream(requestHeaders);
    }
    return first;
  };
  if (!usesMediaSegmentCache) {
    return fetchUpstreamWithRetry();
  }

  const cacheKey = mediaSegmentCacheKey(sourceUrl);
  const cached = MEDIA_SEGMENT_BODY_CACHE.read(cacheKey);
  if (cached) {
    const response = cachedMediaSegmentResponse(cached, request);
    if (response) return response;
  }

  if (usesMediaSegmentCache && !needsEmbeddedTsNormalization) {
    if (request.headers.has("range")) {
      // HLS 播放器（含 Android 自带播放器）对同一分片会并发发出多个 Range，
      // 甚至带多线程加速/断点续传对同一分片重复取前缀。旧实现把每个 Range
      // 原样透传给 CDN：同一分片被反复回源，Worker 的 CPU/内存很快被打到
      // Cloudflare 1102（截图中的 “503 error code: 1102”），表现就是播放
      // 一直卡、不断重试。
      // 这里改成“同一分片只合并下载一次完整内容”，缓存后在内存里切片返回，
      // 之后的并发/续传 Range 全部本地命中、不再回源；只有整段体积超过缓存
      // 上限时才回退到直接透传，避免占用过多内存。
      if (
        mediaSegmentRangeBuffersInFlight >=
          MEDIA_SEGMENT_RANGE_BUFFER_CONCURRENCY &&
        !MEDIA_SEGMENT_BODY_CACHE.hasPending(cacheKey)
      ) {
        return fetchUpstreamWithRetry();
      }
      const countsTowardRangeBufferLimit =
        mediaSegmentRangeBuffersInFlight <
        MEDIA_SEGMENT_RANGE_BUFFER_CONCURRENCY;
      if (countsTowardRangeBufferLimit) {
        mediaSegmentRangeBuffersInFlight += 1;
      }
      let buffered;
      try {
        buffered = await MEDIA_SEGMENT_BODY_CACHE.coalesce(
          cacheKey,
          async () => {
            const fullHeaders = new Headers(headers);
            fullHeaders.delete("range");
            const upstream = await fetchUpstreamWithRetry(fullHeaders);
            if (!upstream.ok || upstream.status !== 200) {
              try {
                await upstream.body?.cancel();
              } catch {}
              return null;
            }
            const contentLength = Number(upstream.headers.get("content-length"));
            if (
              Number.isSafeInteger(contentLength) &&
              contentLength > MAX_CACHED_MEDIA_SEGMENT_BYTES
            ) {
              try {
                await upstream.body?.cancel();
              } catch {}
              return null;
            }
            const result = await bufferMediaSegmentResponse(upstream, sourceUrl);
            if (result?.cacheable) {
              MEDIA_SEGMENT_BODY_CACHE.write(cacheKey, result.record);
              return result.record;
            }
            return null;
          },
        );
      } finally {
        if (countsTowardRangeBufferLimit) {
          mediaSegmentRangeBuffersInFlight -= 1;
        }
      }
      if (buffered?.bytes) {
        const response = cachedMediaSegmentResponse(buffered, request);
        if (response) return response;
      }
      return fetchUpstreamWithRetry();
    }
    const upstream = await fetchUpstreamWithRetry();
    const response = streamCompleteMediaSegmentResponse(upstream, cacheKey);
    if (response) return response;
    const result = await bufferMediaSegmentResponse(upstream, sourceUrl);
    if (result?.record) {
      if (result.cacheable) {
        MEDIA_SEGMENT_BODY_CACHE.write(cacheKey, result.record);
      }
      return cachedMediaSegmentResponse(result.record, request);
    }
  }

  const cacheEmbeddedTsResult = (result, upstreamContentRange = "") => {
    if (!result?.record) return result;
    if (result.cacheable) {
      MEDIA_SEGMENT_BODY_CACHE.write(cacheKey, result.record);
    }
    if (result.embeddedOffset >= 0) {
      const upstreamRange = parseMediaContentRange(upstreamContentRange);
      const rawLength = result.record.bytes.byteLength + result.embeddedOffset;
      const upstreamTotal = upstreamRange?.total ?? rawLength;
      const metadata = mediaSegmentPrefixMetadata(
        result.embeddedOffset,
        upstreamTotal,
        "video/mp2t",
      );
      if (metadata) {
        MEDIA_SEGMENT_PREFIX_CACHE.write(cacheKey, metadata);
      }
    }
    return result;
  };

  const bufferFullEmbeddedTsResponse = () =>
    MEDIA_SEGMENT_BODY_CACHE.coalesce(cacheKey, async () => {
      const fullHeaders = new Headers(headers);
      fullHeaders.delete("range");
      const upstream = await fetchUpstreamWithRetry(fullHeaders);
      const result = await bufferMediaSegmentResponse(upstream, sourceUrl);
      return cacheEmbeddedTsResult(
        result,
        upstream.headers.get("content-range") || "",
      );
    });

  const requestedRangeHeader = request.headers.get("range");
  if (!requestedRangeHeader) {
    const result = await bufferFullEmbeddedTsResponse();
    if (result?.record) {
      return cachedMediaSegmentResponse(result.record, request);
    }
    return fetchUpstreamWithRetry();
  }

  let metadata = MEDIA_SEGMENT_PREFIX_CACHE.read(cacheKey);
  let probeBytes = null;
  let probeStatus = 0;
  if (!metadata) {
    const probeHeaders = new Headers(headers);
    probeHeaders.set(
      "range",
      `bytes=0-${Math.max(0, REMOTE_MEDIA_PROBE_BYTES - 1)}`,
    );
    const probe = await fetchUpstreamWithRetry(probeHeaders);
    const probePrefix = await readMediaResponsePrefix(
      probe,
      REMOTE_MEDIA_PROBE_BYTES,
    );
    probeBytes = probePrefix.bytes;
    probeStatus = probe.status;

    const probeOffset = embeddedMpegTsOffset(probeBytes);
    const probeRange = parseMediaContentRange(
      probe.headers.get("content-range") || "",
    );
    const contentLength = Number(probe.headers.get("content-length"));
    const probeComplete = probePrefix.complete ||
      (probe.status === 200 &&
        Number.isSafeInteger(contentLength) &&
        contentLength === probeBytes.byteLength);
    const upstreamTotal = probeRange?.total ??
      (probe.status === 200 && Number.isSafeInteger(contentLength)
        ? contentLength
        : probeComplete
          ? probeBytes.byteLength
          : null);
    const rangeStartsAtZero = !probeRange || probeRange.start === 0;
    if (probeOffset >= 0 && upstreamTotal && rangeStartsAtZero) {
      metadata = mediaSegmentPrefixMetadata(
        probeOffset,
        upstreamTotal,
        "video/mp2t",
      );
      if (metadata) {
        MEDIA_SEGMENT_PREFIX_CACHE.write(cacheKey, metadata);
      }
    }

    if (!metadata) {
      return fetchUpstreamWithRetry();
    }

    if (probe.status === 200 && probeComplete) {
      const result = cacheEmbeddedTsResult(
        await bufferMediaSegmentResponse(
          responseFromBufferedBytes(probe, probeBytes),
          sourceUrl,
        ),
        probe.headers.get("content-range") || "",
      );
      if (result?.record) {
        return cachedMediaSegmentResponse(result.record, request);
      }
    }
  }

  const range = embeddedTsVirtualRange(requestedRangeHeader, metadata);
  if (!range || range.invalid) {
    const result = await bufferFullEmbeddedTsResponse();
    if (result?.record) {
      return cachedMediaSegmentResponse(result.record, request);
    }
    return fetchUpstreamWithRetry();
  }
  if (range.unsatisfiable) {
    return new Response(null, {
      status: 416,
      statusText: "Range Not Satisfiable",
      headers: {
        "accept-ranges": "bytes",
        "content-length": "0",
        "content-range": `bytes */${
          metadata.upstreamTotal - metadata.prefixLength
        }`,
      },
    });
  }

  if (probeBytes && probeStatus === 206) {
    const probeStart = metadata.prefixLength + range.start;
    const probeEnd = metadata.prefixLength + range.end;
    if (
      probeStart >= metadata.prefixLength &&
      probeEnd < probeBytes.byteLength
    ) {
      return embeddedTsRangeResponse(
        probeBytes.slice(probeStart, probeEnd + 1),
        metadata,
        range,
      );
    }
  }

  const mappedHeaders = new Headers(headers);
  mappedHeaders.set("range", embeddedTsMappedRange(range, metadata));
  const mappedUpstream = await fetchUpstreamWithRetry(mappedHeaders);
  const mappedStart = range.start + metadata.prefixLength;
  const mappedEnd = range.end + metadata.prefixLength;
  const mappedRange = parseMediaContentRange(
    mappedUpstream.headers.get("content-range") || "",
  );
  const mappedLength = Number(mappedUpstream.headers.get("content-length"));
  const mappedRangeMatches = !mappedRange ||
    (mappedRange.start === mappedStart && mappedRange.end === mappedEnd);
  const mappedLengthMatches = !Number.isSafeInteger(mappedLength) ||
    mappedLength === range.end - range.start + 1;
  if (
    mappedUpstream.status === 206 &&
    mappedRangeMatches &&
    mappedLengthMatches
  ) {
    const response = embeddedTsMappedResponse(
      mappedUpstream,
      metadata,
      range,
    );
    if (response) return response;
  }

  if (mappedUpstream.status === 200) {
    const result = cacheEmbeddedTsResult(
      await bufferMediaSegmentResponse(mappedUpstream, sourceUrl),
      mappedUpstream.headers.get("content-range") || "",
    );
    if (result?.record) {
      return cachedMediaSegmentResponse(result.record, request);
    }
  } else {
    try {
      await mappedUpstream.body?.cancel();
    } catch {}
  }

  const result = await bufferFullEmbeddedTsResponse();
  if (result?.record) {
    return cachedMediaSegmentResponse(result.record, request);
  }
  return fetchUpstreamWithRetry();
}

function mediaProxyResponseHeaders(upstream, options = {}) {
  const partialResponse = upstream.status === 206 ||
    Boolean(upstream.headers.get("content-range"));
  const cacheableMediaSegment = options.cacheableMediaSegment === true &&
    !partialResponse;
  const headers = new Headers({
    "access-control-allow-origin": "*",
    "access-control-expose-headers":
      "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
    "cache-control": cacheableMediaSegment
      ? `public, max-age=${MEDIA_SEGMENT_CACHE_MAX_AGE_SECONDS}, stale-while-revalidate=30`
      : "no-store",
    "x-content-type-options": "nosniff",
  });
  for (const name of [
    "accept-ranges",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  if (upstream.headers.get(MEDIA_SEGMENT_PREFIX_ADJUSTED_HEADER) === "1") {
    headers.set(MEDIA_SEGMENT_PREFIX_ADJUSTED_HEADER, "1");
  }
  // fetch 通常已经解压响应体；继续转发压缩前的 Content-Length 会让
  // 客户端读到错误长度并卡在播放器缓冲阶段。
  if (!upstream.headers.has("content-encoding")) {
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) {
      headers.set("content-length", contentLength);
    }
  }
  return headers;
}

function hlsRewriteDepth(value) {
  const depth = Math.floor(Number(value));
  if (!Number.isFinite(depth) || depth < 0) return 0;
  return Math.min(MAX_HLS_REWRITE_DEPTH, depth);
}

function isHlsManifestSource(sourceUrl, sourceType = "") {
  if (/mpegurl|m3u8/i.test(String(sourceType || ""))) {
    return true;
  }
  let pathname = "";
  try {
    pathname = new URL(sourceUrl).pathname.toLowerCase();
  } catch {
    pathname = "";
  }
  return /\.m3u8?$/i.test(pathname);
}

function requestTargetsHlsManifest(request, sourceUrl = "") {
  const requestUrl = new URL(request.url);
  const kind = String(requestUrl.searchParams.get("kind") || "").toLowerCase();
  if (kind === "manifest") {
    return true;
  }
  if (kind === "segment" || kind === "key" || kind === "map") {
    return false;
  }
  return isHlsManifestSource(
    sourceUrl,
    requestUrl.searchParams.get("sourceType") || "",
  ) || /\.m3u8?$/i.test(requestUrl.pathname);
}

function hlsProxyUrl(value, baseUrl, requestUrl, depth, options = {}) {
  let target;
  try {
    target = new URL(value, baseUrl);
  } catch {
    return value;
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return value;
  }

  const proxyPath = publicRoutePath(requestUrl, "/emby-media/");
  const proxyUrl = new URL(proxyPath, new URL(requestUrl).origin);
  proxyUrl.searchParams.set("url", target.toString());
  proxyUrl.searchParams.set(
    "depth",
    String(Math.min(MAX_HLS_REWRITE_DEPTH, Math.max(0, depth) + 1)),
  );
  if (options.hls) {
    proxyUrl.searchParams.set("hls", "1");
  }
  if (options.kind) {
    proxyUrl.searchParams.set("kind", options.kind);
  }
  if (options.encrypted) {
    proxyUrl.searchParams.set("encrypted", "1");
  }
  return proxyUrl.toString();
}

function rewriteHlsTagUris(line, baseUrl, requestUrl, depth) {
  if (!/^#EXT-X-(?:KEY|MAP|MEDIA|SESSION-KEY|I-FRAME-STREAM-INF|PART|PRELOAD-HINT|RENDITION-REPORT):/i.test(line)) {
    return line;
  }
  const kind = /^#EXT-X-(?:KEY|SESSION-KEY):/i.test(line)
    ? "key"
    : /^#EXT-X-MAP:/i.test(line)
      ? "map"
      : "manifest";
  return line.replace(
    /(\bURI\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^,]*))/gi,
    (match, prefix, doubleQuoted, singleQuoted, unquoted) => {
      const value = doubleQuoted ?? singleQuoted ?? String(unquoted || "").trim();
      const rewritten = hlsProxyUrl(value, baseUrl, requestUrl, depth, {
        hls: true,
        kind,
      });
      if (doubleQuoted !== undefined) return `${prefix}"${rewritten}"`;
      if (singleQuoted !== undefined) return `${prefix}'${rewritten}'`;
      return `${prefix}${rewritten}`;
    },
  );
}

function rewriteHlsManifest(playlist, manifestUrl, requestUrl, depth) {
  const source = String(playlist || "");
  if (!source.trimStart().startsWith("#EXTM3U")) {
    return source;
  }
  const baseUrl = String(manifestUrl || upstreamOrigin({}));
  const output = [];
  let encrypted = false;
  let nextUriKind = "";
  for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      output.push(rawLine);
      continue;
    }
    if (line.startsWith("#")) {
      output.push(rewriteHlsTagUris(rawLine, baseUrl, requestUrl, depth));
      if (/^#EXT-X-KEY:/i.test(line)) {
        const attributes = parseHlsAttributeList(
          line.replace(/^#EXT-X-KEY:/i, ""),
        );
        encrypted = String(attributes.METHOD || "").trim().toUpperCase() ===
          "AES-128";
      }
      if (/^#EXT-X-STREAM-INF:/i.test(line)) {
        nextUriKind = "manifest";
      }
      continue;
    }
    const kind = nextUriKind || "segment";
    nextUriKind = "";
    output.push(hlsProxyUrl(line, baseUrl, requestUrl, depth, {
      hls: true,
      kind,
      encrypted,
    }));
  }
  return output.join("\n");
}

function isHlsResponse(upstream, sourceUrl) {
  const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
  if (INLINE_HLS_CONTENT_TYPES.has(contentType.split(";")[0].trim())) {
    return true;
  }
  let pathname = "";
  try {
    pathname = new URL(upstream.url || sourceUrl).pathname.toLowerCase();
  } catch {
    pathname = "";
  }
  return /\.m3u8?$/i.test(pathname);
}

function adjustedContentRangeAfterPrefix(contentRange, prefixLength, bodyLength) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(
    String(contentRange || "").trim(),
  );
  if (!match) return "";
  const upstreamStart = Number(match[1]);
  const upstreamTotal = match[3] === "*" ? null : Number(match[3]);
  const virtualStart = Math.max(0, upstreamStart - prefixLength);
  const virtualEnd = virtualStart + Math.max(0, bodyLength - 1);
  const virtualTotal = upstreamTotal === null
    ? "*"
    : String(Math.max(0, upstreamTotal - prefixLength));
  return `bytes ${virtualStart}-${virtualEnd}/${virtualTotal}`;
}

async function proxyMediaResponse(upstream, sourceUrl, request, env, depth = 0) {
  const requestUrl = new URL(request.url);
  const kind = String(requestUrl.searchParams.get("kind") || "").toLowerCase();
  const encrypted = requestUrl.searchParams.get("encrypted") === "1";
  const hlsManifestRequest = requestTargetsHlsManifest(request, sourceUrl);
  const cacheableMediaSegment =
    request.method === "GET" &&
    !request.headers.has("range") &&
    !hlsManifestRequest &&
    kind !== "key" &&
    kind !== "manifest" &&
    kind !== "map" &&
    upstream.status >= 200 &&
    upstream.status < 300;
  const headers = mediaProxyResponseHeaders(upstream, {
    cacheableMediaSegment,
  });
  const prefixAdjusted =
    headers.get(MEDIA_SEGMENT_PREFIX_ADJUSTED_HEADER) === "1";
  headers.delete(MEDIA_SEGMENT_PREFIX_ADJUSTED_HEADER);
  const upstreamType = String(headers.get("content-type") || "").toLowerCase();
  if (
    kind === "key" ||
    (encrypted && (!upstreamType || upstreamType.startsWith("font/")))
  ) {
    headers.set("content-type", "application/octet-stream");
  }
  if (request.method === "HEAD" || !upstream.body) {
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  let pathname = "";
  try {
    pathname = new URL(sourceUrl).pathname;
  } catch {}
  const embeddedTsCandidate = upstreamType.startsWith("image/") ||
    HLS_EMBEDDED_TS_IMAGE_PATTERN.test(pathname);
  if (embeddedTsCandidate && !prefixAdjusted) {
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    const prefixLength = embeddedMpegTsOffset(bytes);
    if (prefixLength >= 0) {
      const mediaBytes = prefixLength > 0 ? bytes.slice(prefixLength) : bytes;
      const contentRange = headers.get("content-range");
      if (upstream.status === 206 && contentRange) {
        const adjusted = adjustedContentRangeAfterPrefix(
          contentRange,
          prefixLength,
          mediaBytes.byteLength,
        );
        if (adjusted) {
          headers.set("content-range", adjusted);
        } else {
          headers.delete("content-range");
        }
      } else {
        headers.delete("content-range");
      }
      headers.set("accept-ranges", "bytes");
      headers.set("content-length", String(mediaBytes.byteLength));
      headers.set("content-type", "video/mp2t");
      headers.delete("etag");
      headers.delete("last-modified");
      return new Response(mediaBytes, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }
    // 真实图片仍然按原样返回，只有带 TS 包头的伪图片才被转换成视频。
    headers.set("content-length", String(bytes.byteLength));
    return new Response(bytes, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  if (
    !isHlsResponse(upstream, sourceUrl) ||
    (upstream.status === 206 && !hlsManifestRequest)
  ) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  const text = await upstream.text();
  if (!text.trimStart().startsWith("#EXTM3U")) {
    headers.delete("content-length");
    headers.delete("content-range");
    return new Response(text, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  const finalUrl = upstream.url || sourceUrl;
  const rewritten = rewriteHlsManifest(text, finalUrl, request.url, depth);
  headers.delete("content-length");
  headers.delete("content-range");
  headers.set("content-type", "application/vnd.apple.mpegurl; charset=utf-8");
  return new Response(rewritten, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

// 解析器常把整段 HLS 清单塞进 data URL，完整 JSON 可能超过 700KB。
// variants 数组里的对象会逐个到达，不能看到第一条就按空闲时间截断：前面的
// 伪 HLS 线路可能先到，真实的 GetAV 线路还在后面。这里持续读取，直到数组
// 完整、响应流正常结束或总预算耗尽。
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
          const text = json.slice(arrayStart, scanIndex + 1);
          try {
            const complete = JSON.parse(text);
            if (Array.isArray(complete)) {
              variants.splice(0, variants.length, ...complete);
            }
          } catch {
            // 已经收集到的对象仍可用。
          }
          break;
        }
        if (char === "{" || char === "[" || char === '"') {
          if (char === "{") {
            elementStart = scanIndex;
            elementDepth = 1;
          }
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

async function readResolverJsonResponse(response, options = {}) {
  const timeoutMs = Math.max(
    1,
    Number(options.timeoutMs) || RESOLVER_FIRST_VARIANT_TIMEOUT_MS,
  );
  const timeoutAt = Date.now() + timeoutMs;
  let pendingRead = null;
  const readWithDeadline = async (reader, deadline) => {
    if (!pendingRead) {
      // A timed-out Promise.race must not leave a reader.read() running in the
      // background while the next loop starts another read on the same stream.
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
    const text = await withTimeout(response.text(), timeoutMs);
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
    if (payload) {
      return payload;
    }
    throw new Error("Resolver response timed out");
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 响应体可能已经被上游结束；取消失败不影响已解析的线路。
    }
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

function isLocalMediaPath(path) {
  return /^\/emby-media(?:\/|$)/i.test(String(path || ""));
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

function serverVersion(env) {
  return String(env.EMBY_SERVER_VERSION || "4.8.0.0");
}

function guestAccessEnabled(env) {
  // 默认开放免密码访客：客户端不输账号密码也能直接进服务。若部署了
  // EMBY_GUEST_ACCESS=false/0/no/off，则必须先 AuthenticateByName。
  const value = String(env.EMBY_GUEST_ACCESS ?? "true").trim().toLowerCase();
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
// Emby 客户端常见的 HTTP 超时在 10 秒左右。详情页与 PlaybackInfo 共用同一个
// 绝对截止时间，元数据、播放源和字幕不能再各自累计等待。
// 实测回退解析端冷启动要 6~21 秒（主解析器若被停用更是完全不可用），旧值
// 8200 会把“刚好差一点点就返回真实线路”的那批请求提前截断成占位源。放宽到
// 9000，仍明显小于客户端约 10 秒的超时；真正超时的请求会由 resolveVideo 的
// onPartial 早发布拿到已经解析出的线路，不会退回空源。
const ITEM_REQUEST_DEADLINE_MS = 9000;
const ITEM_METADATA_BUDGET_MS = 4200;
// 播放源解析接口是第三方现场抓取：响应头有时很快，但 700KB 左右的 JSON
// 会慢慢挤牙膏。整个请求（包括响应体读取）必须控制在客户端等待预算内，
// 否则 PlaybackInfo 会因为一个解析源而超时。
// 首个完整线路允许等到真实解析出来；拿到线路后只再短暂收集更多线路。
const RESOLVER_FIRST_VARIANT_TIMEOUT_MS = 45000;
// 主源和回退源并发返回；第一条有效结果到达后，再给另一条最多这么久合并。
// 回退源的完整 4 条线路常在 2.5-4.5 秒内到达。窗口过大（旧值 12s）会让
// 详情页冷启动整体超过 10 秒，客户端直接“Connection timeout”；这里收到
// 首条可用线路后只再等 5 秒合并其余线路，超时结果仍会在后台补进缓存。
const RESOLVER_SECONDARY_MERGE_MS = 5000;
// 解析端点顺序不固定：可能一个端点先返回伪 HLS（data: 清单），真实线路要等另一个
// 端点更久才补齐。先到的结果里没有任何 http(s) 直链时放宽合并窗口，避免只拿到
// 单条/伪线路；已经有真实地址时只做短暂合并。
const RESOLVER_THIN_MERGE_MS = 7000;
// 第三方 resolver 失效时，直接在服务端抓取公开页面补齐播放源。页面抓取本身
// 很快，但不能让一个慢站点拖住 PlaybackInfo；到达首个自建结果后只再等一小段
// 合并另一条链路的清晰度。
const SELF_HOSTED_FIRST_SOURCE_TIMEOUT_MS = 7000;
// Jina 代理取 GetAV 页面在冷启动时约需 4-5 秒。若 Javtiful 先返回并只等
// 4 秒，Pages 会经常只保留 GG 的 2 条伪 HLS，直到缓存过期都不再补 GetAV。
const SELF_HOSTED_SECONDARY_MERGE_MS = 5000;
const SELF_HOSTED_THIN_MERGE_MS = 6000;
// 公开解析器已经返回少量线路时，只给它一个较短的补源窗口；超时或失败仍保留
// 已经验证通过的公开线路，不能为了追求更多清晰度拖满 PlaybackInfo 预算。
// 详情页/PlaybackInfo 的预算远小于这条补源链的耗时；公共线路已经先发布出去
// （见 resolveVideo 的 onPartial），所以这里只留一个较短的补源窗口，让“完整
// 结果”更快落地到缓存，用户第二次点开就能命中全部线路。
const SELF_HOSTED_SUPPLEMENT_WAIT_MS = 3500;
const RESOLVER_SOURCE_TARGET_COUNT = 4;
const SELF_HOSTED_PAGE_TIMEOUT_MS = 9000;
const SELF_HOSTED_PAGE_USER_AGENT = "Mozilla/5.0";
const JAVTIFUL_ORIGIN = "https://javtiful.com";
const GETAV_ORIGIN = "https://getav.net";
const JINA_READER_ORIGIN = "https://r.jina.ai";
const SELF_HOSTED_VARIANT_LIMIT = 8;

function resolverMergeBudget(env, baseMs) {
  const override = Number(env?.RESOLVER_MERGE_BUDGET_MS);
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return baseMs;
}

function selfHostedMergeBudget(env) {
  const override = Number(env?.SELF_HOSTED_MERGE_BUDGET_MS);
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return SELF_HOSTED_SUPPLEMENT_WAIT_MS;
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function remainingRequestMs(deadline, fallbackMs = FETCH_TIMEOUT_MS) {
  const fallback = Math.max(0, Number(fallbackMs) || 0);
  const absolute = Number(deadline);
  if (!Number.isFinite(absolute) || absolute <= 0) {
    return fallback;
  }
  return Math.max(0, Math.min(fallback, absolute - Date.now()));
}

function positiveEnvMilliseconds(env, name, fallbackMs) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) && value > 0 ? value : fallbackMs;
}

async function fetchWithRetry(
  fetchImpl,
  url,
  options = {},
  timeoutMs = FETCH_TIMEOUT_MS,
  deadline = 0,
) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt += 1) {
    const attemptTimeoutMs = remainingRequestMs(deadline, timeoutMs);
    if (attemptTimeoutMs <= 0) {
      throw new Error("request deadline exceeded");
    }
    try {
      return await fetchWithTimeout(fetchImpl, url, options, attemptTimeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_MAX_ATTEMPTS) {
        const waitMs = remainingRequestMs(deadline, 250 * attempt);
        if (waitMs <= 0) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
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
// 分类 / 搜索列表页在“共享边缘缓存”里的存活时间，比进程内缓存长得多。
// 关键词搜索（尤其是标签 / 演员 / 片商）冷启动要全量扫描约 20 页上游，
// 是最重的一条路径；如果共享缓存也只活 60 秒，那么每个新实例、每分钟都要
// 重算一次，并发一上来就会撞 Cloudflare 1102（资源超限）。
// 这里把共享副本留 5 分钟：进程内仍是 60 秒（同一实例的连续请求即刻命中），
// 换实例 / 换请求时则直接复用共享结果，不再回源重扫。
const LIST_EDGE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_MOVIE_CACHE_ENTRIES = 4000;
const MAX_RESOLVE_CACHE_ENTRIES = 1000;
// 解析过程中的“部分结果”缓存：公共解析器已经拿到的线路会先落到这里。
// 详情页 / PlaybackInfo 的解析预算（3s / 12s）远小于自建补源（Javtiful /
// GetAV）的耗时，如果非要等补源结束才对外可见，客户端就只能一直看到
// “自动线路（解析中）”的占位源——用户反馈的“点开资源永远在解析中、
// 点播放一直加载中”就是这个原因。
// TTL 故意很短：完整结果（含补源）落地到 RESOLVE_VIDEO_CACHE 后，
// 这份中途快照就没有意义了；万一后台补源被 Worker 回收打断，也只会
// 影响 20 秒，不会让“只有两条源”的结果污染 30 分钟缓存。
const PARTIAL_RESOLVE_TTL_MS = 20 * 1000;
const MAX_LIST_CACHE_ENTRIES = 400;
// 全量扫描类列表（搜索 / 标签 / 演员 / 自定义排序）的“扫描窗口”：整轮上游扫描
// 只做一次，把前 LIST_PAGE_WINDOW 条按窗口缓存，客户端翻页时从窗口里切。
// 背景：列表缓存键里带了 StartIndex，客户端每翻一页都会把上游 40 页重扫一遍
// （实测每页 1.5-2.1 秒），这是翻页变慢、以及 Worker 撞 Cloudflare 1102
// （CPU / 内存超限）最主要的来源。
// 只在“结果与 StartIndex 无关”的全量扫描路径上启用，切片语义与旧实现完全一致。
const LIST_PAGE_WINDOW = 300;
const LIST_WINDOW_TTL_MS = 5 * 60 * 1000;
// 窗口条目约 300 条影片（几百 KB），必须单独限量：若混进 400 条的普通列表缓存，
// 高并发下会把实例内存打爆（同样是 1102）。
const MAX_LIST_WINDOW_ENTRIES = 8;
// Keep a small number of complete segments per Worker instance. HLS players
// often re-request the same segment with several byte ranges while seeking or
// resuming; caching the complete body keeps those ranges local instead of
// repeatedly downloading the CDN object.
// GetAV 的 4K 分片约 13.4 MB，原先 8 MB 的上限会让它每次 Range 请求都回源。
// 保留 2 条、单条最多 16 MB：既覆盖该分片，又把单实例内存峰值从 64 MB
// 压到 32 MB。分片缓存只是“seek/断点续传时少一次回源”，条数减少不会
// 影响播放正确性，却能显著降低触发 Cloudflare 1102（内存/CPU 超限）的概率。
const MEDIA_SEGMENT_BODY_CACHE_MAX_ENTRIES = 2;
// 同一分片的 Range 合并下载最多并发 2 个：既避免同一分片被反复回源，
// 又不让多个大分片同时驻留内存（Cloudflare 1102 的另一大来源）。
// 超过并发上限的 Range 请求直接透传，等前面的下载写进缓存后自然会命中。
const MEDIA_SEGMENT_RANGE_BUFFER_CONCURRENCY = 2;
let mediaSegmentRangeBuffersInFlight = 0;
// 伪 PNG/TS 分片只需要缓存“PNG 前缀长度”和上游总长度。这个元数据很小，
// 可以比完整分片多留很多条，让并发 Range 请求不用反复探测同一分片。
const MEDIA_SEGMENT_PREFIX_CACHE_MAX_ENTRIES = 1024;
const MAX_CACHED_MEDIA_SEGMENT_BYTES = 16 * 1024 * 1024;

function createTtlCache(ttlMs, maxEntries) {
  const entries = new Map();
  const pending = new Map();
  let generation = 0;

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

  const run = async (key, compute, cacheResult) => {
    const cached = read(key);
    if (cached !== undefined) return cached;
    const running = pending.get(key);
    if (running) return running;
    const startedAtGeneration = generation;
    const task = (async () => {
      const value = await compute();
      if (
        cacheResult &&
        value !== undefined &&
        value !== null &&
        generation === startedAtGeneration
      ) {
        write(key, value);
      }
      return value;
    })();
    pending.set(key, task);
    try {
      return await task;
    } finally {
      pending.delete(key);
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
    fetch: (key, compute) => run(key, compute, true),
    // 只复用同一 key 正在进行中的请求，不把结果写进缓存。
    coalesce: (key, compute) => run(key, compute, false),
    hasPending: (key) => pending.has(key),
    clear: () => {
      generation += 1;
      entries.clear();
      pending.clear();
    },
  };
}

const MOVIE_CACHE = createTtlCache(MOVIE_CACHE_TTL_MS, MAX_MOVIE_CACHE_ENTRIES);
const RESOLVE_VIDEO_CACHE = createTtlCache(RESOLVE_CACHE_TTL_MS, MAX_RESOLVE_CACHE_ENTRIES);
// 只存“解析到一半”的公共线路快照，见 PARTIAL_RESOLVE_TTL_MS 的注释。
const PARTIAL_RESOLVE_CACHE = createTtlCache(
  PARTIAL_RESOLVE_TTL_MS,
  MAX_RESOLVE_CACHE_ENTRIES,
);
const RESOLVE_SUBTITLE_CACHE = createTtlCache(RESOLVE_CACHE_TTL_MS, MAX_RESOLVE_CACHE_ENTRIES);
const LIST_CACHE = createTtlCache(LIST_CACHE_TTL_MS, MAX_LIST_CACHE_ENTRIES);
const LIST_WINDOW_CACHE = createTtlCache(LIST_WINDOW_TTL_MS, MAX_LIST_WINDOW_ENTRIES);
const API_TOKEN_CACHE = createTtlCache(60 * 1000, 500);
const MEDIA_SEGMENT_BODY_CACHE = createTtlCache(
  MEDIA_SEGMENT_CACHE_MAX_AGE_SECONDS * 1000,
  MEDIA_SEGMENT_BODY_CACHE_MAX_ENTRIES,
);
const MEDIA_SEGMENT_PREFIX_CACHE = createTtlCache(
  MEDIA_SEGMENT_CACHE_MAX_AGE_SECONDS * 1000,
  MEDIA_SEGMENT_PREFIX_CACHE_MAX_ENTRIES,
);

// ---------- 边缘缓存（跨实例复用） ----------
// 上面的缓存只活在“当前 Worker 实例”的内存里：实例重启、扩容、换节点后就全部失效，
// 于是每次冷启动都要重新回源，“第一次总是慢”主要就慢在这里。
// 下面把最热的几类结果（影片元数据 / 播放源解析 / 字幕列表 / 分类列表页）
// 再写一份到 Cloudflare 的边缘缓存：不同客户端、不同实例都能直接命中；
// 缓存键做哈希、不含登录信息，既不会串号也不会泄漏 token。
let edgeCacheOrigin = "";

const EDGE_NAMESPACE_MOVIE = "movie";
const EDGE_NAMESPACE_VIDEO = "video";
// 解析中途的“公共线路快照”单独用一个命名空间：它和 EDGE_NAMESPACE_VIDEO 里
// 的“完整结果”绝不能混，否则别的 isolate 会把半成品当成最终结果而不去补源。
const EDGE_NAMESPACE_VIDEO_PARTIAL = "video-partial";
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
      // 没翻到底的结果（上游抖动，或撞上翻页预算提前收尾）只做短缓存：
      // 否则一份“少了几百条”的列表会在共享边缘缓存里躺满 5 分钟，
      // 客户端表现就是“搜索少了资源”。只有确认翻到底的结果才配长缓存。
      const edgeTtlSeconds = page.truncated
        ? Math.min(ttlSeconds, LIST_CACHE_TTL_MS / 1000)
        : ttlSeconds;
      await edgeCacheWrite(EDGE_NAMESPACE_LIST, cacheKey, page, edgeTtlSeconds);
    }
    return page;
  });
}

// 全量扫描路径的“窗口复用”：整轮扫描只做一次，翻页时从窗口里切。
// 只对 needAll（结果与 StartIndex / requiredCount 无关）的路径调用；
// 那条路径下 requiredCount 只用于切片，所以复用的结果与逐页重扫完全一致。
// 扫描没到底（上游抖动 / 撞上翻页预算）且窗口不够翻时返回 null，
// 由调用方退回原来的“按页重扫”，避免给出错位的分页。
async function windowedListScan(windowKey, startIndex, limit, computeWindow) {
  const window = await LIST_WINDOW_CACHE.fetch(windowKey, () => computeWindow(LIST_PAGE_WINDOW));
  if (!window || !Array.isArray(window.movies)) return null;
  if (window.truncated && startIndex + limit > window.movies.length) return null;
  return {
    movies: window.movies.slice(startIndex, startIndex + limit),
    totalRecordCount: window.totalRecordCount,
    truncated: window.truncated,
    libraryEntries: window.libraryEntries,
  };
}

// 并发抓取上游分页：原来一页一页顺序请求，首次打开分类/演员页要等很久。
// 现在按页码小批量并发抓取、再按页码顺序合并，同时保留“够用就提前停止”的快速路径。
const SOURCE_PAGE_CONCURRENCY = 6;
// 单次“列表 / 搜索”翻页扫描的墙钟预算（毫秒）。
// 上游偶发抖动时，单个分页要等满 FETCH_TIMEOUT_MS 再重试一次，最坏能把一次搜索
// 拖到 20 秒以上，客户端就报 “Connection timeout”。这里给整轮扫描一个绝对截止
// 时间：预算内没翻完就按“没翻到底”返回已有结果（上层本来就是这样处理部分结果的），
// 用略少的条数换取“不再超时”。正常一次全量扫描约 2 秒，7 秒预算留了 3 倍余量。
const LIST_SCAN_DEADLINE_MS = 7000;

async function fetchPagesInParallel(options) {
  const {
    maxPages,
    pageSize,
    needAll,
    enough,
    fetchPage,
    collect,
    concurrency = SOURCE_PAGE_CONCURRENCY,
    deadline = 0,
  } = options;

  let sourcePage = 1;
  while (sourcePage <= maxPages) {
    if (!needAll && enough()) {
      return false;
    }
    if (deadline && Date.now() >= deadline) {
      // 预算耗尽：不再开新批次，按“没翻到底”返回，避免拖过客户端超时。
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
  }, FETCH_TIMEOUT_MS, options.deadline);

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

async function resolverJsonUrl(url, env, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVER_FIRST_VARIANT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(String(url), {
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: controller.signal,
    });
    const payload = await readResolverJsonResponse(response, {
      timeoutMs: RESOLVER_FIRST_VARIANT_TIMEOUT_MS,
    });
    if (!response.ok) {
      const detail = payload.code ? ` [code=${payload.code}]` : "";
      throw new Error(`${payload.message || payload.error || `Resolver HTTP ${response.status}`}${detail}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function resolverJson(path, env, fetchImpl) {
  return resolverJsonUrl(`${resolverOrigin(env)}${path}`, env, fetchImpl);
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

function exactSearchCode(searchTerm) {
  return movieNumberFromText(String(searchTerm || "").trim());
}

// 上游对“单个汉字/单字母”这种极短关键词直接返回 0 条（实测 q=母 → 0 条，
// q=人 / q=大 / q=A / q=1 同样为 0），必须补通配符才搜得到（q=母* → 950 条）。
// 多字符关键词加不加 "*" 结果数量一致（母亲 / 温泉 / 时间停止 / nsps 实测相同），
// 所以只在短关键词上补，既修好单字搜索，又不改变既有搜索语义。
function upstreamSearchQuery(searchTerm, exactCode) {
  const term = String(searchTerm || "").trim();
  if (!term || exactCode || term.includes("*")) {
    return term;
  }
  return [...term].length <= 2 ? `${term}*` : term;
}

function movieMatchesExactSearch(movie, code) {
  if (!code) return false;
  return movieNumberFromText(movieNumber(movie)) === code;
}

function sourceFilterForSearch(library, code) {
  // 上游的 subtitle 过滤会把 RCTD-740 错当成 RCTD-340；精确番号搜索
  // 改用 can_play，再在本地按完整番号校正。
  return code ? "can_play" : library.sourceFilter;
}

function prioritizeExactSearchResults(movies, code) {
  if (!code || !Array.isArray(movies) || movies.length < 2) {
    return movies;
  }
  const exact = [];
  for (const movie of movies) {
    if (movieMatchesExactSearch(movie, code)) {
      exact.push(movie);
    }
  }
  // 精确番号命中时，上游模糊搜索常把 RCTD-340 之类的相近番号混进来。
  // 只保留完全匹配，避免客户端搜索结果里出现无法播放或错误的目标。
  return exact.length ? exact : movies;
}

// 搜索页的一轮抓取。精确番号首轮仍按上游的 can_play 过滤；若没有找到
// 完全匹配，再省略 movie_filter_by 重试一次，避免上游错误过滤掉目标资源。
async function collectSearchRoundMovies(options) {
  const {
    movies,
    seen,
    searchTerm,
    exactCode,
    filterBy,
    env,
    fetchImpl,
    upstreamToken,
    needsFullCatalog = false,
    requiredCount = 0,
    deadline = 0,
    acceptMovie,
  } = options;

  // 单字关键词要补 "*" 上游才返回结果（见 upstreamSearchQuery 注释）。
  const upstreamQuery = upstreamSearchQuery(searchTerm, exactCode);

  return fetchPagesInParallel({
    maxPages: SEARCH_MAX_SOURCE_PAGES,
    pageSize: SEARCH_SOURCE_PAGE_SIZE,
    needAll: needsFullCatalog,
    deadline,
    enough: () => exactCode
      ? movies.some((movie) => movieMatchesExactSearch(movie, exactCode))
      : movies.length >= requiredCount,
    fetchPage: (page) => javdbRequest("/v2/search", env, fetchImpl, {
      query: {
        q: upstreamQuery,
        page,
        type: "movie",
        movie_filter_by: filterBy,
        limit: SEARCH_SOURCE_PAGE_SIZE,
      },
      token: upstreamToken,
      deadline,
    }).then(moviesFromPayload),
    collect: (pageMovies) => {
      for (const movie of pageMovies) {
        if (!acceptMovie(movie) && !movieMatchesExactSearch(movie, exactCode)) {
          continue;
        }
        const key = String(movie.id ?? movie.number ?? "");
        if (key && !seen.has(key)) {
          seen.add(key);
          movies.push(movie);
        }
      }
    },
  });
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

// 上游影片详情里的 preview_images 是“预览剧照”数组，元素形如
// { thumb_url, large_url }。Emby 客户端详情页的“艺术图（Backdrop）”就用它来填：
// 有剧照才返回，没剧照就不给 BackdropImageTags，避免客户端显示空白区块。
// 注意：只有 /v4/movies/{id} 详情接口会返回真实图片地址；
// /v2/search 的列表项只带 has_preview_images 标记，preview_images 是空数组。
// 第一张固定用资源封面（用户要求“艺术图第一张改成资源封面”），后面才是预览剧照。
// 只接受预览项的 large_url/url：thumb_url 是列表用的小图，上游有时还把它指向封面，
// 若继续回退会把同一张封面以模糊缩略图再放进艺术图。
function normalizedImageUrlKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const pathname = url.pathname
      .replace(/\/+$/, "")
      .replace(/\/small_covers\//gi, "/covers/")
      .toLowerCase();
    return `${url.hostname.toLowerCase()}${pathname}`;
  } catch {
    return raw
      .split(/[?#]/, 1)[0]
      .replace(/\/+$/, "")
      .replace(/\/small_covers\//gi, "/covers/")
      .toLowerCase();
  }
}

function isCoverImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    return /(?:^|\/)(?:small_)?covers\//i.test(new URL(raw).pathname);
  } catch {
    return /(?:^|\/)(?:small_)?covers\//i.test(raw.split(/[?#]/, 1)[0]);
  }
}

// 上游会把封面本身塞进预览图列表的第一张（形如 {番号}_l_0.jpg），而且常常是低清版：
// 客户端按 BackdropImageTags 逐张取图时就会看到两张资源封面，其中一张还是模糊图。
// URL 前缀过滤（covers / small_covers）拦不住这种 samples 目录下的封面派生图，
// 所以按文件名判断：去掉结尾的“大小标记 + 序号”后，基础名和封面图文件名同源的、
// 序号为 0 的那张直接跳过。序号非 0 的（真正的剧照预览）照常保留。
const IMAGE_PREVIEW_INDEX_PATTERN = /^(.+?)[_\-.](?:[a-z]{1,3}[_\-.]|)(\d{1,3})$/;

function imageFileStem(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let pathname = raw;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    pathname = raw.split(/[?#]/, 1)[0];
  }
  const name = (pathname.split("/").pop() || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .toLowerCase();
  if (!name) return null;
  const match = IMAGE_PREVIEW_INDEX_PATTERN.exec(name);
  if (!match || !match[1]) {
    return { base: name, index: null };
  }
  return { base: match[1], index: Number(match[2]) };
}

function isCoverDerivedPreview(value, coverStem) {
  if (!coverStem?.base) return false;
  const info = imageFileStem(value);
  return Boolean(info && info.index === 0 && info.base === coverStem.base);
}

function movieBackdropImages(movie) {
  const raw = movie?.preview_images;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const urls = [];
  const cover = String(movie?.cover_url || movie?.thumb_url || "").trim();
  const coverKey = normalizedImageUrlKey(cover);
  const coverStem = imageFileStem(cover);
  const seen = new Set();
  if (cover) {
    urls.push(cover);
    if (coverKey) seen.add(coverKey);
  }
  for (const entry of raw) {
    const value = typeof entry === "string"
      ? entry
      : entry?.large_url || entry?.url || "";
    const url = String(value || "").trim();
    const key = normalizedImageUrlKey(url);
    if (
      !url ||
      !key ||
      seen.has(key) ||
      isCoverImageUrl(url) ||
      isCoverDerivedPreview(url, coverStem) ||
      (coverKey && key === coverKey)
    ) continue;
    seen.add(key);
    urls.push(url);
    if (urls.length >= BACKDROP_IMAGE_LIMIT) {
      break;
    }
  }
  return urls;
}

// pendingSources=true 表示“播放源还在后台解析”，此时把 20 秒的时间桶拼进
// ETag 的指纹里，客户端最多 20 秒就能看到一次版本变化并重拉详情。
// 详情 DTO 的“艺术图版本”：把 20 秒时间桶拼进每张艺术图的 tag。Emby 客户端
// 用 tag 拼图片请求地址（/Items/{id}/Images/Backdrop/{i}?tag=…），tag 不变时
// 永远命中本地缓存。用户要求“退出详情页 20 秒后再进来要重新加载艺术图”，
// 所以详情 DTO 里把 tag 按同一个时间桶换掉。
// 只作用于详情 DTO：列表/首页 DTO 不拼，否则滚动列表时封面会被反复下载。
// 主封面（Primary）也不拼：它几乎不变，重新下载只增加流量没有收益。
function refreshDetailBackdropTags(item) {
  if (!item || !Array.isArray(item.BackdropImageTags) || !item.BackdropImageTags.length) {
    return;
  }
  const bucket = Math.floor(Date.now() / PENDING_SOURCES_ETAG_BUCKET_MS);
  item.BackdropImageTags = item.BackdropImageTags.map(
    (tag) => `${tag}-art-v2-${bucket}`,
  );
}

function itemEtag(item, options = {}) {
  // refreshSources=true 时把“20 秒时间桶”计入指纹：
  // - 解析还没完成（占位源）：客户端必须尽快重拉，否则一直停在“解析中”；
  // - 解析已完成：用户要求“退出详情页 20 秒后再进来要重新加载全部视频源、
  //   字幕和艺术图”。Emby 客户端会把整份 DTO 存在本地库里，指纹不变就只
  //   会拿到 304，于是永远显示上一次部署时缓存的旧详情页。
  //   带上时间桶后，跨桶的请求必然指纹不同 → 服务端回 200 + 最新 DTO。
  const refreshSources = options.refreshSources === true ||
    options.pendingSources === true;
  const userData = item?.UserData || {};
  const sources = Array.isArray(item?.MediaSources)
    ? item.MediaSources.map((source) => ({
      Id: source?.Id || "",
      MediaSourceId: source?.MediaSourceId || "",
      Name: source?.Name || "",
      Container: source?.Container || "",
      Type: source?.Type || "",
      RunTimeTicks: Number(source?.RunTimeTicks) || 0,
    }))
    : [];
  const stableDto = {
    version: ITEM_DTO_ETAG_VERSION,
    ...(refreshSources
      ? {
        SourcesRefreshBucket: Math.floor(
          Date.now() / PENDING_SOURCES_ETAG_BUCKET_MS,
        ),
      }
      : {}),
    Id: item?.Id || "",
    Name: item?.Name || "",
    OriginalTitle: item?.OriginalTitle || "",
    Overview: item?.Overview || "",
    PremiereDate: item?.PremiereDate || "",
    ProductionYear: item?.ProductionYear || 0,
    RunTimeTicks: Number(item?.RunTimeTicks) || 0,
    Genres: item?.Genres || [],
    Tags: item?.Tags || [],
    People: item?.People || [],
    Studios: item?.Studios || [],
    ImageTags: item?.ImageTags || {},
    BackdropImageTags: item?.BackdropImageTags || [],
    MediaSourceCount: Number(item?.MediaSourceCount) || sources.length,
    MediaSources: sources,
    Played: Boolean(userData.Played),
    PlayCount: Number(userData.PlayCount) || 0,
    IsFavorite: Boolean(userData.IsFavorite),
    PlaybackPositionTicks: Number(userData.PlaybackPositionTicks) || 0,
    PlayedPercentage: Number(userData.PlayedPercentage) || 0,
  };
  return `"${md5(JSON.stringify(stableDto))}"`;
}

function requestHasMatchingEtag(request, etag) {
  const header = String(request?.headers?.get("if-none-match") || "").trim();
  if (!header) return false;
  const normalizedEtag = String(etag || "").replace(/^W\//i, "");
  return header.split(",").map((value) => value.trim()).some((value) =>
    value === "*" || value.replace(/^W\//i, "") === normalizedEtag
  );
}

function itemJsonResponse(item, request, options = {}) {
  const pendingSources = options.pendingSources === true;
  const refreshSources = pendingSources || options.refreshSources === true;
  const etag = itemEtag(item, { refreshSources });
  item.Etag = etag;
  const headers = {
    etag,
    "cache-control": "no-store",
    expires: "0",
    pragma: "no-cache",
  };
  // refreshSources 时绝不回 304：Emby 客户端把整份 DTO 存在本地库里，
  // 304 会让它继续用“没有播放源、没有播放按钮”或“上一次部署时的旧详情页”。
  // 始终回 200 + 变化的 ETag，客户端才会在重新进入详情页时替换成最新内容。
  if (!refreshSources && requestHasMatchingEtag(request, etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ...headers,
        "access-control-allow-origin": "*",
      },
    });
  }
  return jsonResponse(item, 200, headers);
}

function mapMovie(movie, requestUrl, env = {}, parentId = CHINESE_PLAYABLE_LIBRARY_ID) {
  const id = String(movie.id ?? movie.number ?? "");
  const image = movie.cover_url || movie.thumb_url || "";
  const backdropImages = movieBackdropImages(movie);
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
    Container: "mp4",
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
    // 用上游预览剧照当“艺术图”：客户端凭这里的 tag + 下标请求
    // /Items/{id}/Images/Backdrop/{index}，服务端再回源取真实图片。
    BackdropImageTags: backdropImages.map((_, index) => String(index)),
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

  item.Etag = itemEtag(item);
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
function movieCacheKey(id, env, upstreamToken) {
  return `${apiOrigin(env)}|${upstreamToken ? "u" : "g"}|${String(id)}`;
}

function preferredExactSearchMovie(movies, searchTerm, exactCode) {
  const expectedId = String(searchTerm || "").trim();
  const matches = (Array.isArray(movies) ? movies : []).filter((movie) => {
    if (exactCode) {
      return movieMatchesExactSearch(movie, exactCode);
    }
    return expectedId && String(movie?.id || "") === expectedId;
  });
  if (!matches.length) return null;
  return matches.find(isPlayableChinese) ||
    matches.find((movie) => Boolean(movie?.can_play)) ||
    matches[0];
}

async function findMovieByExactSearch(
  id,
  env,
  fetchImpl,
  upstreamToken,
  deadline,
) {
  const searchTerm = String(id || "").trim();
  const exactCode = exactSearchCode(searchTerm);
  if (!searchTerm) return null;

  let lastError = null;
  for (const filterBy of ["can_play", ""]) {
    let payload;
    try {
      payload = await javdbRequest("/v2/search", env, fetchImpl, {
        query: {
          q: searchTerm,
          type: "movie",
          movie_filter_by: filterBy,
          limit: SEARCH_SOURCE_PAGE_SIZE,
        },
        token: upstreamToken,
        deadline,
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    const candidate = preferredExactSearchMovie(
      moviesFromPayload(payload),
      searchTerm,
      exactCode,
    );
    if (!candidate) continue;

    const candidateId = String(candidate.id || "").trim();
    if (!candidateId || candidateId === searchTerm) {
      return candidate;
    }
    try {
      const detail = movieFromPayload(await javdbRequest(
        `/v4/movies/${encodeURIComponent(candidateId)}`,
        env,
        fetchImpl,
        { token: upstreamToken, deadline },
      ));
      if (detail?.id || detail?.number) {
        return detail;
      }
    } catch (error) {
      lastError = error;
    }
    return candidate;
  }
  if (lastError) throw lastError;
  return null;
}

async function getMovie(id, env, fetchImpl, token = "", options = {}) {
  const upstreamToken = typeof options.upstreamToken === "string"
    ? options.upstreamToken
    : await apiToken(token, env);
  const deadline = Number(options.deadline) || 0;
  const code = exactSearchCode(id);
  let directError = null;
  let direct = null;
  try {
    direct = movieFromPayload(await javdbRequest(
      `/v4/movies/${encodeURIComponent(id)}`,
      env,
      fetchImpl,
      { token: upstreamToken, deadline },
    ));
  } catch (error) {
    directError = error;
  }
  if (
    direct &&
    (direct.id || direct.number) &&
    (!code || movieMatchesExactSearch(direct, code))
  ) {
    return direct;
  }

  // 上游把部分资源编号当成了不存在的 ID（例如 RCTD-740 会返回 502），
  // 但搜索接口能找到真实 ID。这里做精确搜索回退，并把原始编号和真实 ID
  // 都写进缓存，后续详情页、图片、字幕和 PlaybackInfo 就都会命中同一部片。
  try {
    const found = await findMovieByExactSearch(
      id,
      env,
      fetchImpl,
      upstreamToken,
      deadline,
    );
    if (found?.id || found?.number) {
      return found;
    }
  } catch (error) {
    if (!directError) directError = error;
  }
  if (directError) throw directError;
  return direct;
}

// 带缓存的影片元数据：详情页、图片、字幕、播放解析都会取同一部影片，
// 缓存后同一部片在一次浏览里只回源一次。
async function getMovieCached(id, env, fetchImpl, token = "", options = {}) {
  const upstreamToken = typeof options.upstreamToken === "string"
    ? options.upstreamToken
    : await apiToken(token, env);
  const key = movieCacheKey(id, env, upstreamToken);
  return MOVIE_CACHE.fetch(key, async () => {
    const shared = await edgeCacheRead(EDGE_NAMESPACE_MOVIE, key);
    if (shared !== undefined) {
      return shared;
    }
    const movie = await getMovie(id, env, fetchImpl, token, {
      ...options,
      upstreamToken,
    });
    // 空结果 / 瞬时失败不写共享缓存，避免把“查不到”缓存十分钟。
    if (movie && (movie.id || movie.number)) {
      await edgeCacheWrite(EDGE_NAMESPACE_MOVIE, key, movie, MOVIE_CACHE_TTL_MS / 1000);
      const realKey = movieCacheKey(movie.id || movie.number, env, upstreamToken);
      if (realKey !== key) {
        await edgeCacheWrite(
          EDGE_NAMESPACE_MOVIE,
          realKey,
          movie,
          MOVIE_CACHE_TTL_MS / 1000,
        );
        MOVIE_CACHE.write(realKey, movie);
      }
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

async function getMoviePage(query, env, fetchImpl, token = "", options = {}) {
  // fastSearch：搜索结果页需要“准确的 TotalRecordCount”（客户端凭它决定还能
  // 往下翻多少），所以要全量扫描后给真实数量；只有搜索联想（SearchHints）
  // 这种“边打字边请求”的场景才保留快速分页，避免每次输入都等全量抓取。
  const fastSearch = Boolean(options.fastSearch);
  const startIndex = Math.max(0, Number(query.get("StartIndex") || 0));
  const limit = Math.min(
    DEFAULT_PAGE_SIZE,
    Math.max(1, Number(query.get("Limit") || DEFAULT_PAGE_SIZE)),
  );
  const searchTerm = query.get("SearchTerm") || query.get("searchTerm") || "";
  const explicitParentId = query.get("ParentId") || "";
  // Emby 的搜索是不带 ParentId 的全局搜索。这里不再默认按“中文字幕”过滤：
  // 否则片库浏览里看得到的作品，一搜索就“消失”（搜索只返回中文可播片）。
  // 全局搜索改成只要求“可播放”，用一次上游查询拿到全部可播放结果，
  // 不做多片库汇总；带 ParentId 的库内搜索语义不变。
  const requestedParentId = explicitParentId ||
    (searchTerm ? PLAYABLE_SEARCH_LIBRARY_ID : CHINESE_PLAYABLE_LIBRARY_ID);
  const library = libraryForRequestedId(requestedParentId);
  const parentId = requestedParentId === ROOT_ID ? ROOT_ID : library.id;
  const requiredCount = startIndex + limit;
  const sortOrder = /^asc/i.test(String(query.get("SortOrder") || "")) ? "asc" : "desc";
  const sortBy = String(query.get("SortBy") || "");
  const sortComparators = buildSortComparators(sortBy);
  // 默认“最新上架”顺序走原有快速路径；
  // 一旦客户端明确要求“按年份/名称”等排序，就抓全量后再排序分页，保证排序真的生效。
  const needsFullCatalog =
    !isNaturalCatalogOrder(sortComparators, sortOrder) ||
    (Boolean(searchTerm) && !fastSearch);
  const upstreamToken = await apiToken(token, env);

  // 同一页数据短时间内直接复用：客户端返回再进、翻页回退、重复请求都不再回源。
  const cacheKey = [
    "movie-page-v2",
    apiOrigin(env),
    upstreamToken ? "u" : "g",
    requestedParentId,
    library.id,
    library.sourceType,
    library.sourceFilter,
    searchTerm,
    startIndex,
    limit,
    sortOrder,
    sortBy,
    needsFullCatalog ? "full" : "fast",
  ].join("|");

  // 本次请求的翻页预算：从收到请求算起，超时就返回“已抓到的部分结果”。
  const scanDeadline = Date.now() + LIST_SCAN_DEADLINE_MS;
  // 本轮请求是否真的回源扫过上游。全量扫描本身就是最重的一条路径，
  // 再叠一层后台预热最容易被 Cloudflare 判成资源超限（1102）；
  // 命中缓存（含扫描窗口）的请求很便宜，才值得顺手预热。
  let upstreamScanRan = false;
  const loadPage = (pageStartIndex, pageRequiredCount) => {
    upstreamScanRan = true;
    return loadMovieCatalogPage({
      library,
      searchTerm,
      startIndex: pageStartIndex,
      requiredCount: pageRequiredCount,
      needsFullCatalog,
      sortComparators,
      sortOrder,
      env,
      fetchImpl,
      upstreamToken,
      deadline: scanDeadline,
    });
  };
  // 全量扫描的结果与 StartIndex 无关：整轮只扫一次，翻页从窗口里切。
  const scanWindowKey = [
    "movie-scan-v1",
    apiOrigin(env),
    upstreamToken ? "u" : "g",
    requestedParentId,
    library.id,
    library.sourceType,
    library.sourceFilter,
    searchTerm,
    sortOrder,
    sortBy,
    needsFullCatalog ? "full" : "fast",
  ].join("|");
  const page = await cachedListPage(cacheKey, LIST_EDGE_CACHE_TTL_MS / 1000, async () => {
    if (needsFullCatalog && startIndex + limit <= LIST_PAGE_WINDOW) {
      const windowed = await windowedListScan(
        scanWindowKey,
        startIndex,
        limit,
        (windowSize) => loadPage(0, windowSize),
      );
      if (windowed) return windowed;
    }
    return loadPage(startIndex, requiredCount);
  });

  const result = {
    Items: page.movies.map((movie) => mapMovie(
      movie,
      query.requestUrl || "https://localhost/",
      env,
      parentId,
    )),
    TotalRecordCount: page.totalRecordCount,
    StartIndex: startIndex,
  };
  return attachPrewarmMovies(result, upstreamScanRan ? [] : page.movies);
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
    deadline = 0,
  } = options;

  const exactCode = exactSearchCode(searchTerm);
  const sourceFilter = sourceFilterForSearch(library, exactCode);
  const matchingMovies = [];
  const seen = new Set();
  const collect = (movies) => {
    for (const movie of movies) {
      if (!library.matches(movie) && !movieMatchesExactSearch(movie, exactCode)) {
        continue;
      }
      const key = String(movie.id ?? movie.number ?? "");
      if (key && !seen.has(key)) {
        seen.add(key);
        matchingMovies.push(movie);
      }
    }
  };

  let sourceExhausted = false;
  if (searchTerm) {
    sourceExhausted = await collectSearchRoundMovies({
      movies: matchingMovies,
      seen,
      searchTerm,
      exactCode,
      filterBy: sourceFilter,
      env,
      fetchImpl,
      upstreamToken,
      needsFullCatalog,
      requiredCount,
      deadline,
      acceptMovie: (movie) => library.matches(movie),
    });
    if (
      exactCode &&
      !matchingMovies.some((movie) => movieMatchesExactSearch(movie, exactCode))
    ) {
      sourceExhausted = await collectSearchRoundMovies({
        movies: matchingMovies,
        seen,
        searchTerm,
        exactCode,
        filterBy: "",
        env,
        fetchImpl,
        upstreamToken,
        needsFullCatalog,
        requiredCount,
        deadline,
        acceptMovie: (movie) => library.matches(movie),
      });
    }
  } else {
    sourceExhausted = await fetchPagesInParallel({
      maxPages: HOME_MAX_SOURCE_PAGES,
      pageSize: HOME_SOURCE_PAGE_SIZE,
      needAll: needsFullCatalog,
      deadline,
      enough: () => matchingMovies.length >= requiredCount,
      fetchPage: (page) => javdbRequest("/v1/movies/latest", env, fetchImpl, {
        query: {
          page,
          filter_by: library.sourceFilter,
          type: library.sourceType,
          limit: HOME_SOURCE_PAGE_SIZE,
        },
        token: upstreamToken,
        deadline,
      }).then(moviesFromPayload),
      collect,
    });
  }

  const sortedMovies = needsFullCatalog
    ? sortMoviesForClient(matchingMovies, sortComparators, sortOrder)
    : matchingMovies;
  const orderedMovies = prioritizeExactSearchResults(sortedMovies, exactCode);
  return {
    movies: orderedMovies.slice(startIndex, requiredCount),
    // 精确番号搜索会在本地过滤相近番号，数量必须以过滤后的结果为准。
    // 普通浏览和模糊搜索在未翻到底时略多报，让客户端能继续往下翻页。
    totalRecordCount: exactCode
      ? orderedMovies.length
      : sourceExhausted
        ? matchingMovies.length
        : matchingMovies.length + 1,
    // 只有翻到底的结果才允许写进共享边缘缓存的长 TTL 档位（见 cachedListPage）。
    truncated: !sourceExhausted,
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
async function keywordMoviesPage(query, env, fetchImpl, token, searchTerm, cacheKind, options = {}) {
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
  // exactTotal：关键词搜索要在“结果条数”上给客户端一个准确数字。
  // 快速分页只抓到“够当前页”就停，未抓完时只能报一个近似值（matches.length+1），
  // 客户端会据此以为总共只有这么多，搜索结果看起来就“变少了”。
  const needsFullCatalog =
    Boolean(options.exactTotal) || !isNaturalCatalogOrder(sortComparators, sortOrder);
  const upstreamToken = await apiToken(token, env);
  // 本次请求的翻页预算：关键词搜索（含标签 / 演员 / 片商）冷启动要全量扫描，
  // 上游抖动时容易拖过客户端超时，这里统一给一个墙钟上限。
  const scanDeadline = Date.now() + LIST_SCAN_DEADLINE_MS;

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

  // 本轮请求是否真的回源扫过上游（见 getMoviePage 里的同名字段）。
  let upstreamScanRan = false;
  const buildPage = async (pageStartIndex, pageRequiredCount) => {
    upstreamScanRan = true;
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
        requiredCount: pageRequiredCount,
        deadline: scanDeadline,
      })));
      scans.forEach((scan, index) => {
        merge(libraryList[index], scan.movies);
        if (!scan.exhausted) {
          fullyScanned = false;
        }
      });
    } else {
      for (const library of libraryList) {
        if (matches.length >= pageRequiredCount) break;
        const scan = await scanLibraryMovies(library, {
          searchTerm,
          env,
          fetchImpl,
          upstreamToken,
          needAll: false,
          alreadyCount: matches.length,
          requiredCount: pageRequiredCount,
          deadline: scanDeadline,
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
    const pageMovies = orderedMovies.slice(pageStartIndex, pageRequiredCount);
    // 只带上这一页真正用到的“影片 -> 分类”映射：完整映射可能有上万条，
    // 会把这个缓存条目撑大好几倍（边缘缓存与实例内存都吃不消）。
    const pageKeys = new Set(
      pageMovies.map((movie) => String(movie.id ?? movie.number ?? "")),
    );
    return {
      movies: pageMovies,
      // 已把相关分类都翻到底时用真实数量；否则略多报，让客户端能继续往下翻页
      totalRecordCount: fullyScanned ? matches.length : matches.length + 1,
      // 用数组形式保存，方便写进边缘缓存（Map 没法 JSON 序列化）
      libraryEntries: [...libraryByKey].filter(([key]) => pageKeys.has(key)),
      // 同上：没翻到底的结果不进长缓存，避免“少资源”的结果被固化 5 分钟。
      truncated: !fullyScanned,
    };
  };

  // 全量扫描的结果与 StartIndex 无关：整轮只扫一次，翻页从窗口里切。
  const scanWindowKey = [
    `${cacheKind}-scan-v1`,
    apiOrigin(env),
    upstreamToken ? "u" : "g",
    searchTerm,
    singleLibrary ? singleLibrary.id : "all",
    sortOrder,
    sortBy,
    needsFullCatalog ? "full" : "fast",
  ].join("|");

  const page = await cachedListPage(cacheKey, LIST_EDGE_CACHE_TTL_MS / 1000, async () => {
    if (needsFullCatalog && startIndex + limit <= LIST_PAGE_WINDOW) {
      const windowed = await windowedListScan(
        scanWindowKey,
        startIndex,
        limit,
        (windowSize) => buildPage(0, windowSize),
      );
      if (windowed) return windowed;
    }
    return buildPage(startIndex, requiredCount);
  });

  const libraryByKey = page.libraryEntries
    ? new Map(page.libraryEntries)
    : new Map(Object.entries(page.libraryByKey || {}));

  const result = {
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
  return attachPrewarmMovies(result, upstreamScanRan ? [] : page.movies);
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
  // 点标签/类别/片商/系列后，客户端同样会显示“共 N 条”，所以这里也要真实数量。
  return keywordMoviesPage(query, env, fetchImpl, token, name, "collection", {
    exactTotal: true,
  });
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
  return keywordMoviesPage(query, env, fetchImpl, token, searchTerm, "person", {
    exactTotal: true,
  });
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
    deadline = 0,
  } = options;
  const movies = [];
  const seen = new Set();
  const keyword = String(searchTerm || "").trim();
  const byKeyword = Boolean(keyword);
  const exactCode = exactSearchCode(keyword);
  const sourceFilter = sourceFilterForSearch(library, exactCode);
  let exhausted = false;
  if (byKeyword) {
    exhausted = await collectSearchRoundMovies({
      movies,
      seen,
      searchTerm: keyword,
      exactCode,
      filterBy: sourceFilter,
      env,
      fetchImpl,
      upstreamToken,
      needsFullCatalog: needAll,
      requiredCount: Math.max(0, requiredCount - alreadyCount),
      deadline,
      acceptMovie: (movie) => library.matches(movie),
    });
    if (
      exactCode &&
      !movies.some((movie) => movieMatchesExactSearch(movie, exactCode))
    ) {
      exhausted = await collectSearchRoundMovies({
        movies,
        seen,
        searchTerm: keyword,
        exactCode,
        filterBy: "",
        env,
        fetchImpl,
        upstreamToken,
        needsFullCatalog: needAll,
        requiredCount: Math.max(0, requiredCount - alreadyCount),
        deadline,
        acceptMovie: (movie) => library.matches(movie),
      });
    }
  } else {
    exhausted = await fetchPagesInParallel({
      maxPages: HOME_MAX_SOURCE_PAGES,
      pageSize: HOME_SOURCE_PAGE_SIZE,
      needAll,
      deadline,
      enough: () => alreadyCount + movies.length >= requiredCount,
      fetchPage: (page) => javdbRequest("/v1/movies/latest", env, fetchImpl, {
        query: {
          page,
          filter_by: library.sourceFilter,
          type: library.sourceType,
          limit: HOME_SOURCE_PAGE_SIZE,
        },
        token: upstreamToken,
        deadline,
      }).then(moviesFromPayload),
      collect: (pageMovies) => {
        for (const movie of pageMovies) {
          if (!library.matches(movie) && !movieMatchesExactSearch(movie, exactCode)) {
            continue;
          }
          const key = String(movie.id ?? movie.number ?? "");
          if (key && !seen.has(key)) {
            seen.add(key);
            movies.push(movie);
          }
        }
      },
    });
  }
  return {
    movies: prioritizeExactSearchResults(movies, exactCode),
    exhausted,
  };
}
function videoFromResolverPayloads(payloads, movie, code, env) {
  const variants = mergeResolverVariants(payloads)
    .flatMap((item) => {
      const rawSource = sourceUrlValue(item);
      const sourceUrl = safeMediaUrl(rawSource, env);
      let inlinePlaylist = null;
      if (!sourceUrl) {
        // data URL 里的清单也要走异步验证：AES-128 线路的分片可能是
        // 字体路径，不能再用同步的“看到 woff2 就丢弃”规则硬过滤。
        inlinePlaylist = decodeInlineHls(rawSource);
      }
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
        label: String(item.label || item.displayName || "").trim(),
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
  assignUniqueSourceNames(orderedVariants);

  return {
    ...variant,
    alternates: orderedVariants.slice(1),
  };
}

function videoFromResolverPayload(payload, movie, code, env) {
  return videoFromResolverPayloads([payload], movie, code, env);
}

function normalizedResolvedVideo(variants) {
  if (!Array.isArray(variants) || !variants.length) return null;
  const normalized = variants.map((variant) => ({ ...variant }));
  assignUniqueSourceNames(normalized);
  return {
    ...normalized[0],
    alternates: normalized.slice(1),
  };
}

function mergeResolvedVideoVariants(env, ...videos) {
  const variants = mergeResolverVariants(
    videos
      .filter(Boolean)
      .map((video) => ({ variants: playbackVariants(video) })),
  ).flatMap((variant) => {
    if (variant.inlinePlaylist) {
      return [variant];
    }
    const sourceUrl = safeMediaUrl(variant.sourceUrl, env);
    if (!sourceUrl) {
      return [];
    }
    return [{
      ...variant,
      sourceUrl: sourceUrl.toString(),
    }];
  });
  return normalizedResolvedVideo(variants);
}

async function validatedResolvedVideo(video, fetchImpl, env = {}) {
  if (!isUsableResolvedVideo(video)) return null;
  const budgetMs = positiveEnvMilliseconds(
    env,
    "REMOTE_HLS_VALIDATION_BUDGET_MS",
    REMOTE_HLS_VALIDATION_BUDGET_MS,
  );
  const variants = await validatedVideoVariants(video, fetchImpl, budgetMs);
  return normalizedResolvedVideo(variants);
}

function resolverVideoUrls(code, env) {
  const urls = [];
  const primary = new URL(`${resolverOrigin(env)}${resolverResolvePath(env)}`);
  primary.searchParams.set("code", code);
  primary.searchParams.set("lang", "zh");
  urls.push(primary.toString());

  // 线上主解析器可能临时停用账号；公开静态源仍提供完整多线路结果。
  const fallback = new URL(PUBLIC_RESOLVER_RESOLVE_PATH, upstreamOrigin(env));
  fallback.searchParams.set("code", code);
  fallback.searchParams.set("lang", "zh");
  if (!urls.includes(fallback.toString())) {
    urls.push(fallback.toString());
  }
  return urls;
}

function normalizedCodeToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function selfHostedSearchCode(value, options = {}) {
  const token = normalizedCodeToken(value);
  if (token.length < 3) return false;
  if (options.allowNumeric === true) return true;
  return !/^\d+$/.test(token);
}

// 纯数字番号（052425-001 / 123456_789 这类）归一化后只剩数字。早期这里一律排除，
// 结果这类资源的自建补源（Javtiful / GetAV）永远不会被查：第一次进详情页只有公共
// 线路，等后台补完再点第二次才看到多条源。判断依据不能只看字符串——真实番号
// （movieNumber(movie)）即使是数字也要查，而内部数字 id（movie.id）必须排除，
// 否则会把内部 id 当番号丢给上游。
function selfHostedSearchableCode(movie, code) {
  return selfHostedSearchCode(code, {
    allowNumeric: Boolean(movieNumber(movie)),
  });
}

async function fetchSelfHostedPageText(
  fetchImpl,
  url,
  headers = {},
  timeoutMs = SELF_HOSTED_PAGE_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(String(url), {
      headers: new Headers({
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "user-agent": SELF_HOSTED_PAGE_USER_AGENT,
        ...headers,
      }),
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response?.ok) {
      throw new Error(`Self-hosted resolver HTTP ${response?.status || 0}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseJavtifulSearchResult(html, code) {
  const normalized = normalizedCodeToken(code);
  if (!normalized) return "";
  const exact = [];
  const partial = [];
  const pattern = /href\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    const rawHref = String(match[1] || match[2] || "")
      .replace(/&amp;/gi, "&")
      .trim();
    let url;
    try {
      url = new URL(rawHref, JAVTIFUL_ORIGIN);
    } catch {
      continue;
    }
    const path = url.pathname.match(/^\/zh\/video\/(\d+)\/([^/]+)\/?$/i);
    if (!path) continue;
    let slug = path[2];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      // Keep the raw slug when an upstream link contains malformed escapes.
    }
    const normalizedSlug = normalizedCodeToken(slug);
    const candidate = url.toString();
    if (normalizedSlug === normalized) {
      if (!exact.includes(candidate)) exact.push(candidate);
    } else if (normalizedSlug.includes(normalized)) {
      if (!partial.includes(candidate)) partial.push(candidate);
    }
  }
  return exact[0] || partial[0] || "";
}

function parseJavtifulWatchConfig(html) {
  const script = String(html || "").match(
    /<script\b[^>]*\bid\s*=\s*(?:"frontWatchConfig"|'frontWatchConfig')[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!script) return [];
  let config;
  try {
    config = JSON.parse(script[1]);
  } catch {
    return [];
  }

  const variants = [];
  for (const [index, source] of (Array.isArray(config?.playerSources)
    ? config.playerSources
    : []).entries()) {
    const rawUrl = String(source?.src || "").trim();
    const sourceUrl = absoluteHttpUrl(rawUrl, JAVTIFUL_ORIGIN);
    if (!sourceUrl) continue;
    const quality = Math.max(0, Number(source?.size) || 0);
    const qualityLabel = quality > 0 ? `${quality}P` : `线路 ${index + 1}`;
    variants.push({
      sourceUrl,
      sourceType: /mpegurl|m3u8/i.test(String(source?.type || ""))
        ? "application/vnd.apple.mpegurl"
        : "video/mp4",
      label: `Javtiful ${qualityLabel}`,
      variant: `javtiful_${quality || index + 1}`,
      title: String(config?.videoTitle || "").trim(),
      quality,
    });
  }
  return variants.sort((left, right) => right.quality - left.quality);
}

function absoluteHttpUrl(value, baseUrl) {
  try {
    const url = new URL(String(value || "").trim(), baseUrl);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

async function loadJavtifulVariants(code, fetchImpl) {
  const searchUrl = new URL("/zh/search", JAVTIFUL_ORIGIN);
  searchUrl.searchParams.set("q", code);
  const searchHtml = await fetchSelfHostedPageText(fetchImpl, searchUrl);
  const detailUrl = parseJavtifulSearchResult(searchHtml, code);
  if (!detailUrl) return [];
  const detailHtml = await fetchSelfHostedPageText(fetchImpl, detailUrl);
  return parseJavtifulWatchConfig(detailHtml);
}

function unescapeRscText(input) {
  return String(input || "").replace(/\\(\\|u0026|"|\/)/g, (_match, group) => {
    if (group === "\\") return "\\";
    if (group === "u0026") return "&";
    return group;
  });
}

function extractJsonArrayByKey(text, key) {
  const haystack = String(text || "");
  const marker = `"${key}":[`;
  const at = haystack.indexOf(marker);
  if (at < 0) return null;
  const start = haystack.indexOf("[", at);
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let index = start; index < haystack.length; index += 1) {
    const character = haystack[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    return JSON.parse(haystack.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseGetavType(value) {
  const family = String(value || "").trim().toLowerCase().split("_")[0];
  if (!["raw", "cn", "uc"].includes(family)) return null;
  const type = String(value || "").trim().toLowerCase();
  const match = type.match(/_(\d+)p$/);
  const quality = type.endsWith("_4k")
    ? 2160
    : match
      ? Number(match[1]) || 0
      : null;
  return { family, quality };
}

function parseGetavPage(html) {
  const text = unescapeRscText(html);
  if (!text || /<title>\s*页面未找到/i.test(text)) return null;
  const sources = extractJsonArrayByKey(text, "videoSources");
  if (!Array.isArray(sources) || !sources.length) return null;
  const title = (
    (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || ""
  ).replace(/\s*\|\s*GetAV\s*$/i, "").trim();
  return { title, sources };
}

function getavVariantsFromPage(html, code) {
  const page = parseGetavPage(html);
  if (!page) return [];
  const needle = normalizedCodeToken(code);
  const ownsCode = page.sources.some((source) =>
    normalizedCodeToken(source?.movieId || source?.code) === needle,
  );
  if (!ownsCode && !normalizedCodeToken(page.title).includes(needle)) {
    return [];
  }

  const familyOrder = new Map([["raw", 0], ["cn", 1], ["uc", 2]]);
  const familyLabels = { raw: "原版", cn: "中文字幕", uc: "无码" };
  const qualityLabels = { 480: "480P", 720: "720P", 1080: "1080P", 2160: "4K" };
  const variants = [];
  const seen = new Set();
  for (const source of page.sources) {
    const parsed = parseGetavType(source?.type);
    const sourceUrl = absoluteHttpUrl(source?.url || source?.src, GETAV_ORIGIN);
    if (!parsed || !sourceUrl) continue;
    const key = `${parsed.family}:${parsed.quality || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const qualityLabel = qualityLabels[parsed.quality] || "";
    variants.push({
      sourceUrl,
      sourceType: "application/vnd.apple.mpegurl",
      label:
        `${familyLabels[parsed.family]}${qualityLabel ? ` ${qualityLabel}` : ""}` +
        " (GetAV)",
      variant: `getav_${String(source.type || "").trim().toLowerCase()}`,
      title: page.title,
      quality: parsed.quality || 0,
      family: parsed.family,
    });
  }
  return variants
    .sort((left, right) =>
      (familyOrder.get(left.family) || 0) - (familyOrder.get(right.family) || 0) ||
      right.quality - left.quality)
    .slice(0, SELF_HOSTED_VARIANT_LIMIT);
}

async function loadGetavVariants(code, fetchImpl) {
  const slug = String(code || "").trim().toLowerCase();
  const pageUrl = new URL(`/zh/videos/${encodeURIComponent(slug)}`, GETAV_ORIGIN);
  const readerUrl = `${JINA_READER_ORIGIN}/${pageUrl.toString()}`;
  // Jina 偶尔会排队，直连也可能被上游拦截；两条链路同时启动并采用先返回的
  // 有效页面，避免串行等待把一个链路的首包延迟叠加成 10 秒以上的补源超时。
  const first = await firstNonEmptyVariantTask([
    {
      name: "jina",
      promise: fetchSelfHostedPageText(fetchImpl, readerUrl, {
        "x-respond-with": "html",
      })
        .then((html) => getavVariantsFromPage(html, code))
        .catch(() => []),
    },
    {
      name: "direct",
      promise: fetchSelfHostedPageText(fetchImpl, pageUrl)
        .then((html) => getavVariantsFromPage(html, code))
        .catch(() => []),
    },
  ]);
  return first?.value || [];
}

function firstNonEmptyVariantTask(tasks) {
  return new Promise((resolve) => {
    let remaining = tasks.length;
    let finished = false;
    for (const task of tasks) {
      task.promise.then((value) => {
        remaining -= 1;
        if (!finished && Array.isArray(value) && value.length) {
          finished = true;
          resolve({ task, value });
          return;
        }
        if (!finished && remaining === 0) {
          finished = true;
          resolve(null);
        }
      });
    }
  });
}

// 把自建补源抓到的线路整理成一份可发布的播放源快照。
function selfHostedVariantsVideo(movie, code, env, merged) {
  const variants = [];
  const seen = new Set();
  for (const variant of merged) {
    const sourceUrl = safeMediaUrl(variant?.sourceUrl, env);
    if (!sourceUrl) continue;
    const key = sourceUrl.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({
      ...variant,
      sourceUrl: key,
      title: movieDisplayName(movie) || code,
    });
  }
  return normalizedResolvedVideo(variants);
}

async function loadSelfHostedResolvedVideo(movie, code, env, fetchImpl, options = {}) {
  // 数字番号也要查自建源，否则第一次进详情页只有公共线路（见 selfHostedSearchableCode）。
  if (!selfHostedSearchableCode(movie, code)) return null;
  const tasks = [
    {
      name: "javtiful",
      promise: loadJavtifulVariants(code, fetchImpl).catch(() => []),
    },
    {
      name: "getav",
      promise: loadGetavVariants(code, fetchImpl).catch(() => []),
    },
  ];
  const firstNonEmptyPromise = firstNonEmptyVariantTask(tasks);
  const first = await Promise.race([
    firstNonEmptyPromise,
    settledWithin(
      firstNonEmptyPromise,
      SELF_HOSTED_FIRST_SOURCE_TIMEOUT_MS,
    ),
  ]);
  if (!first) return null;
  // 第一条自建线路一到就先发布一份快照：另一条链路（Jina 代理取 GetAV）
  // 冷启动要 4~5 秒，若等它合并完再发布，详情页 6.5 秒预算往往已经耗尽，
  // 客户端只能看到“自动线路（解析中）”。先发第一批，合并完成后再用更多
  // 线路覆盖（resolveVideo 的 publishPartial 按线路条数单调递增地发布）。
  if (typeof options.onFirstBatch === "function") {
    try {
      options.onFirstBatch(
        selfHostedVariantsVideo(movie, code, env, first.value),
      );
    } catch {
      // 提前发布失败不能影响正常解析。
    }
  }

  const merged = [...first.value];
  for (const task of tasks) {
    if (task === first.task) continue;
    const value = await settledWithin(task.promise, SELF_HOSTED_SECONDARY_MERGE_MS);
    if (Array.isArray(value)) merged.push(...value);
  }

  return selfHostedVariantsVideo(movie, code, env, merged);
}

async function resolveVideo(movie, env, fetchImpl, options = {}) {
  // onPartial：公共解析器（服务器 GG / tiful 等）的线路一拿到就先回调一次。
  // 自建补源（Javtiful / GetAV）最坏要 9 秒，客户端根本等不到，必须让调用方
  // 先把这部分真实线路发出去，而不是回一条“解析中”的占位源。
  const onPartial = typeof options.onPartial === "function" ? options.onPartial : null;
  // onPublicPhaseSettled：公共解析器那两条链路彻底跑完（合并窗口也过了）时回调一次。
  // 详情页据此判断“后面不可能再出现主批次快照”，不必再空等到首屏上限。
  const onPublicPhaseSettled = typeof options.onPublicPhaseSettled === "function"
    ? options.onPublicPhaseSettled
    : null;
  const code = movieNumber(movie) || movie.id || movie.title;
  if (!code) {
    return null;
  }

  const finalizeVideo = async (video) => {
    return validatedResolvedVideo(video, fetchImpl, env);
  };
  const loadResolverVideo = async (resolverUrl) => {
    const payload = await resolverJsonUrl(resolverUrl, env, fetchImpl);
    const video = videoFromResolverPayload(payload, movie, code, env);
    return {
      payload,
      video,
      variantCount: video ? 1 + video.alternates.length : 0,
    };
  };
  let selfHostedVideoTask = null;
  let selfHostedResolutionFinished = true;
  const startSelfHostedVideo = () => {
    if (!selfHostedVideoTask) {
      selfHostedResolutionFinished = false;
      selfHostedVideoTask = loadSelfHostedResolvedVideo(
        movie,
        code,
        env,
        fetchImpl,
        {
          // 自建链路里第一条线路一到就对外发布，不再等另一条链路合并完
          // （Jina 代理取 GetAV 要 4~5 秒，解析预算常常等不到）。
          onFirstBatch: (video) => publishPartial(video),
        },
      ).then(
        (video) => {
          selfHostedResolutionFinished = true;
          return video;
        },
        () => {
          selfHostedResolutionFinished = true;
          return null;
        },
      );
    }
    return selfHostedVideoTask;
  };
  // 中途快照只能“越换越多”。自建补源（Javtiful / GetAV）与公共解析器是两条
  // 并行链路，先后顺序不定、各自线路还可能是互补的（自建 2 条 + 公共 2 条）。
  // 用后到的那份直接覆盖，会让详情页从 4 条退回 1~2 条；所以这里把每次拿到
  // 的快照合并进一份累积结果，只有线路条数真的增加时才对外发布。
  let publishedVideo = null;
  let publishedSourceCount = -1;
  // 是否至少发布过一次“主批次”（公共解析器）快照。详情页首屏用它判断
  // “上游的全部线路是不是已经到齐”。
  let majorPublished = false;
  // major=true 表示这份快照来自“主批次”（公共解析器）：它基本代表了上游
  // 到底有几条线路，之后通常只会再有零星补充。自建补源的第一批（Javtiful
  // 秒回 1~2 条）不是主批次，详情页不能拿它当“线路齐了”就提前返回。
  const publishPartial = (video, major = false) => {
    if (!onPartial || !isUsableResolvedVideo(video)) return;
    const merged = publishedVideo
      ? mergeResolvedVideoVariants(env, publishedVideo, video) || video
      : video;
    const count = resolvedVideoSourceCount(merged);
    if (count <= publishedSourceCount) return;
    publishedVideo = merged;
    publishedSourceCount = count;
    if (major === true) majorPublished = true;
    try {
      // 未收尾的快照不能进长期持久层，客户端 20 秒后重拉时再换成完整线路。
      markResolvedVideoResolutionComplete(merged, false);
      onPartial(merged, { major: major === true });
    } catch {
      // 回调失败不能影响真正的解析流程。
    }
  };
  const resolverUrls = resolverVideoUrls(code, env);
  // 两个解析端点并发启动，等第一条有效结果，而不是固定先等回退源。
  // 主站挂起时回退源可以立即启动；主站有单条线路时，也保留一个短暂
  // 合并窗口等待回退源补齐其余线路。
  const settledEntries = resolverUrls.map((resolverUrl, index) => ({
    name: index === 0 ? "primary" : `resolver-${index}`,
    promise: loadResolverVideo(resolverUrl)
      .then((value) => ({ value }), (error) => ({ error })),
  }));
  // 自建补源（Javtiful / GetAV）实测 0.3~1.3 秒就能返回真实多线路，而公共
  // 解析器冷启动要 2~13 秒。旧写法把自建补源排在“第一条公共线路到达”之后
  // 才启动（见下面 firstValid 的等待），两条链路的延迟被串成一条：详情页
  // 6.5 秒预算里既等不到公共线路、也等不到自建线路，只能回“自动线路（解析
  // 中）”。现在无条件并行启动，谁先拿到线路谁先发布，详情页首屏就能直接
  // 拿到真实线路和播放按钮。
  if (selfHostedSearchableCode(movie, code)) {
    startSelfHostedVideo().then(
      (video) => publishPartial(video),
      () => {},
    );
  }
  const firstValid = await new Promise((resolve) => {
    let remaining = settledEntries.length;
    let resolved = false;
    settledEntries.forEach((entry) => {
      entry.promise.then((settled) => {
        remaining -= 1;
        if (!resolved && settled.value?.variantCount) {
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
  const firstUsableSourceCount = firstValid?.settled?.value?.payload
    ? resolverPayloadUsableSourceCount(firstValid.settled.value.payload, env)
    : 0;
  const firstHasUsableSource = Boolean(
    firstUsableSourceCount > 0 &&
    firstValid?.settled?.value?.payload &&
    resolverPayloadHasUsableSource(firstValid.settled.value.payload, env),
  );
  // 首条有效结果里已经有真实 http(s) 线路时，立刻先发布一次快照。
  // 另一条解析链路可能还要等 RESOLVER_SECONDARY_MERGE_MS / RESOLVER_THIN_MERGE_MS
  // （5~7 秒）才合并完，而详情页的解析预算只有 3 秒：等到合并完成再发布，预算
  // 早就耗尽，客户端只能看到一条“自动线路（解析中）”的占位源，点播放又因为
  // 取流接口要现场重解析而一直转圈。提前发布后，详情页/PlaybackInfo/取流接口
  // 预算耗尽时都能拿到这批真实线路（标记为“未完成”，不写长期缓存），
  // 补源在后台继续跑，客户端按 20 秒时间桶重拉时再换成完整线路。
  if (onPartial && firstValid && firstHasUsableSource) {
    try {
      publishPartial(videoFromResolverPayload(
        firstValid.settled.value.payload,
        movie,
        code,
        env,
      ), true);
    } catch {
      // 提前发布失败不影响下面的正常流程（后面还会再发布一次完整快照）。
    }
  }
  // 第一条链路如果只拿到少量线路，不能马上用 5 秒的“已有线路”合并窗口：
  // 线上实测另一条链路在 5~7 秒之间到达时会被截断，后续又把单条结果当成
  // 已完成并写缓存。只有首条链路已经达到目标条数时才缩短窗口。
  const mergeBudget = resolverMergeBudget(
    env,
    firstValid &&
      firstHasUsableSource &&
      firstUsableSourceCount >= RESOLVER_SOURCE_TARGET_COUNT
      ? RESOLVER_SECONDARY_MERGE_MS
      : RESOLVER_THIN_MERGE_MS,
  );
  const otherResolvers = await Promise.all(
    settledEntries.map((entry) =>
      firstValid?.name === entry.name
        ? Promise.resolve(firstValid.settled)
        : settledWithin(entry.promise, mergeBudget)
    ),
  );
  const payloads = otherResolvers
    .map((item) => item?.value?.payload)
    .filter(Boolean);
  const publicVideo = payloads.length
    ? videoFromResolverPayloads(payloads, movie, code, env)
    : null;
  // 公共线路先对外发布一次（标记为“未完成”，禁止写入长期缓存）。
  // 详情页/PlaybackInfo 的预算远小于下面的自建补源等待，先把真实线路给出去，
  // 客户端才会出现播放按钮；补源完成后再用完整结果覆盖。
  if (onPartial && isUsableResolvedVideo(publicVideo)) {
    publishPartial(publicVideo, true);
  }
  // 公共解析器两条链路都已经落定：后面只可能再有自建补源（非主批次）的快照。
  // 详情页收到这个信号后就不会再为“等主批次”空等到首屏上限。
  if (onPublicPhaseSettled) {
    try {
      onPublicPhaseSettled({ majorPublished });
    } catch {
      // 回调异常不能影响正常解析。
    }
  }
  const selfHosted = selfHostedVideoTask
    ? await settledWithin(selfHostedVideoTask, selfHostedMergeBudget(env))
    : null;
  const merged = mergeResolvedVideoVariants(env, publicVideo, selfHosted);
  const validated = await finalizeVideo(merged);
  if (validated) {
    // “本次解析已经收尾”才算完成：
    // - 没启动自建补源（公共线路本来就够了），或
    // - 自建补源任务真的跑完了（拿到了它全部能拿到的东西）
    // 补源只是没在预算内等到（selfHostedResolutionFinished 仍为 false）时不算完，
    // 交给后台继续跑。旧规则“必须凑到 4 条”会把“上游本来就只有 2 条”的片子
    // 永远判为未完成，于是永远不写缓存 → 每次点开都在现场重解析 → 客户端永远
    // 停在“自动线路（解析中）”。
    markResolvedVideoResolutionComplete(
      validated,
      !selfHostedVideoTask || selfHostedResolutionFinished,
    );
    return validated;
  }
  const failure = otherResolvers
    .map((item) => item?.error)
    .find(Boolean);
  if (failure) {
    throw failure;
  }
  return null;
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

function resolvedVideoCacheKey(movie, env) {
  const code = movieResolveCode(movie);
  return code
    ? `${resolverOrigin(env)}${resolverResolvePath(env)}|${RESOLVE_VIDEO_CACHE_VERSION}|${code}`
    : "";
}

function isUsableResolvedVideo(video) {
  return Boolean(
    video &&
    typeof video === "object" &&
    (String(video.sourceUrl || "").trim() || String(video.inlinePlaylist || "").trim()),
  );
}

const RESOLVED_VIDEO_COMPLETENESS = new WeakMap();

function resolvedVideoSourceCount(video) {
  return playbackVariants(video).length;
}

function markResolvedVideoResolutionComplete(video, complete) {
  if (!video || typeof video !== "object") return;
  RESOLVED_VIDEO_COMPLETENESS.set(video, complete === true);
}

function resolvedVideoResolutionComplete(video) {
  return RESOLVED_VIDEO_COMPLETENESS.get(video) !== false;
}

// 解析接口的账号可能临时被停用。仅靠短时边缘缓存会在缓存过期后突然把
// 详情页变成“没有播放按钮”。这里把最后一次成功结果写到持久层，解析失败时
// 继续下发旧源，同时后台尝试更新。
const EDGE_NAMESPACE_VIDEO_PERSIST = "video-persist-v1";
const EDGE_NAMESPACE_VIDEO_PERSIST_MIRROR = "video-persist-mirror-v1";
const RESOLVED_VIDEO_PERSIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// 上游解析器会把每条线路的 HLS 清单内联进 JSON，单个番号的完整播放源经常
// 有 1~1.8MB。旧上限 900KB 恰好把“线路最多的那些结果”全部挡在长期持久层
// 之外：它们只能活 30 分钟的边缘缓存，过期后又要重新经历一次 10~20 秒的
// 冷启动解析（用户看到的就是“放过的片子过一阵再点开又变成解析中”）。
// D1 单行/单字符串上限是 2,000,000 字节，这里放到 1.9MB，留出转义余量。
const RESOLVED_VIDEO_PERSIST_MAX_CHARS = 1_900_000;
const RESOLVED_VIDEO_KV_PREFIX = "resolved-video:v1:";
const RESOLVE_VIDEO_STALE_PEEK_MS = 1200;
// 详情页首屏的等待策略：优先等“整条解析链”给出的**已校验**完整结果，只有
// 完整结果来不及（或上游确实没线路）时才退回“中途快照”。
//
// 为什么会“只有一个播放源”：自建补源（Javtiful / GetAV）常常先给出第一批
// 1 条线路，公共解析器（服务器GG / tiful）要 2~4 秒才把其余 4~5 条补齐，而
// 校验（伪 HLS 剔除）又要再花 1~2 秒。旧实现“第一条线路出现就只宽限 1500
// 毫秒”，于是线上冷启动（edge→上游延迟比本地高）在 2.4 秒就用 1 条线路的
// 半成品答复了客户端，用户看到的就是“客户端只显示一个播放源”；20 秒后重拉
// 才拿到全部线路。
//
// 现在的规则：
//   1. 每发布一份“线路更多”的快照就重新计时（静默窗口）；
//   2. 还没见过“主批次”（公共解析器）时，一律用 FIRST_SCREEN_MAX_WAIT_MS：
//      公共解析器实测要 1.9~4.3 秒才返回（单个响应 1.1~1.8MB），而自建补源
//      （Javtiful）0.3 秒就先回 1~2 条。旧实现给自建快照武装 3000ms 的静默
//      窗口，于是 3.0 秒就把“1 条自建线路”答复出去，公共批次 3.4 秒才到、
//      永远赶不上——用户看到的就是“只显示一个播放源 / 自动线路”，点播放又
//      因为取流接口要现场解析而一直加载。现在把“公共批次是否收尾”作为信号：
//      只要公共批次还没收尾就一直等（上限 FIRST_SCREEN_MAX_WAIT_MS），
//      公共批次一收尾（见 onPublicPhaseSettled）立刻改用短静默期返回；
//   3. “主批次”且线路数 ≥ TARGET_COUNT 时用较短的 FIRST_SCREEN_SETTLE_MS：
//      主批次基本代表上游的全部线路；
//   4. 主批次已到但只有 1 条时继续等 FIRST_SCREEN_MAX_WAIT_MS：现场常见
//      “主解析器先回 1 条、另一条解析链路 3~5 秒后补齐”，短宽限仍会误答单源；
//   5. 无论哪条，整条解析链一旦收尾就立刻返回它（优先完整、已校验的结果）；
//   6. 最坏也在 FIRST_SCREEN_MAX_WAIT_MS 内答复，剩余线路由后台继续跑并写
//      缓存，客户端跨 20 秒时间桶重拉详情时补齐。
// 主批次（公共解析器）线路数达到这个条数就改用较短的静默窗口，不再等满宽限期。
const RESOLVE_VIDEO_FIRST_SCREEN_TARGET_COUNT = 2;
// 详情页首屏等待上限：宁可先给客户端少量线路，也不能让详情页一直转圈。
// 实测线上公共解析器冷启动要 1.9~4.3 秒（单个响应 1.1~1.8MB）；部分资源
// 的自建补源合并要到约 7 秒才完成。留出余量到 7.4 秒，同时仍由详情请求的
// 9 秒总截止线保护，低于客户端约 10 秒的 HTTP 超时。
const RESOLVE_VIDEO_FIRST_SCREEN_MAX_WAIT_MS = 7400;
// “主批次且已有多个线路”的快照到达后的静默窗口：只要这个窗口内不再出现
// 线路更多的快照，就返回当前快照；期间整条解析链若收尾则优先返回完整结果。
const RESOLVE_VIDEO_FIRST_SCREEN_SETTLE_MS = 400;

function normalizedPersistedResolvedVideo(value) {
  if (!value || typeof value !== "object") return null;
  const video = value.video || value.value || value;
  const savedAt = Math.max(0, Number(value.savedAt) || 0);
  if (!savedAt || !isUsableResolvedVideo(video)) return null;
  return { video, savedAt };
}

async function readPersistedResolvedVideo(env, key) {
  const db = playbackDb(env);
  if (db) {
    try {
      const value = await durableDbRead(db, EDGE_NAMESPACE_VIDEO_PERSIST, key);
      const record = normalizedPersistedResolvedVideo(value);
      if (record) return record;
    } catch {
      // D1 暂时不可用时继续查 KV / Cache API。
    }
  }
  const kv = playbackKv(env);
  if (kv) {
    const mirror = normalizedPersistedResolvedVideo(
      await edgeCacheRead(EDGE_NAMESPACE_VIDEO_PERSIST_MIRROR, key),
    );
    if (mirror) return mirror;
    try {
      const value = await kv.get(`${RESOLVED_VIDEO_KV_PREFIX}${md5(key)}`, "json", {
        cacheTtl: 30,
      });
      const record = normalizedPersistedResolvedVideo(value);
      if (record) return record;
    } catch {
      // KV 读失败时继续查长期边缘缓存。
    }
  }
  return normalizedPersistedResolvedVideo(
    await edgeCacheRead(EDGE_NAMESPACE_VIDEO_PERSIST, key),
  );
}

async function writePersistedResolvedVideo(env, key, video) {
  if (
    !isUsableResolvedVideo(video) ||
    !resolvedVideoResolutionComplete(video)
  ) {
    return;
  }
  const record = { video, savedAt: Date.now() };
  let serialized;
  try {
    serialized = JSON.stringify(record);
  } catch {
    return;
  }
  if (serialized.length > RESOLVED_VIDEO_PERSIST_MAX_CHARS) {
    // 超大内嵌 HLS 清单不适合写 D1 行；边缘缓存仍保留 30 分钟副本。
    return;
  }

  let durableWrite = false;
  const db = playbackDb(env);
  if (db) {
    try {
      await durableDbWrite(db, EDGE_NAMESPACE_VIDEO_PERSIST, key, record);
      durableWrite = true;
    } catch {
      // 继续尝试 KV。
    }
  }
  const kv = playbackKv(env);
  if (kv) {
    try {
      await kv.put(`${RESOLVED_VIDEO_KV_PREFIX}${md5(key)}`, serialized);
      durableWrite = true;
    } catch {
      // 继续使用 Cache API 兜底。
    }
  }
  if (durableWrite) {
    await edgeCacheWrite(
      EDGE_NAMESPACE_VIDEO_PERSIST_MIRROR,
      key,
      record,
      30,
    );
    return;
  }
  await edgeCacheWrite(
    EDGE_NAMESPACE_VIDEO_PERSIST,
    key,
    record,
    RESOLVED_VIDEO_PERSIST_TTL_MS / 1000,
  );
}

async function forgetPersistedResolvedVideo(env, key) {
  const db = playbackDb(env);
  if (db) {
    try {
      await db
        .prepare("DELETE FROM playback_json WHERE namespace = ? AND key = ?")
        .bind(EDGE_NAMESPACE_VIDEO_PERSIST, key)
        .run();
    } catch {
      // 删除失败时仍清理下面的短期缓存。
    }
  }
  const kv = playbackKv(env);
  if (kv) {
    try {
      await kv.delete(`${RESOLVED_VIDEO_KV_PREFIX}${md5(key)}`);
    } catch {
      // 忽略：下一次成功解析仍会覆盖该键。
    }
  }
  forgetEdgeCache(EDGE_NAMESPACE_VIDEO_PERSIST, key);
  forgetEdgeCache(EDGE_NAMESPACE_VIDEO_PERSIST_MIRROR, key);
}

async function invalidateCachedResolvedVideoLayer(env, key, layer) {
  if (layer === "memory") {
    RESOLVE_VIDEO_CACHE.forget(key);
    return;
  }
  if (layer === "edge") {
    forgetEdgeCache(EDGE_NAMESPACE_VIDEO, key);
    return;
  }
  if (layer === "persisted") {
    await forgetPersistedResolvedVideo(env, key);
  }
}

async function validateCachedResolvedVideo(
  candidate,
  env,
  key,
  fetchImpl,
  layer,
) {
  let video = null;
  try {
    video = await validatedResolvedVideo(candidate, fetchImpl, env);
  } catch {
    // A failed validation path is treated as unusable so a dead cached URL
    // cannot keep every client stuck on the same source.
    video = null;
  }
  if (!video) {
    await invalidateCachedResolvedVideoLayer(env, key, layer);
  }
  return video;
}

// 缓存写入（尤其是数 MB 内联 HLS 的序列化 + Cache API/D1 落盘）会明显拉长
// PlaybackInfo 的响应时间，冷启动时甚至把 Worker 推到 Cloudflare 1102。
// 有 ExecutionContext 时把写入登记到 waitUntil 后台执行，先把播放源返回给
// 客户端；没有 ctx（单测 / 非 Worker 运行）时仍然同步等待，保证结果可预测。
async function settleCacheWrite(task, ctx) {
  const guarded = Promise.resolve(task).catch(() => {});
  if (ctx && typeof ctx.waitUntil === "function") {
    try {
      ctx.waitUntil(guarded);
      return;
    } catch {
      // 登记失败时退回同步等待。
    }
  }
  await guarded;
}

// 只读“解析中途的公共线路快照”，不做任何网络校验：预算耗尽时必须立刻返回，
// 不能反过来被校验拖住。TTL 只有 20 秒，过期就当没有。
//
// 先读本实例内存，再读边缘缓存：内存快照只活在当前 isolate，用户“退出详情页
// 再重新点开”很容易落到另一个 isolate（或另一个 PoP），只读内存就会又退回
// “自动线路（解析中）”。边缘缓存那份由 persistPartialVideo 写入。
async function peekPartialResolvedVideo(movie, env) {
  const key = resolvedVideoCacheKey(movie, env);
  if (!key) return null;
  const memory = PARTIAL_RESOLVE_CACHE.read(key);
  if (isUsableResolvedVideo(memory)) return memory;
  try {
    const shared = await edgeCacheRead(EDGE_NAMESPACE_VIDEO_PARTIAL, key);
    if (isUsableResolvedVideo(shared)) {
      // 命中边缘后回填内存，同一实例的后续请求不必再查一次缓存。
      PARTIAL_RESOLVE_CACHE.write(key, shared);
      return shared;
    }
  } catch {
    // 边缘缓存读失败就按“暂时没有快照”处理，不能拖住响应。
  }
  return null;
}

// 把“解析到一半”的公共线路快照写到边缘缓存，让跨 isolate / 跨 PoP 的后续
// 请求也能立刻看到真实线路。
// 刻意只写边缘、不写 D1：长期持久层（video-persist-v1）的键里不含
// Worker/Pages 标记，两端共用同一个 D1 时会互相覆盖。
async function persistPartialVideo(env, key, video) {
  if (!key || !isUsableResolvedVideo(video)) return;
  await edgeCacheWrite(
    EDGE_NAMESPACE_VIDEO_PARTIAL,
    key,
    video,
    PARTIAL_RESOLVE_TTL_MS / 1000,
  );
}

// 完整结果落地后丢弃半成品快照（内存 + 边缘），避免后续请求预算耗尽时
// 用线路更少的旧快照覆盖已经拿到的完整线路。
function forgetPartialResolvedVideo(key) {
  if (!key) return;
  PARTIAL_RESOLVE_CACHE.forget(key);
  forgetEdgeCache(EDGE_NAMESPACE_VIDEO_PARTIAL, key);
}

async function peekCachedResolvedVideo(movie, env, fetchImpl, ctx = null) {
  const key = resolvedVideoCacheKey(movie, env);
  if (!key) return null;
  const memory = RESOLVE_VIDEO_CACHE.read(key);
  if (isUsableResolvedVideo(memory)) {
    const validated = await validateCachedResolvedVideo(
      memory,
      env,
      key,
      fetchImpl,
      "memory",
    );
    if (validated) {
      RESOLVE_VIDEO_CACHE.write(key, validated);
      return validated;
    }
  }
  try {
    const shared = await edgeCacheRead(EDGE_NAMESPACE_VIDEO, key);
    if (isUsableResolvedVideo(shared)) {
      const validated = await validateCachedResolvedVideo(
        shared,
        env,
        key,
        fetchImpl,
        "edge",
      );
      if (validated) {
        await settleCacheWrite(
          edgeCacheWrite(
            EDGE_NAMESPACE_VIDEO,
            key,
            validated,
            RESOLVE_CACHE_TTL_MS / 1000,
          ),
          ctx,
        );
        RESOLVE_VIDEO_CACHE.write(key, validated);
        return validated;
      }
    }
  } catch {
    // 继续读持久层。
  }
  try {
    const persisted = await readPersistedResolvedVideo(env, key);
    if (
      persisted &&
      Date.now() - persisted.savedAt <= RESOLVED_VIDEO_PERSIST_TTL_MS
    ) {
      const validated = await validateCachedResolvedVideo(
        persisted.video,
        env,
        key,
        fetchImpl,
        "persisted",
      );
      if (validated) {
        RESOLVE_VIDEO_CACHE.write(key, validated);
        return validated;
      }
    }
  } catch {
    // 没有可用旧缓存时由调用方按超时/空结果处理。
  }
  return null;
}

async function resolveVideoCached(movie, env, fetchImpl, ctx = null, options = {}) {
  const key = resolvedVideoCacheKey(movie, env);
  const externalOnPartial = typeof options.onPartial === "function"
    ? options.onPartial
    : null;
  // 解析中途的公共线路快照：写进短 TTL 的 PARTIAL_RESOLVE_CACHE（见其注释），
  // 让“本次请求预算用完”和“紧接着的第二次点开”都能立刻看到真实线路。
  const onPartial = (video, meta) => {
    if (!isUsableResolvedVideo(video)) return;
    if (key) {
      PARTIAL_RESOLVE_CACHE.write(key, video);
      // 同时写一份到边缘缓存：内存那份只活在当前 isolate，用户重进详情页
      // 往往落到别的实例，只靠内存就会又退回占位源。
      settleCacheWrite(persistPartialVideo(env, key, video), ctx);
    }
    if (externalOnPartial) {
      try {
        externalOnPartial(video, meta);
      } catch {
        // 调用方的回调异常不能打断解析。
      }
    }
  };
  if (!key) {
    return resolveVideo(movie, env, fetchImpl, { ...options, onPartial });
  }
  // 不用 fetch() 的自动写缓存：如果 GetAV 补源仍在后台且当前只有公开薄
  // 线路，结果只能服务本次请求，不能进入 30 分钟内存缓存或长期 D1。
  return RESOLVE_VIDEO_CACHE.coalesce(key, async () => {
    const shared = await edgeCacheRead(EDGE_NAMESPACE_VIDEO, key);
    if (isUsableResolvedVideo(shared)) {
      const validated = await validateCachedResolvedVideo(
        shared,
        env,
        key,
        fetchImpl,
        "edge",
      );
      if (validated) {
        await settleCacheWrite(
          edgeCacheWrite(
            EDGE_NAMESPACE_VIDEO,
            key,
            validated,
            RESOLVE_CACHE_TTL_MS / 1000,
          ),
          ctx,
        );
        RESOLVE_VIDEO_CACHE.write(key, validated);
        return validated;
      }
    }
    let persisted = await readPersistedResolvedVideo(env, key);
    if (
      persisted &&
      Date.now() - persisted.savedAt <= RESOLVE_CACHE_TTL_MS
    ) {
      const validated = await validateCachedResolvedVideo(
        persisted.video,
        env,
        key,
        fetchImpl,
        "persisted",
      );
      if (validated) {
        await settleCacheWrite(
          edgeCacheWrite(
            EDGE_NAMESPACE_VIDEO,
            key,
            validated,
            RESOLVE_CACHE_TTL_MS / 1000,
          ),
          ctx,
        );
        RESOLVE_VIDEO_CACHE.write(key, validated);
        return validated;
      }
      // 这层旧结果已经被验证为不可播放；若后面解析失败，也不能再把它
      // 当作兜底结果返回，否则客户端会重新拿到同一个死源。
      persisted = null;
    }

    try {
      const video = await resolveVideo(
        movie,
        env,
        fetchImpl,
        { ...options, onPartial },
      );
      if (isUsableResolvedVideo(video)) {
        if (resolvedVideoResolutionComplete(video)) {
          // 只有凑齐目标线路数的结果才写长期 D1（30 天）；线路偏少的“已收尾”
          // 结果仍然进内存 + 边缘缓存（30 分钟），避免上游本来就只有两条时
          // 每次点开都重新现场解析。
          const durable = resolvedVideoSourceCount(video) >=
            RESOLVER_SOURCE_TARGET_COUNT;
          await settleCacheWrite(
            Promise.all([
              edgeCacheWrite(
                EDGE_NAMESPACE_VIDEO,
                key,
                video,
                RESOLVE_CACHE_TTL_MS / 1000,
              ),
              durable
                ? writePersistedResolvedVideo(env, key, video)
                : Promise.resolve(),
            ]),
            ctx,
          );
          RESOLVE_VIDEO_CACHE.write(key, video);
          // 完整结果已经落地：把“解析中途快照”清掉，避免后续请求预算耗尽时
          // 又拿这批线路更少的半成品覆盖完整结果。
          forgetPartialResolvedVideo(key);
        }
        return video;
      }
      if (persisted) {
        // 解析接口返回了空结果也可能只是上游临时异常，旧的成功结果仍比
        // 直接返回空列表更有用。
        await settleCacheWrite(
          edgeCacheWrite(
            EDGE_NAMESPACE_VIDEO,
            key,
            persisted.video,
            RESOLVE_CACHE_TTL_MS / 1000,
          ),
          ctx,
        );
        RESOLVE_VIDEO_CACHE.write(key, persisted.video);
        return persisted.video;
      }
      return video;
    } catch (error) {
      if (persisted) {
        await settleCacheWrite(
          edgeCacheWrite(
            EDGE_NAMESPACE_VIDEO,
            key,
            persisted.video,
            RESOLVE_CACHE_TTL_MS / 1000,
          ),
          ctx,
        );
        RESOLVE_VIDEO_CACHE.write(key, persisted.video);
        return persisted.video;
      }
      throw error;
    }
  });
}

// 有旧成功源时立即返回，并在后台刷新；冷缓存时等待本次真实解析完成。
// 只有解析失败或返回空结果后，才回退到最多 30 天内的旧成功源。
async function resolveVideoForResponse(
  movie,
  env,
  fetchImpl,
  ctx,
  budgetMs,
) {
  const totalBudgetMs = Math.max(0, Number(budgetMs) || 0);
  const startedAt = Date.now();
  const remainingBudgetMs = () => Math.max(
    0,
    totalBudgetMs - (Date.now() - startedAt),
  );
  // 解析中途发布的“公共线路快照”（resolveVideo 在拿到首条真实线路时就会
  // 先发一次，不等回退端合并、更不等自建补源）。详情页/PlaybackInfo 的预算
  // 通常用不到补源结束，预算耗尽时直接把它发出去：客户端至少能看到真实线路
  // 和播放按钮，而不是一条“自动线路（解析中）”的占位源。
  // 本实例的内存快照优先，其次读边缘缓存那份——用户“退出详情页再重进”
  // 很可能落在另一个 isolate 上。
  const partial = { video: null };
  // 首屏等待必须用“可重复触发的静默窗口”，不能再用一次性 Promise：
  // 自建链路与公共解析器是两条并行链路，快照会分多次、由少到多到达
  // （典型：0.3s 自建 1 条 → 1.4s 公共 5 条 → 2s 自建合并 4 条）。
  // 一次性 Promise 只能在“第一份快照”时定一个延迟，之后新到的快照无法
  // 推迟返回，于是 1 条线路的半成品经常先被答复出去（用户看到“只有一个
  // 播放源”）。这里改成 debounce：
  //   1. 每收到一份“线路更多”的快照就 clearTimeout + 重新计时；
  //   2. 在“主批次”（公共解析器，meta.major）到达之前，一直等到“公共批次
  //      收尾”或 FIRST_SCREEN_MAX_WAIT_MS：公共解析器实测 1.9~4.3 秒才返回，
  //      自建补源 0.3 秒就先回 1~2 条。旧实现给这份自建快照武装
  //      FIRST_SCREEN_GRACE_MS(3000ms)，于是 3.0 秒就把 1 条线路答复出去，
  //      公共批次 3.4 秒才到、永远赶不上——这是“只显示一个播放源”的根因。
  //      主批次到达后（majorSeen）且线路数 ≥ 目标条数时改用
  //      FIRST_SCREEN_SETTLE_MS；主批次只有 1 条时用 FIRST_SCREEN_GRACE_MS
  //      再给自建补源一点补齐时间。
  //      为什么不能只看条数：自建补源常常 0.3 秒就回 2 条，公共解析器 1.4~1.8
  //      秒才回 5 条。若“≥2 条就 400 毫秒返回”，首屏只会是那 2 条（用户
  //      “只显示两个播放源”）。
  //      为什么主批次之后还要 SETTLE 而不是立刻返回：主批次之后自建链路还会
  //      补一批互补线路（合并测试覆盖了这个场景），给 400 毫秒静默期把它们
  //      一起收进来，既不会漏线路，也不会把首屏拖到 4 秒。
  //   3. 整条解析链收尾（resolveTask）优先返回完整、已校验结果；
  //   4. 最坏由 FIRST_SCREEN_MAX_WAIT_MS 兜底。
  let partialTimer = null;
  let partialResolve = null;
  // “主批次”（公共解析器）是否已经发布过。发布过之后，后续的自建补充线路
  // 只值得再等一个短静默期，不必再等满宽限期。
  let majorSeen = false;
  // 公共解析器两条链路是否已经彻底落定（resolveVideo 的 onPublicPhaseSettled）。
  // 落定之后不可能再出现主批次快照，首屏不必再为“等主批次”空等。
  let publicPhaseSettled = false;
  const partialSettled = new Promise((resolve) => {
    partialResolve = resolve;
  });
  const clearPartialWindow = () => {
    if (partialTimer) {
      clearTimeout(partialTimer);
      partialTimer = null;
    }
    partialResolve = null;
  };
  const armPartialWindow = (count, major) => {
    // 已经结束（或已被其它分支收尾）就不再重新计时。
    if (!partialResolve) return;
    if (major === true) majorSeen = true;
    if (partialTimer) clearTimeout(partialTimer);
    let delay;
    if (majorSeen) {
      delay = count >= RESOLVE_VIDEO_FIRST_SCREEN_TARGET_COUNT
        ? RESOLVE_VIDEO_FIRST_SCREEN_SETTLE_MS
        : RESOLVE_VIDEO_FIRST_SCREEN_MAX_WAIT_MS;
    } else if (publicPhaseSettled) {
      // 公共批次已收尾、主批次却始终没出现：上游确实没有更多线路，
      // 短静默期后就把已有的真实线路返回，不再空等到首屏上限。
      delay = RESOLVE_VIDEO_FIRST_SCREEN_SETTLE_MS;
    } else {
      // 公共批次还在飞：这是“只有 1~2 条自建线路”最容易误答的时刻。
      delay = RESOLVE_VIDEO_FIRST_SCREEN_MAX_WAIT_MS;
    }
    partialTimer = setTimeout(() => {
      partialTimer = null;
      const resolve = partialResolve;
      partialResolve = null;
      if (!resolve) return;
      try {
        resolve({ kind: "partial" });
      } catch {
        // 唤醒失败不影响解析。
      }
    }, delay);
  };
  const resolveTask = resolveVideoCached(movie, env, fetchImpl, ctx, {
    onPartial: (video, meta) => {
      partial.video = video;
      armPartialWindow(resolvedVideoSourceCount(video), meta?.major === true);
    },
    onPublicPhaseSettled: () => {
      publicPhaseSettled = true;
      // 公共批次收尾时若还没见过主批次，说明上游确实没给出更多线路：
      // 把已经到手的真实线路（自建补源那几条）的静默窗口改成短窗口。
      if (!majorSeen && partialResolve && partialVideo()) {
        armPartialWindow(resolvedVideoSourceCount(partial.video), false);
      }
    },
  });
  const partialVideo = () =>
    isUsableResolvedVideo(partial.video) ? partial.video : null;
  const latePartialVideo = async () =>
    partialVideo() || (await peekPartialResolvedVideo(movie, env));
  const firstPeekBudgetMs = Math.min(
    RESOLVE_VIDEO_STALE_PEEK_MS,
    remainingBudgetMs(),
  );
  const stale = firstPeekBudgetMs > 0
    ? await withTimeout(
      peekCachedResolvedVideo(movie, env, fetchImpl, ctx),
      firstPeekBudgetMs,
    ).catch(() => null)
    : null;
  if (isUsableResolvedVideo(stale)) {
    // 已有一个可用结果时先响应，真实解析继续刷新缓存。
    keepAlive(resolveTask.catch(() => null), ctx);
    return {
      video: stale,
      resolutionFinished: true,
      stale: false,
      error: null,
    };
  }
  if (remainingBudgetMs() <= 0) {
    keepAlive(resolveTask.catch(() => null), ctx);
    return {
      video: await latePartialVideo(),
      resolutionFinished: false,
      stale: false,
      error: null,
    };
  }

  try {
    // 首屏能不能出现真实线路，取决于这里等的是“整条解析链”还是“第一条可用
    // 线路”。整条链要等公共解析器合并（5~7 秒）+ 自建补源（3.5 秒）+ 校验，
    // 实测 7 秒以上，必然超过详情页 6.5 秒预算，客户端只能看到占位线路。
    //
    // 但只等“第一条线路”又会踩另一个坑：自建链路的第一批常常只有 1 条，比
    // 完整的自建合并（通常 4~5 条，0.5~1.3 秒）早几百毫秒到达；实测正是
    // 这 400 毫秒的宽限让详情页停在“只有一个播放源”。所以：
    //   1. 出现 ≥ RESOLVE_VIDEO_FIRST_SCREEN_TARGET_COUNT 条后，只要
    //      FIRST_SCREEN_SETTLE_MS 内没有更多线路就返回（多个真实播放源）；
    //   2. 只有 1 条时用 FIRST_SCREEN_GRACE_MS 等并行链路补齐；
    //   3. 每来一份“线路更多”的快照都重新计时（见 armPartialWindow）；
    //   4. 最坏也在 FIRST_SCREEN_MAX_WAIT_MS 内给客户端答复。
    // 其余线路由客户端 20 秒后重拉详情时补齐（发布按线路条数单调递增，不倒退）。
    let early;
    try {
      early = await withTimeout(
        Promise.race([
          resolveTask.then(
            (video) => ({ kind: "full", video }),
            (error) => ({ kind: "error", error }),
          ),
          partialSettled,
        ]),
        Math.min(remainingBudgetMs(), RESOLVE_VIDEO_FIRST_SCREEN_MAX_WAIT_MS),
      );
    } finally {
      // 无论谁先结束，都不再让静默窗口继续计时（避免悬空定时器）。
      clearPartialWindow();
    }
    if (early.kind === "full" && isUsableResolvedVideo(early.video)) {
      return {
        video: early.video,
        resolutionFinished: true,
        stale: false,
        error: null,
      };
    }
    if (early.kind === "error") {
      throw early.error || new Error("playback resolution failed");
    }
    if (early.kind === "partial") {
      const snapshot = await latePartialVideo();
      if (snapshot) {
        // 解析链还在后台跑：让它继续把剩余线路补全并写进缓存。
        keepAlive(resolveTask.catch(() => null), ctx);
        return {
          video: snapshot,
          resolutionFinished: false,
          stale: false,
          error: null,
        };
      }
    }
    if (isUsableResolvedVideo(early.video)) {
      return {
        video: early.video,
        resolutionFinished: true,
        stale: false,
        error: null,
      };
    }
  } catch (error) {
    // 响应预算用完不代表解析失败:后台继续跑完并写入缓存,
    // 下一次请求(客户端重试/刷新)就能直接命中结果。
    keepAlive(resolveTask.catch(() => null), ctx);
    // 已经解析出的公共线路优先于“占位源”：这就是“点开资源一直显示
    // 自动线路（解析中）”的直接修复点。
    const partialNow = await latePartialVideo();
    if (partialNow) {
      return {
        video: partialNow,
        resolutionFinished: false,
        stale: false,
        error: null,
      };
    }
    const fallbackBudgetMs = Math.min(
      RESOLVE_VIDEO_STALE_PEEK_MS,
      remainingBudgetMs(),
    );
    const fallback = fallbackBudgetMs > 0
      ? await withTimeout(
        peekCachedResolvedVideo(movie, env, fetchImpl, ctx),
        fallbackBudgetMs,
      ).catch(() => null)
      : null;
    if (isUsableResolvedVideo(fallback)) {
      return {
        video: fallback,
        resolutionFinished: false,
        stale: true,
        error: null,
      };
    }
    return {
      video: null,
      resolutionFinished: true,
      stale: false,
      error,
    };
  }

  const fallbackBudgetMs = Math.min(
    RESOLVE_VIDEO_STALE_PEEK_MS,
    remainingBudgetMs(),
  );
  const fallback = fallbackBudgetMs > 0
    ? await withTimeout(
      peekCachedResolvedVideo(movie, env, fetchImpl, ctx),
      fallbackBudgetMs,
    ).catch(() => null)
    : null;
  if (isUsableResolvedVideo(fallback)) {
    return {
      video: fallback,
      resolutionFinished: false,
      stale: true,
      error: null,
    };
  }
  return {
    video: null,
    resolutionFinished: true,
    stale: false,
    error: null,
  };
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
// 丢掉一部影片的“播放源解析”缓存（内存 + 边缘 + 持久层），下次点开会重新解析。
async function forgetResolveVideoCache(movie, env) {
  const key = resolvedVideoCacheKey(movie, env);
  if (!key) {
    return;
  }
  RESOLVE_VIDEO_CACHE.forget(key);
  forgetEdgeCache(EDGE_NAMESPACE_VIDEO, key);
  forgetPartialResolvedVideo(key);
  await forgetPersistedResolvedVideo(env, key);
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
  return {
    read,
    write,
    forget: (key) => entries.delete(key),
    clear: () => entries.clear(),
  };
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

// Emby 客户端（尤其 Android 端）在 MediaSource 缺少 Size/Bitrate 时会显示
// “SD · 0.00 MB”，并在正式取流前做一次体积/能力探测，探测失败就直接弹
// “Playback failed: Could not fetch …”。上游并不返回真实体积，这里按清晰度
// 估一个码率，再乘时长得到体积；只要能给出一个合理的非零值即可。
function estimatedMediaBitrate(isHls, height) {
  const h = Math.max(0, Number(height) || 0);
  if (h >= 2160) return 24_000_000;
  if (h >= 1440) return 12_000_000;
  if (h >= 1080) return 6_000_000;
  if (h >= 720) return 3_500_000;
  if (h > 0) return 1_800_000;
  return isHls ? 4_000_000 : 3_000_000;
}

// “解析中”是过渡状态，不应作为媒体信息显示。无论名称来自实时解析、旧缓存
// 还是上游异常数据，都在 DTO 出口统一移除，保证客户端不会首屏看到该字样。
function mediaSourceDisplayName(value, fallback) {
  const clean = (input) => String(input || "")
    .replace(/[（(]\s*解析中\s*[）)]/g, "")
    .replace(/解析中/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return clean(value) || clean(fallback) || "自动线路";
}

function mediaSource(item, requestUrl, token, video, subtitles = [], sourceId = item.Id) {
  const isHls = Boolean(
    video.inlinePlaylist ||
      /mpegurl|m3u8/i.test(video.sourceType || video.sourceUrl),
  );
  // Emby 的 DirectPlay 与设备兼容判断会读取 Container 和 Path。
  // 普通视频不能伪装成 .strm，否则部分客户端会判为不兼容或只保留第一个源。
  const container = isHls ? "m3u8" : "mp4";
  const streamExtension = isHls ? "m3u8" : "mp4";
  const mediaSourceId = String(sourceId || item.Id);
  const height = Number(video.quality || 0);
  const width = height > 0 ? Math.round((height * 16) / 9 / 2) * 2 : undefined;
  const explicitBitrate = Number(video.bitrate || video.Bitrate || 0);
  const bitrate = Number.isFinite(explicitBitrate) && explicitBitrate > 0
    ? Math.round(explicitBitrate)
    : estimatedMediaBitrate(isHls, height);
  const runtimeTicks = Math.max(
    0,
    Number(video.RunTimeTicks) || Number(item?.RunTimeTicks) || 0,
  );
  const runtimeSeconds = runtimeTicks / 10_000_000;
  const explicitSize = Number(video.size || video.Size || 0);
  // 上游多数线路没有 RunTimeTicks，旧代码此时 Size 为 undefined，客户端会
  // 显示 “SD · 0.00 MB” 并在取流前做体积探测（代理网址上常失败，弹
  // “Playback failed: Could not fetch”）。无时长时按名义时长估一个非零体积，
  // 让客户端跳过探测即可。
  const sizeSeconds = runtimeSeconds > 0 ? runtimeSeconds : 3600;
  const size = Number.isFinite(explicitSize) && explicitSize > 0
    ? Math.round(explicitSize)
    : Math.max(1, Math.round((sizeSeconds * bitrate) / 8));
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
  const streamUrl = buildStreamUrl(streamExtension);
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
    MediaSourceId: mediaSourceId,
    Name: mediaSourceDisplayName(
      video.sourceName || video.title,
      item.Name,
    ),
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
    // 非零的 Size/Bitrate 让客户端不再显示 “0.00 MB”，也跳过取流前的
    // 体积探测（该探测在代理网址上常常失败并弹 “Playback failed”）。
    Bitrate: bitrate,
    Size: size,
    DefaultAudioStreamIndex: 1,
    DefaultSubtitleStreamIndex: subtitleStreams[0]?.Index,
    MediaStreams: [
      {
        Type: "Video",
        Codec: "h264",
        CodecTag: isHls ? undefined : "avc1",
        DisplayTitle: height > 0 ? `${height}p H264 SDR` : "H264 SDR",
        IsDefault: true,
        IsForced: false,
        IsExternal: false,
        Index: 0,
        Width: width,
        Height: height || undefined,
        BitRate: bitrate,
        AspectRatio: "16:9",
        VideoRange: "SDR",
        VideoRangeType: "SDR",
        IsInterlaced: false,
        IsAVC: true,
        IsAnamorphic: false,
        TimeBase: "1/10000000",
      },
      {
        Type: "Audio",
        Codec: "aac",
        CodecTag: "mp4a",
        Language: "und",
        DisplayLanguage: "Undetermined",
        DisplayTitle: "AAC stereo",
        IsDefault: true,
        IsForced: false,
        IsExternal: false,
        Index: 1,
        Channels: 2,
        ChannelLayout: "stereo",
        SampleRate: 48000,
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
  const digest = md5(`${base}|emby-media-source-v1|${Math.max(0, Number(index) || 0)}`);
  const variant = ((Number.parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function mediaSourceVariantIndex(itemId, mediaSourceId, variantCount = 0) {
  const base = String(itemId || "");
  const value = String(mediaSourceId || "").trim();
  if (!value || value === base) return 0;
  const prefix = base + "-";
  if (value.startsWith(prefix)) {
    const number = Number(value.slice(prefix.length));
    if (Number.isInteger(number) && number > 1) return number - 1;
  }
  const count = Math.max(0, Math.floor(Number(variantCount) || 0));
  const normalized = value.toLowerCase();
  for (let index = 0; index < count; index += 1) {
    if (mediaSourceIdForIndex(base, index) === normalized) {
      return index;
    }
  }
  return -1;
}

function selectedPlaybackVideo(video, itemId, requestUrl) {
  const variants = playbackVariants(video);
  if (variants.length <= 1) return video;
  const requestedIndex = mediaSourceVariantIndex(
    itemId,
    requestUrl.searchParams.get("mediaSourceId"),
    variants.length,
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

// 播放源还在后台解析时用的“按需线路”。
// Emby 客户端在 MediaSources 为空时会把播放按钮整个藏掉（用户看到的
// “详情页没有按钮”），所以这里给一条真实可用的线路兜底：
// Path 指向本服务自己的取流接口，且不带 source 参数——真正播放时
// /Videos/{id}/stream 会现场解析真实地址再转发，不会播到假地址。
// 解析完成后客户端重新进入详情页就会拿到全部真实线路。
// 名称不再带“（解析中）”：这一屏只有在所有解析链路都没有给出线路时才出现，
// 用户看到“解析中”会以为后台还在跑并一直等；改成中性名称后详情页不再出现
// “自动线路（解析中）”字样，播放按钮仍然保留（走取流接口现场解析）。
const PENDING_MEDIA_SOURCE_NAME = "自动线路";

function pendingMediaSources(item, requestUrl, token, subtitles = []) {
  return [
    mediaSource(
      item,
      requestUrl,
      token,
      { sourceName: PENDING_MEDIA_SOURCE_NAME },
      subtitles,
      item.Id,
    ),
  ];
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
      ApplicationVersion: serverVersion(env),
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
    Version: serverVersion(env),
    BuildId: SERVER_BUILD_ID,
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

// 详情页预算必须远小于客户端自带的 HTTP 超时（Emby 客户端常见 8~10 秒），
// 否则冷启动解析还没结束，客户端已经弹“Connection timeout”，并把本次
// 详情请求当成失败，连带清掉播放记录、进度条和播放按钮。
// 因此详情页只等一个很短的窗口：命中内存/边缘/持久层旧源时能立刻返回完整
// 线路；冷缓存则先返回元数据（PlayAccess 仍为 Full，保留进度条与播放按钮），
// 真正的解析交给后台继续跑完并写进缓存，用户在 PlaybackInfo 阶段拿到线路。
// 冷启动时公共线路约 1~3 秒才发布，回退解析端冷启动实测 6~21 秒，旧值
// 3000/4500 常常“刚超一点点”，结果只能回一条占位源。7.4 秒对 9 秒的请求
// 截止时间（扣除元数据预算）仍有安全余量；超时也会优先返回 onPartial 已经
// 发布的公共线路快照，最坏才是占位源。
const ITEM_DETAIL_RESOLVE_BUDGET_MS = 7400;
// /Videos/{id}/stream 现场解析播放源的硬预算。客户端点播放后如果长时间收不到
// 任何字节，就会弹 “Connection timeout, try again later”。旧实现无预算地
// await 整条解析链（最坏 10 秒以上），还会在第一次失败后再清缓存重解析一次
// （耗时直接翻倍）。这里给它一个有界预算，超时就立刻回错误，同时后台把结果
// 写进缓存——客户端重试的那一次就能直接命中。
const STREAM_RESOLVE_BUDGET_MS = 9000;
// 重试一轮（清掉可能失效的直链后重新解析）时额外允许的时间上限。
const STREAM_RESOLVE_RETRY_BUDGET_MS = 6000;
// PlaybackInfo 是用户“点了播放”之后的请求，客户端对它的容忍度比详情页更高。
// 旧值 12 秒是在“等自建补源收尾”（实测 12~16 秒），结果客户端先超时弹
// “Connection timeout”，详情页又退回占位源。现在公共线路一发布（onPartial）
// 就提前返回，这里只是兜底上限，给回退端冷启动留出更多时间。
const PLAYBACK_INFO_RESOLVE_BUDGET_MS = 8000;
// PlaybackInfo 单独放宽整个请求的截止时间，否则会被详情页共用的 8.2 秒
// 截止时间提前截断，导致冷启动时反复 503。补源已交给后台任务，不需要 15 秒。
// 但仍须小于客户端约 10 秒的 HTTP 超时，否则客户端会先判失败并清掉播放记录。
const PLAYBACK_INFO_REQUEST_DEADLINE_MS = 9000;
// 详情页也只等一个很小的字幕窗口：播放源就绪后立刻返回会让首次打开详情
// 缺省字幕轨；冷启动字幕仍由后台任务继续完成。
const ITEM_DETAIL_SUBTITLE_WAIT_MS = 1500;
// PlaybackInfo 首次请求如果播放源已经先返回、字幕仍在解析，短暂等待，
// 避免客户端第一次点击播放拿到没有字幕轨的 MediaSource。
const PLAYBACK_INFO_SUBTITLE_WAIT_MS = 1500;

// 后台预热（prewarm）的规模与预算。
// 每次“列表 / 搜索”响应返回后都会用 ctx.waitUntil 在后台解析播放源 + 字幕，
// 但解析本身最坏要 8-16 秒（解析器合并预算 + 自建补源 + 校验）。wrangler tail
// 实测：客户端 400-600 毫秒就拿到响应，同一个 invocation 的 wallTime 却是
// 9.6s / 11.7s / 15.5s，甚至顶到 Cloudflare 的 30 秒 waitUntil 上限
// （30258 / 30366 毫秒）。这些被挂住的实例会占满整个 colo，邻近请求就直接
// 503 / 1102（Worker exceeded resource limits）。
// 因此：每次只预热 1 部（原来 3 部），并给整批预热一个 6 秒墙钟预算，
// 超时就让 waitUntil 提前结束。预热本身只是“让下次点播放快一点”的优化，
// 放弃它不影响播放源的正确性（真正点播放时还会正常解析并写缓存）。
const SEARCH_PREWARM_LIMIT = 1;
const SEARCH_PREWARM_BUDGET_MS = 6000;

// 把原始影片对象挂在结果上但保持不可枚举，JSON 响应不会泄漏内部字段。
// 搜索后续可以用真实番号预热，而不是拿 Emby Item ID 去解析。
function attachPrewarmMovies(result, movies) {
  if (!result || !Array.isArray(movies)) return result;
  const seen = new Set();
  const candidates = [];
  for (const movie of movies) {
    const code = movieResolveCode(movie);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    candidates.push(movie);
    if (candidates.length >= SEARCH_PREWARM_LIMIT) break;
  }
  Object.defineProperty(result, "prewarmMovies", {
    value: candidates,
    enumerable: false,
    configurable: true,
  });
  return result;
}

function prewarmSearchResults(result, env, fetchImpl, ctx) {
  if (!ctx || typeof ctx.waitUntil !== "function") return;
  const movies = result?.prewarmMovies;
  if (!Array.isArray(movies) || !movies.length) return;
  for (const movie of movies.slice(0, SEARCH_PREWARM_LIMIT)) {
    prewarmResolve(movie, env, fetchImpl, ctx);
  }
}

// 后台预热:不阻塞当前响应,把播放源与字幕列表解析完写进缓存,
// 下次(真正点播放时)直接命中,起播和字幕出现都更快。
function prewarmResolve(movie, env, fetchImpl, ctx = null) {
  if (!movie?.id && !movie?.number) return;
  // 播放源与字幕并行解析,不要在后台排队等两次冷启动。
  const task = Promise.all([
    resolveVideoCached(movie, env, fetchImpl, ctx).catch(() => {}),
    resolveSubtitlesCached(movie, env, fetchImpl).catch(() => {}),
  ]);
  // Worker 响应返回后后台任务可能被直接杀掉:有 ctx.waitUntil 就登记上,
  // 让预解析真正跑完,下次点播放时字幕能直接命中缓存。
  // 这里登记的是“带预算的包装”：超过 SEARCH_PREWARM_BUDGET_MS 就结束
  // waitUntil，避免上游抖动时把实例挂到 Cloudflare 的 30 秒上限。
  keepAlive(withTimeout(task, SEARCH_PREWARM_BUDGET_MS).catch(() => {}), ctx);
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

function settledWithin(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
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
  const requestDeadline = Date.now() + ITEM_REQUEST_DEADLINE_MS;
  const metadataBudgetMs = remainingRequestMs(
    requestDeadline,
    ITEM_METADATA_BUDGET_MS,
  );
  const metadataDeadline = Date.now() + metadataBudgetMs;
  const movie = await withTimeout(
    getMovieCached(id, env, fetchImpl, token, {
      deadline: metadataDeadline,
    }),
    metadataBudgetMs,
  );
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
  // 播放源与字幕彻底分开：
  // 旧写法把两者塞进同一个 Promise.all 再整体超时，字幕稍慢（冷启动约 1.5s）
  // 就会连已经解析好的播放源一起丢掉，只回退成 1 条占位源，
  // 客户端详情页因此只显示一个播放源。
  // 现在播放源单独用一份预算（能拿全所有播放源）；字幕并行启动，
  // 只在播放源就绪后短暂等待，避免首次详情响应缺少字幕轨。
  const subtitleResolution = trackResolution(
    resolveSubtitlesCached(movie, env, fetchImpl).catch(() => []),
  );
  const videoResolution = await resolveVideoForResponse(
    movie,
    env,
    fetchImpl,
    ctx,
    remainingRequestMs(
      requestDeadline,
      positiveEnvMilliseconds(
        env,
        "ITEM_DETAIL_RESOLVE_BUDGET_MS",
        ITEM_DETAIL_RESOLVE_BUDGET_MS,
      ),
    ),
  );
  video = videoResolution.video;
  const subtitleWaitMs = Math.min(
    ITEM_DETAIL_SUBTITLE_WAIT_MS,
    remainingRequestMs(requestDeadline, ITEM_DETAIL_SUBTITLE_WAIT_MS),
  );
  subtitles = subtitleResolution.record.done
    ? subtitleResolution.record.value || []
    : await settledWithin(subtitleResolution.tracked, subtitleWaitMs);
  if (!Array.isArray(subtitles)) {
    subtitles = await peekCachedSubtitles(movie, env);
  }
  if (!subtitleResolution.record.done) {
    keepAlive(subtitleResolution.tracked, ctx);
  }

  const playbackToken = token || (guestAccessEnabled(env) ? guestToken(env) : "");

  if (!video) {
    // 不论是「解析还在后台继续」「上游临时失败」还是「解析已经跑完但这一轮
    // 确实没有拿到可用线路」，这里都绝不能返回 503 / PlayAccess=None /
    // 空 MediaSources：
    //   - PlayAccess=None + 空 MediaSources 会被 Emby 客户端判为“该条目不可
    //     用”，于是把本地已经缓存的播放记录、进度条和播放按钮一起清掉
    //     （用户反复反馈的“部署后播放记录丢失 / 详情页没有播放按钮”）。
    //   - MediaSources 为空时客户端会把播放按钮整个藏掉（“详情页有时没有
    //     按钮”）。
    // 统一改回与“解析中”完全一致的按需线路：Path 指向本服务自己的取流接口
    // 且不带 source 参数，真正播放时 /Videos/{id}/stream 会现场解析真实地址
    // 再转发；PlayAccess 保持 Full；ETag 带 20 秒时间桶（pendingSources），
    // 客户端最迟 20 秒后重进详情页就会重新拉取，上游恢复或新片源上线时能自动
    // 变成真实线路，也不会再清空本地播放记录。
    const sources = pendingMediaSources(item, request.url, playbackToken, subtitles);
    item.MediaSources = sources;
    item.MediaStreams = sources[0].MediaStreams;
    item.MediaSourceCount = sources.length;
    item.Container = sources[0].Container;
    item.Path = sources[0].Path;
    item.HasSubtitles = subtitles.length > 0;
    // 艺术图同样按 20 秒时间桶换 tag，客户端重进详情页时会重新取图。
    refreshDetailBackdropTags(item);
    return itemJsonResponse(item, request, { pendingSources: true });
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
  // 详情页每 20 秒允许客户端刷新一次：解析完成后重新进入能拿到最新线路、
  // 字幕轨和艺术图，而不是客户端本地库里那份上一次部署时的旧 DTO。
  refreshDetailBackdropTags(item);
  return itemJsonResponse(item, request, { refreshSources: true });
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

// Worker 与 Pages 是两个独立部署，却绑定同一个 D1/KV。用户要求“两边观看记录
// 不要互通”，所以每个部署在自己的配置里给一个 PLAYBACK_DEPLOY_TAG，
// 由它拼进播放记录的存储 key（进度状态、删除墓碑、播放会话都跟着走）。
// 带标记的分桶互不读写；token -> 用户名 的映射仍然共用，那只是身份信息，
// 不是观看记录本身。
function playbackDeployTag(env) {
  const raw = String((env && env.PLAYBACK_DEPLOY_TAG) || "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,16}$/.test(raw) ? raw : "";
}

function playbackKeyPrefix(env) {
  const tag = playbackDeployTag(env);
  return tag ? `${PLAYBACK_STATE_KEY}:${tag}` : PLAYBACK_STATE_KEY;
}

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

function playbackDb(env) {
  const db = env && env.PLAYBACK_DB;
  return db && typeof db.prepare === "function" ? db : null;
}

function playbackDbBytes(value) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
  ) {
    return Uint8Array.from(value);
  }
  return null;
}

function parsePlaybackDbValue(value) {
  const bytes = playbackDbBytes(value);
  if (bytes) {
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    const legacyBytes = playbackDbBytes(parsed);
    return legacyBytes ? JSON.parse(new TextDecoder().decode(legacyBytes)) : parsed;
  }
  return value;
}

async function durableDbRead(db, namespace, key) {
  const row = await db
    .prepare("SELECT value FROM playback_json WHERE namespace = ? AND key = ?")
    .bind(namespace, key)
    .first();
  if (!row || row.value === null || row.value === undefined) {
    return undefined;
  }
  try {
    return parsePlaybackDbValue(row.value);
  } catch (error) {
    throw new Error(`Invalid JSON in playback store: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function durableDbWrite(db, namespace, key, value) {
  await db
    .prepare(
      "INSERT INTO playback_json (namespace, key, value, updated_at) " +
      "VALUES (?, ?, CAST(? AS TEXT), ?) " +
      "ON CONFLICT(namespace, key) DO UPDATE SET " +
      "value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(namespace, key, JSON.stringify(value), Date.now())
    .run();
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
// token -> 用户名 的映射。必须和播放记录一样走持久化存储：只写 KV 时，
// 一旦部署改成只绑定 D1（本项目的部署方式），映射就会丢，token 找不到用户名
// 会退回一个全新的 token 分桶，表现就是“部署新代码后播放记录/进度条全没了”。
const EDGE_NAMESPACE_SESSION = "session-user";
const EDGE_NAMESPACE_PLAYBACK_MIRROR = "playback-mirror-v1";
const EDGE_NAMESPACE_TOMBSTONE_MIRROR = "tombstone-mirror-v1";
const PLAYBACK_CACHE_TTL_S = 30 * 24 * 60 * 60;
// KV 读取本身可能缓存约 60 秒。把刚写入的结果短时镜像到同一机房的 Cache API，
// 可以保证“移除记录 -> 客户端立刻刷新”不会再次读到删除前的快照。
const PLAYBACK_MIRROR_CACHE_TTL_S = 30;
const PLAYBACK_LOCAL_WRITE_AUTHORITY_MS = 60 * 1000;

function durableMirrorNamespace(namespace) {
  return namespace === EDGE_NAMESPACE_TOMBSTONE
    ? EDGE_NAMESPACE_TOMBSTONE_MIRROR
    : EDGE_NAMESPACE_PLAYBACK_MIRROR;
}

// 统一入口：优先 KV（绑定了就跨机房长期保存），没绑定时退到边缘缓存。
async function durableJsonRead(env, namespace, key) {
  const db = playbackDb(env);
  if (db) {
    try {
      const value = await durableDbRead(db, namespace, key);
      if (value !== undefined) {
        return value;
      }
      // D1 是后来才启用的：旧部署里可能已经有 KV 数据，首次读取时迁移。
      const kv = playbackKv(env);
      if (kv) {
        const legacy = await kv.get(key, "json");
        if (legacy !== null && legacy !== undefined) {
          await durableDbWrite(db, namespace, key, legacy);
          return legacy;
        }
      }
      return null;
    } catch (error) {
      console.error(JSON.stringify({
        message: "Playback D1 read failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      // 读取失败时继续走 KV / Edge Cache，避免数据库故障让播放记录完全不可用。
    }
  }
  const kv = playbackKv(env);
  if (kv) {
    // 新写入的短时镜像只在当前机房有效，但能绕开 KV 的读取缓存，
    // 避免删除或真正重播后，紧接着刷新又读到旧快照。
    const mirrored = await edgeCacheRead(durableMirrorNamespace(namespace), key);
    if (mirrored !== undefined) {
      return mirrored;
    }
    try {
      const value = await kv.get(key, "json", { cacheTtl: 30 });
      if (value !== null && value !== undefined) {
        return value;
      }
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
  const db = playbackDb(env);
  if (db) {
    try {
      await durableDbWrite(db, namespace, key, value);
    } catch (error) {
      console.error(JSON.stringify({
        message: "Playback D1 write failed",
        namespace,
        error: error instanceof Error ? error.message : String(error),
      }));
      // D1 一旦绑定就是权威存储。这里绝不能悄悄退回 KV/Cache 后仍告诉客户端
      // 写入成功，否则删除墓碑可能落在一台边缘实例而其他实例继续读到旧进度。
      throw new Error("Playback state persistence failed");
    }
    await edgeCacheWrite(
      durableMirrorNamespace(namespace),
      key,
      value,
      PLAYBACK_MIRROR_CACHE_TTL_S,
    );
    return;
  }
  const kv = playbackKv(env);
  let kvWriteSucceeded = false;
  if (kv) {
    try {
      await kv.put(key, JSON.stringify(value));
      kvWriteSucceeded = true;
    } catch (error) {
      console.error(JSON.stringify({
        message: "Playback store write failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  if (kvWriteSucceeded) {
    await edgeCacheWrite(
      durableMirrorNamespace(namespace),
      key,
      value,
      PLAYBACK_MIRROR_CACHE_TTL_S,
    );
    return;
  }
  // 没有 KV 或 KV 写入失败时，仍然使用原有长期边缘缓存作为持久化兜底。
  await edgeCacheWrite(namespace, key, value, PLAYBACK_CACHE_TTL_S);
}

const MEMORY_PLAYBACK_STATES = new Map();
const MEMORY_PLAYBACK_STATE_WRITES = new Map();

function rememberPlaybackState(key, state, opts = {}) {
  try {
    MEMORY_PLAYBACK_STATES.set(key, state || {});
    if (opts.localWrite === true) {
      MEMORY_PLAYBACK_STATE_WRITES.set(key, Date.now());
    } else {
      MEMORY_PLAYBACK_STATE_WRITES.delete(key);
    }
    if (MEMORY_PLAYBACK_STATES.size > MAX_MEMORY_PLAYBACK_STATES) {
      const oldestKey = MEMORY_PLAYBACK_STATES.keys().next().value;
      if (oldestKey !== undefined) {
        MEMORY_PLAYBACK_STATES.delete(oldestKey);
        MEMORY_PLAYBACK_STATE_WRITES.delete(oldestKey);
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
  const hasStateKey = Boolean(
    extra && typeof extra.stateKey === "string" && extra.stateKey,
  );
  if (!token || (!username && !hasStateKey)) return;
  try {
    const record = { at: Date.now() };
    if (username) {
      record.username = String(username);
    }
    if (deviceId) {
      record.deviceId = String(deviceId);
    }
    if (extra && extra.trusted) {
      record.trusted = true;
    }
    if (extra && typeof extra.stateKey === "string" && extra.stateKey) {
      record.stateKey = extra.stateKey;
    }
    // 走统一持久化入口：D1 绑定存在时写 D1，只有 KV 时写 KV，都没有时退到
    // 边缘缓存。这样无论部署形态怎么变，token -> 用户名 的映射都不会丢。
    await durableJsonWrite(env, EDGE_NAMESPACE_SESSION, sessionUserKey(token), record);
  } catch (error) {
    console.error(JSON.stringify({
      message: "Session user mapping write failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function lookupSessionRecord(env, token) {
  if (!token) return null;
  try {
    const value = await durableJsonRead(env, EDGE_NAMESPACE_SESSION, sessionUserKey(token));
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

// 旧部署只绑定了 KV 时，token -> 用户名 的映射会随 KV 缺失而丢失，
// 老 token 只能落到一个全新的、空的 token 分桶，表现为“记录/进度条全消失”。
// 这里做一次一次性恢复：D1 里如果只存在唯一一个“用户名分桶”，就把该分桶
// 认作当前账号并写回映射。多用户部署不会满足“唯一”条件，会安全地保持原行为。
async function soleUsernamePlaybackKey(env) {
  const db = playbackDb(env);
  if (!db) return "";
  try {
    const rows = await db
      .prepare(
        "SELECT key FROM playback_json WHERE namespace = ? AND key LIKE ? LIMIT 2",
      )
      .bind(EDGE_NAMESPACE_PLAYBACK, `${playbackKeyPrefix(env)}:u:%`)
      .all();
    const list = Array.isArray(rows?.results) ? rows.results : [];
    if (list.length === 1 && list[0] && typeof list[0].key === "string") {
      return list[0].key;
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: "Playback username bucket lookup failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return "";
}

// —— 旧 token 分桶 → 用户名分桶 一次性迁移 ——
// 历史版本把进度存在 token 分桶里。token -> 用户名 的映射一旦丢失（例如从 KV
// 切换到 D1、或换了部署方式），新代码会去读一个空的“用户名分桶”，表现就是
// “部署新代码后播放记录、进度条全消失”。这里在用户名分桶为空时，把同一用户
// 的历史 token 分桶（连同删除墓碑）合并进用户名分桶，之后只写用户名分桶。
//
// 安全前提：只有能确定这些旧分桶属于当前用户时才合并——
//   1. 当前 token 自己的分桶（映射关系是确定的）；
//   2. session-user 表里登记为同一用户名的 token 分桶；
//   3. 整个部署只出现过“唯一一个用户名”时，才把没有登记归属的孤儿 token
//      分桶视为该用户的历史数据（单用户部署的恢复路径）。多用户名部署不会
//      满足这个条件，会安全地放弃合并，绝不抢占别人的记录。
const MEMORY_PLAYBACK_MIGRATION_GUARDS = new Set();
const PLAYBACK_MIGRATION_MARKER_PREFIX = "migrate-v1:";
const PLAYBACK_MIGRATION_MAX_SESSION_ROWS = 500;
const PLAYBACK_MIGRATION_MAX_BUCKET_ROWS = 500;
const TOKEN_BUCKET_SUFFIX_RE = /^:[0-9a-f]{32}$/i;

function playbackMigrationMarkerKey(username) {
  return `${SESSION_USER_KEY_PREFIX}${PLAYBACK_MIGRATION_MARKER_PREFIX}${
    md5(normalizedLoginName(username))
  }`;
}

function sessionTokenHash(key) {
  const suffix = String(key || "").slice(SESSION_USER_KEY_PREFIX.length);
  return /^[0-9a-f]{32}$/i.test(suffix) ? suffix.toLowerCase() : "";
}

// 扫描 token -> 用户名 映射表，解析出每个 token 对应的用户名。
async function scanSessionUserRecords(env) {
  const db = playbackDb(env);
  if (!db) return [];
  const rows = await db
    .prepare(
      "SELECT key, value FROM playback_json WHERE namespace = ? AND key LIKE ? LIMIT ?",
    )
    .bind(EDGE_NAMESPACE_SESSION, `${SESSION_USER_KEY_PREFIX}%`, PLAYBACK_MIGRATION_MAX_SESSION_ROWS)
    .all();
  const list = Array.isArray(rows?.results) ? rows.results : [];
  const records = [];
  for (const row of list) {
    const hash = sessionTokenHash(row && row.key);
    if (!hash) continue;
    let value;
    try {
      value = parsePlaybackDbValue(row.value);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    records.push({
      hash,
      username: String(value.username || ""),
      stateKey: String(value.stateKey || ""),
    });
  }
  return records;
}

// 读出所有“播放状态”分桶（含旧的 token 分桶和用户名分桶），用于合并。
async function scanPlaybackBuckets(env) {
  const db = playbackDb(env);
  if (!db) return new Map();
  const rows = await db
    .prepare(
      "SELECT key, value FROM playback_json WHERE namespace = ? AND key LIKE ? LIMIT ?",
    )
    .bind(
      EDGE_NAMESPACE_PLAYBACK,
      `${playbackKeyPrefix(env)}%`,
      PLAYBACK_MIGRATION_MAX_BUCKET_ROWS,
    )
    .all();
  const list = Array.isArray(rows?.results) ? rows.results : [];
  const buckets = new Map();
  for (const row of list) {
    const key = row && typeof row.key === "string" ? row.key : "";
    if (!key) continue;
    let value;
    try {
      value = parsePlaybackDbValue(row.value);
    } catch {
      continue;
    }
    buckets.set(key, value && typeof value === "object" && !Array.isArray(value) ? value : {});
  }
  return buckets;
}

// 一次读出所有墓碑分桶：迁移时逐个 readTombstones 会多打几倍的 D1 查询，
// 冷启动那一次请求本来就很敏感，这里合并成单条查询。
async function scanTombstoneStores(env) {
  const db = playbackDb(env);
  if (!db) return new Map();
  const rows = await db
    .prepare(
      "SELECT key, value FROM playback_json WHERE namespace = ? AND key LIKE ? LIMIT ?",
    )
    .bind(EDGE_NAMESPACE_TOMBSTONE, `%${PLAYBACK_TOMBSTONE_SUFFIX}`, PLAYBACK_MIGRATION_MAX_BUCKET_ROWS)
    .all();
  const list = Array.isArray(rows?.results) ? rows.results : [];
  const stores = new Map();
  for (const row of list) {
    const key = row && typeof row.key === "string" ? row.key : "";
    if (!key.endsWith(PLAYBACK_TOMBSTONE_SUFFIX)) continue;
    let value;
    try {
      value = parsePlaybackDbValue(row.value);
    } catch {
      continue;
    }
    const stateKey = key.slice(0, -PLAYBACK_TOMBSTONE_SUFFIX.length);
    stores.set(stateKey, tombstoneStore(value));
  }
  return stores;
}

// 同一部片在多个分桶里各有一条记录时，保留“最近看过”的那条；时间相同再比较
// 播放进度与已播标记，避免恢复出来的进度条停在更早的位置。
function mergePlaybackRecord(left, right) {
  if (!left) return right;
  if (!right) return left;
  const leftMs = recordTimestampMs(left);
  const rightMs = recordTimestampMs(right);
  if (rightMs !== leftMs) return rightMs > leftMs ? right : left;
  const leftTicks = Math.max(0, Number(left.positionTicks) || 0);
  const rightTicks = Math.max(0, Number(right.positionTicks) || 0);
  if (rightTicks !== leftTicks) return rightTicks > leftTicks ? right : left;
  if (Boolean(right.played) !== Boolean(left.played)) {
    return right.played ? right : left;
  }
  return left;
}

async function migrateLegacyPlaybackBuckets(env, username, token, destinationKey) {
  const name = normalizedLoginName(username);
  if (!name || !destinationKey) return false;
  const sessions = await scanSessionUserRecords(env);
  const usernames = new Set(
    sessions.map((record) => normalizedLoginName(record.username)).filter(Boolean),
  );
  // 只有“当前部署只出现过这一个用户名”时，才敢认领没有归属登记的孤儿分桶。
  const soleUser = usernames.size === 1 && usernames.has(name);
  const ownedHashes = new Set();
  const ownHash = playbackTokenPart(token);
  if (ownHash) ownedHashes.add(ownHash);
  for (const record of sessions) {
    if (normalizedLoginName(record.username) === name) ownedHashes.add(record.hash);
    // 已经被迁移过的 token 会直接登记目标分桶 key，跟着一起认领。
    if (record.stateKey === destinationKey) ownedHashes.add(record.hash);
  }
  const buckets = await scanPlaybackBuckets(env);
  const sourceKeys = [];
  const keyPrefix = playbackKeyPrefix(env);
  for (const key of buckets.keys()) {
    if (key === destinationKey) continue;
    const suffix = key.slice(keyPrefix.length);
    // 别的账号的用户名分桶绝不合并。
    if (suffix.startsWith(":u:")) continue;
    if (TOKEN_BUCKET_SUFFIX_RE.test(suffix)) {
      const hash = suffix.slice(1).toLowerCase();
      if (!soleUser && !ownedHashes.has(hash)) continue;
      sourceKeys.push(key);
      continue;
    }
    // 无账号的旧部署会把进度写进基础分桶；仍按“唯一用户”条件决定是否认领。
    if (suffix === "" && soleUser) sourceKeys.push(key);
  }
  if (sourceKeys.length === 0) return false;

  const tombstoneStores = await scanTombstoneStores(env);
  const mergedTombstones = {};
  for (const key of sourceKeys) {
    const store = tombstoneStores.get(key) || {};
    for (const itemId of Object.keys(store || {})) {
      const marker = normalizeTombstone(store[itemId]);
      if (!marker) continue;
      const existing = normalizeTombstone(mergedTombstones[itemId]);
      if (!existing || marker.at > existing.at) mergedTombstones[itemId] = marker;
    }
  }

  const merged = {};
  for (const key of sourceKeys) {
    const bucket = buckets.get(key) || {};
    for (const itemId of Object.keys(bucket)) {
      if (itemId === "__removedAt") continue;
      const record = bucket[itemId];
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      merged[itemId] = mergePlaybackRecord(merged[itemId], record);
    }
  }

  // 先把合并后的墓碑落盘，再按墓碑剪掉被删过的条目，避免旧分桶把“已移除”
  // 的记录又带回来（这正是用户反馈的“删除记录后又出现”）。
  const destinationTombstones = await readTombstones(env, destinationKey, { fresh: true })
    .catch(() => ({}));
  for (const itemId of Object.keys(mergedTombstones)) {
    const existing = normalizeTombstone(destinationTombstones[itemId]);
    const incoming = mergedTombstones[itemId];
    if (!existing || incoming.at >= existing.at) destinationTombstones[itemId] = incoming;
  }
  await writeTombstones(env, destinationKey, destinationTombstones);
  filterStateByTombstones(merged, destinationTombstones);
  await writePlaybackStateByKey(env, destinationKey, merged);
  await durableJsonWrite(env, EDGE_NAMESPACE_SESSION, playbackMigrationMarkerKey(name), {
    at: Date.now(),
    username: name,
    sources: sourceKeys,
  });
  console.log(JSON.stringify({
    message: "Migrated legacy playback buckets",
    username: name,
    destination: destinationKey,
    sources: sourceKeys,
    items: Object.keys(merged).length,
  }));
  return true;
}

// 每次实例冷启动最多检查一次：用户名分桶已经有数据（或已经迁移过）就直接跳过，
// 不给每个请求都加一次全表扫描。
async function ensureLegacyPlaybackMigration(env, token, username, key) {
  if (!username || !token || !key) return;
  if (!key.startsWith(`${playbackKeyPrefix(env)}:u:`)) return;
  if (!playbackDb(env)) return;
  const guard = `${key}|${playbackTokenPart(token)}`;
  if (MEMORY_PLAYBACK_MIGRATION_GUARDS.has(guard)) return;
  try {
    const marker = await durableJsonRead(
      env,
      EDGE_NAMESPACE_SESSION,
      playbackMigrationMarkerKey(username),
    );
    if (marker && typeof marker === "object") {
      MEMORY_PLAYBACK_MIGRATION_GUARDS.add(guard);
      return;
    }
    const existing = await durableJsonRead(env, EDGE_NAMESPACE_PLAYBACK, key);
    if (existing && typeof existing === "object" && Object.keys(existing).length > 0) {
      MEMORY_PLAYBACK_MIGRATION_GUARDS.add(guard);
      return;
    }
    await migrateLegacyPlaybackBuckets(env, username, token, key);
    MEMORY_PLAYBACK_MIGRATION_GUARDS.add(guard);
  } catch (error) {
    console.error(JSON.stringify({
      message: "Legacy playback migration failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

// —— 升级前“共享分桶”的一次性收养 ——
// 旧版本的 key 里没有部署标记，Worker 与 Pages 因此共用同一份播放记录。
// 现在两边各用带标记的分桶后，旧分桶在新分桶里是看不到的。用户对“记录消失”
// 非常敏感，所以每个部署在首次为某个账号建桶时，把旧的无标记分桶整份复制
// 一次（连同删除墓碑），之后各写各的、互不影响。
// 用 SESSION 表里的标记保证“只收养一次”：否则用户把记录删空后（分桶变空），
// 旧分桶的数据会被重新灌回来——正是“删除记录后又出现”的老问题。
const MEMORY_LEGACY_ADOPT_GUARDS = new Set();

function legacyAdoptMarkerKey(env, key) {
  const tag = playbackDeployTag(env) || "shared";
  return `${SESSION_USER_KEY_PREFIX}${PLAYBACK_MIGRATION_MARKER_PREFIX}adopt:${
    md5(`${tag}|${key}`)
  }`;
}

// 去掉部署标记后得到的旧 key（两者指向同一批历史数据）。
function legacyUntaggedPlaybackKey(env, key) {
  const prefix = playbackKeyPrefix(env);
  if (!key.startsWith(prefix)) return "";
  const legacy = PLAYBACK_STATE_KEY + key.slice(prefix.length);
  return legacy === key ? "" : legacy;
}

async function adoptLegacyPlaybackBucket(env, key) {
  const legacyKey = legacyUntaggedPlaybackKey(env, key);
  if (!legacyKey) return;
  const marker = legacyAdoptMarkerKey(env, key);
  if (MEMORY_LEGACY_ADOPT_GUARDS.has(marker)) return;
  try {
    if (await durableJsonRead(env, EDGE_NAMESPACE_SESSION, marker)) {
      MEMORY_LEGACY_ADOPT_GUARDS.add(marker);
      return;
    }
    const existing = await durableJsonRead(env, EDGE_NAMESPACE_PLAYBACK, key);
    const hasOwn = existing && typeof existing === "object" &&
      Object.keys(existing).length > 0;
    const legacy = hasOwn
      ? undefined
      : await durableJsonRead(env, EDGE_NAMESPACE_PLAYBACK, legacyKey);
    const hasLegacy = legacy && typeof legacy === "object" &&
      Object.keys(legacy).length > 0;
    if (hasLegacy) {
      // 先搬墓碑再灌进度：删除过的条目必须先立好墓碑，否则会被历史数据带回来。
      const legacyTombstones = await durableJsonRead(
        env,
        EDGE_NAMESPACE_TOMBSTONE,
        legacyKey + PLAYBACK_TOMBSTONE_SUFFIX,
      ).catch(() => null);
      if (legacyTombstones && typeof legacyTombstones === "object") {
        const own = await readTombstones(env, key, { fresh: true }).catch(() => ({}));
        await writeTombstones(env, key, { ...legacyTombstones, ...own });
      }
      await writePlaybackStateByKey(env, key, legacy);
      console.log(JSON.stringify({
        message: "Adopted legacy playback bucket",
        tag: playbackDeployTag(env),
        key,
      }));
    }
    await durableJsonWrite(env, EDGE_NAMESPACE_SESSION, marker, {
      at: Date.now(),
      adopted: Boolean(hasLegacy),
    });
    MEMORY_LEGACY_ADOPT_GUARDS.add(marker);
  } catch (error) {
    console.error(JSON.stringify({
      message: "Legacy playback bucket adoption failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function playbackStateKey(env, token) {
  const scope = String(token || "").trim();
  const keyPrefix = playbackKeyPrefix(env);
  if (!scope || scope === guestToken(env)) {
    // 访客分桶也要收养：旧版本 Worker 与 Pages 共用的就是这个无标记分桶。
    await adoptLegacyPlaybackBucket(env, keyPrefix);
    return keyPrefix;
  }
  const cached = MEMORY_PLAYBACK_KEYS.get(scope);
  if (cached && Date.now() - cached.at < PLAYBACK_KEY_CACHE_MS) {
    return cached.key;
  }
  const record = await lookupSessionRecord(env, scope);
  const username = record && record.username ? String(record.username) : "";
  let key = "";
  if (record && typeof record.stateKey === "string" && record.stateKey) {
    // 恢复出来的映射直接记的是分桶 key（原始用户名已不可考）。
    key = record.stateKey;
  } else if (username) {
    key = `${keyPrefix}:u:${md5(username)}`;
  }
  if (!key) {
    // 先看这个 token 自己有没有历史分桶；有就照旧用，绝不抢占别的账号。
    const tokenScopedKey = `${keyPrefix}:${playbackTokenPart(scope)}`;
    const ownValue = await durableJsonRead(env, EDGE_NAMESPACE_PLAYBACK, tokenScopedKey)
      .catch(() => undefined);
    if (ownValue && typeof ownValue === "object" && Object.keys(ownValue).length > 0) {
      key = tokenScopedKey;
    } else {
      const adopted = await soleUsernamePlaybackKey(env);
      if (adopted) {
        key = adopted;
        await storeSessionUser(env, scope, "", "", {
          trusted: true,
          stateKey: adopted,
        });
      }
    }
  }
  if (!key) {
    key = `${keyPrefix}:${playbackTokenPart(scope)}`;
  }
  // SESSION 里可能存着升级前写的“无部署标记”key。把它映射到本部署的同名
  // 分桶（随后由收养逻辑把旧数据整份复制过来）；绝不能直接换成 token 分桶，
  // 那等于把用户已有的观看记录丢掉。
  //
  // ⚠️ 这里的判定顺序曾经写反了：先判断“key 是否以 PLAYBACK_STATE_KEY 开头”，
  // 而 `playback-state-v1:pages:u:<hash>` 也满足这个条件，于是又被拼了一次
  // 部署标记，得到 `playback-state-v1:pages:pages:u:<hash>`。
  // 客户端此后读写的永远是一个空分桶，用户看到的就是“部署新代码后播放记录
  // 全部消失”。必须先收敛“重复拼出来的标记”，再给“确实没有标记的旧 key”补标记。
  const tag = playbackDeployTag(env);
  if (tag) {
    // playback-state-v1:pages:pages:u:<hash> → playback-state-v1:pages:u:<hash>
    const doubled = `${keyPrefix}:${tag}`;
    while (key.startsWith(`${doubled}:`) || key === doubled) {
      key = keyPrefix + key.slice(doubled.length);
    }
  }
  if (key.startsWith(`${keyPrefix}:`) || key === keyPrefix) {
    // 已经是本部署的分桶，原样保留。
  } else if (key === PLAYBACK_STATE_KEY || key.startsWith(`${PLAYBACK_STATE_KEY}:`)) {
    key = `${keyPrefix}${key.slice(PLAYBACK_STATE_KEY.length)}`;
  }
  if (!key.startsWith(`${keyPrefix}:`) && key !== keyPrefix) {
    key = `${keyPrefix}:${playbackTokenPart(scope)}`;
  }
  await adoptLegacyPlaybackBucket(env, key);
  if (username || key.startsWith(`${keyPrefix}:u:`)) {
    await ensureLegacyPlaybackMigration(env, scope, username, key);
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
  const writeAt = Number(MEMORY_PLAYBACK_STATE_WRITES.get(key) || 0);
  const dbBacked = playbackDb(env) !== null;
  // D1 模式下不能信任某实例的短时本地写缓存：同一账号的删除/重播请求可能落到
  // 不同实例，旧实例若在 60 秒内直接返回自己的快照，会让新写入在部分域名不可见。
  if (
    !dbBacked &&
    memoryState && typeof memoryState === "object" &&
    writeAt > 0 &&
    Date.now() - writeAt <= PLAYBACK_LOCAL_WRITE_AUTHORITY_MS
  ) {
    return memoryState;
  }
  const value = await durableJsonRead(env, EDGE_NAMESPACE_PLAYBACK, key);
  if (value && typeof value === "object") {
    rememberPlaybackState(key, value);
    return value;
  }
  if (dbBacked && value !== undefined) {
    // D1 明确没有这行时，空状态就是权威结果；不能退回可能已过期的实例内存快照。
    return {};
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
  filterStateByTombstones(next, store);
  rememberPlaybackState(key, next, { localWrite: true });
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

function tombstoneStore(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
    pendingPlaySessionId: String(raw.pendingPlaySessionId || ""),
    pendingAt: Math.max(0, Number(raw.pendingAt) || 0),
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

function rememberTombstones(key, store, opts = {}) {
  try {
    const now = Date.now();
    MEMORY_PLAYBACK_TOMBSTONES.set(key, {
      store: tombstoneStore(store),
      at: now,
      writtenAt: opts.localWrite === true ? now : 0,
    });
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
  const fallback = tombstoneStore(cached && cached.store);
  const dbBacked = playbackDb(env) !== null;
  // 短时缓存：进度上报很频繁，不能每次都多读一次持久化存储。
  // 即使因此晚几秒才拿到别的实例刚写的墓碑也没关系：脏记录的时间戳早于移除
  // 时间，缓存过期后下一次读取仍会被剪掉。
  // D1 是强一致源。若仍复用实例内存缓存，真正重播已清墓碑后，其他实例可能继续
  // 用旧墓碑过滤新进度，表现为同一用户在不同域名刷新时记录时有时无。因此 D1
  // 模式下跳过墓碑短缓存，始终读取数据库最新值。
  if (
    !opts.fresh &&
    !dbBacked &&
    cached &&
    Date.now() - cached.at < PLAYBACK_TOMBSTONE_CACHE_MS
  ) {
    return tombstoneStore(cached.store);
  }
  const value = await durableJsonRead(env, EDGE_NAMESPACE_TOMBSTONE, key);
  if (value === undefined) {
    // 读取失败：沿用上一次的表，绝不把它当成“墓碑全没了”。
    return fallback;
  }
  // 旧版本曾把该行写成 JSON 数组。数组上的命名属性无法被 JSON.stringify
  // 持久化，必须丢弃并重建为普通对象，否则新立的墓碑仍会静默丢失。
  const store = tombstoneStore(value);
  pruneTombstoneStore(store);
  // 即使读到的是空表也要记进内存缓存（短时），保持原有的“同实例 5 秒”语义。
  rememberTombstones(key, store);
  return store;
}

async function writeTombstones(env, stateKey, store) {
  const key = playbackTombstoneKey(stateKey);
  const next = tombstoneStore(store);
  pruneTombstoneStore(next);
  rememberTombstones(key, next, { localWrite: true });
  await durableJsonWrite(env, EDGE_NAMESPACE_TOMBSTONE, key, next);
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
// 返回 changed=记录是否被改动。墓碑只能由 playbackWriteSuppressed 明确放行，
// 读取阶段绝不能因为 startedAt 或新会话号自行作废墓碑。
function filterStateByTombstones(state, store) {
  const result = { changed: false };
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
    pendingPlaySessionId: "",
    pendingAt: 0,
  };
  // 即使当时手上没有这条记录也要立墓碑：并发的旧快照可能正把它写回来。
  await writeTombstones(env, key, store);
  return Boolean(old);
}

const PLAYBACK_REPLAY_CONFIRM_TICKS = 5 * 60 * 10_000_000;

// 墓碑只挡“被移除的那一次播放”补发的残留上报，绝不能永久封锁条目：
// 用户移除记录之后重新点播（客户端常常直接从中途续播）必须能重新生成记录。
// 判据用播放会话号，而不是“抑制期是否结束”：
//   - 会话号与移除时相同 → 就是那次播放的残留（客户端刷新后补发的高进度同样带着它）；
//   - 明确发出“开始播放”且会话号与移除时不同（或客户端根本不带会话号）→ 新的一次播放；
//   - 会话号不同 → 新的播放。
// 关键点：只要有“开始播放”这个明确信号就放行。旧实现只认“同一会话 + 进度回到 5 分钟内”，
// 于是不带会话号、或者直接从中途续播的客户端永远解不开墓碑（“删了记录再也记不上”）。
const TOMBSTONE_CLEAR = "clear";
const TOMBSTONE_PENDING = "pending";
const TOMBSTONE_BLOCK = "block";

function decideTombstoneWrite(marker, opts = {}) {
  const removedSession = String((marker && marker.playSessionId) || "");
  const session = String(opts.playSessionId || "");
  const positionTicks = Math.max(0, Number(opts.positionTicks) || 0);
  const removedPosition = Math.max(0, Number(marker && marker.positionTicks) || 0);
  const startedPlayback = opts.restarted === true;
  const pendingSession = String((marker && marker.pendingPlaySessionId) || "");
  // 之前登记过“待确认重播会话”：同一会话随后上报合理低进度，就是用户从头重播。
  if (pendingSession && session && pendingSession === session && positionTicks > 0) {
    if (removedPosition > 0 && positionTicks >= removedPosition) return TOMBSTONE_BLOCK;
    if (positionTicks <= PLAYBACK_REPLAY_CONFIRM_TICKS) return TOMBSTONE_CLEAR;
  }
  if (startedPlayback) {
    // 同一个会话号又报“开始播放”：多半是同一会话的重复通告，只有在片头附近
    // 才先记成待确认，等它真的播起来（低进度）再撤墓碑；进度不为 0 时按残留处理。
    if (!session || session !== removedSession) return TOMBSTONE_CLEAR;
    return positionTicks === 0 ? TOMBSTONE_PENDING : TOMBSTONE_BLOCK;
  }
  // 进度 / 暂停 / 停止等上报：只有会话号明确不同才算新播放，否则按残留忽略。
  if (removedSession && session && session !== removedSession) return TOMBSTONE_CLEAR;
  return TOMBSTONE_BLOCK;
}

async function clearPlaybackTombstone(env, key, itemId) {
  const latest = await readTombstones(env, key, { fresh: true });
  if (latest[itemId]) {
    delete latest[itemId];
    await writeTombstones(env, key, latest);
  }
}

// 统一的闸门：返回 true 表示这次写入属于“移除之后补发的残留”，应当忽略。
async function playbackWriteSuppressed(env, token, itemId, opts = {}) {
  if (!itemId) return false;
  const key = await playbackStateKey(env, token);
  // 播放器会并发发出开始播放和进度上报，它们可能落到不同实例。
  // 必须读取 D1 中最新墓碑，才能看到另一个实例刚写入的“待确认重播会话”。
  const store = await readTombstones(env, key, { fresh: true });
  const marker = normalizeTombstone(store[itemId]);
  if (!marker) return false;
  const explicitAction = opts.explicit === true;
  if (explicitAction) {
    await clearPlaybackTombstone(env, key, itemId);
    return false;
  }

  const decision = decideTombstoneWrite(marker, opts);
  if (decision === TOMBSTONE_CLEAR) {
    await clearPlaybackTombstone(env, key, itemId);
    return false;
  }

  if (decision === TOMBSTONE_PENDING) {
    const playSessionId = String(opts.playSessionId || "");
    if (playSessionId) {
      const latest = await readTombstones(env, key, { fresh: true });
      const latestMarker = normalizeTombstone(latest[itemId]);
      if (latestMarker) {
        latest[itemId] = {
          ...latestMarker,
          pendingPlaySessionId: playSessionId,
          pendingAt: Date.now(),
        };
        await writeTombstones(env, key, latest);
      }
    }
  }
  return true;
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

// 各接口上报的播放会话号（body / query 上的写法不一），用于判断“新播放 / 旧残留”。
function pickPlaySessionId(body, params) {
  const value = pickUserDataValue(body, params, ["PlaySessionId", "playSessionId"]);
  return String(value === undefined || value === null ? "" : value).trim();
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

// imageType: Primary（封面）/ Backdrop（艺术图）。Backdrop 取上游预览剧照；
// 指定下标越界或没有剧照时退回封面，保证客户端不会拿到 404 空白图。
async function imageResponse(id, request, env, fetchImpl, token, options = {}) {
  const imageType = String(options.imageType || "Primary").toLowerCase();
  const imageIndex = Math.max(0, Number(options.imageIndex) || 0);
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
  const cover = movie?.cover_url || movie?.thumb_url || "";
  const backdrops = movieBackdropImages(movie);
  const picked = imageType === "backdrop" ? backdrops[imageIndex] || "" : "";
  const imageUrl = safeMediaUrl(picked || cover, env);
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

async function streamResponse(id, request, env, fetchImpl, token, ctx = null) {
  if (!token && !guestAccessEnabled(env)) {
    return errorResponse(401, "Emby token is required for playback");
  }

  try {
    const requestUrl = new URL(request.url);
    const suppliedSourceValue = ["source", "sourceUrl", "source_url", "url"]
      .map((name) => requestUrl.searchParams.get(name))
      .find(Boolean);
    const suppliedSource = safeMediaUrl(suppliedSourceValue, env);

    const triedSources = new Set();
    let lastStatus = 404;
    // “拿到上游响应头”的总预算：多线路逐条换线时共用，避免所有线路都挂起时
    // 请求无限延长。重试一轮前会重置。
    let streamHeadersDeadline = Date.now() +
      positiveEnvMilliseconds(
        env,
        "STREAM_HEADERS_BUDGET_MS",
        STREAM_HEADERS_BUDGET_MS,
      );
    const tryVideo = async (video) => {
      const candidates = [video, ...(video?.alternates || [])].filter(Boolean);
      for (const candidate of candidates) {
        if (candidate.inlinePlaylist) {
          const inlineUrl = `${upstreamOrigin(env)}/${encodeURIComponent(id)}.m3u8`;
          const playlist = rewriteHlsManifest(
            candidate.inlinePlaylist,
            inlineUrl,
            request.url,
            0,
          );
          return new Response(
            request.method === "HEAD" ? null : playlist,
            {
              status: 200,
              headers: {
                "access-control-allow-origin": "*",
                "access-control-expose-headers":
                  "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
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
        const hlsManifest = isHlsManifestSource(
          sourceUrl.toString(),
          candidate.sourceType || "",
        );
        const upstream = await fetchMediaUpstreamResponse(
          request,
          sourceUrl.toString(),
          env,
          fetchImpl,
          { hlsManifest, headersDeadline: streamHeadersDeadline },
        );
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

        const response = await proxyMediaResponse(
          upstream,
          sourceUrl.toString(),
          request,
          env,
          0,
        );
        response.headers.set(
          "content-disposition",
          `inline; filename="${encodeURIComponent(id)}.${/mpegurl|m3u8/i.test(candidate.sourceType || candidate.sourceUrl) || isHlsResponse(upstream, sourceUrl) ? "m3u8" : "mp4"}"`,
        );
        if (!response.headers.has("content-type")) {
          response.headers.set("content-type", candidate.sourceType || "video/mp4");
        }
        return response;
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
    const streamPartial = { video: null };
    let streamPartialSignal = null;
    const streamPartialReady = new Promise((resolve) => {
      streamPartialSignal = resolve;
    });
    const streamResolveTask = resolveVideoCached(
      movieForStream,
      env,
      fetchImpl,
      ctx,
      {
        onPartial: (video) => {
          streamPartial.video = video;
          if (streamPartialSignal) {
            try {
              streamPartialSignal();
            } catch {
              // 唤醒失败不影响解析。
            }
          }
        },
      },
    );
    let resolvedVideo = null;
    // 与 resolveVideoForResponse 同样“不等自建补源收尾”：公共线路一到就用它
    // 起播，避免客户端点播放后长时间收不到任何字节而弹
    // “Connection timeout, try again later”。补源在后台继续跑并写缓存。
    const streamEarly = await withTimeout(
      Promise.race([
        streamResolveTask.then(
          (video) => ({ kind: "done", video }),
          () => ({ kind: "unfinished" }),
        ),
        streamPartialReady.then(
          () => new Promise((resolve) => {
            setTimeout(() => resolve({ kind: "partial" }), 300);
          }),
        ),
      ]),
      positiveEnvMilliseconds(
        env,
        "STREAM_RESOLVE_BUDGET_MS",
        STREAM_RESOLVE_BUDGET_MS,
      ),
    ).catch(() => null);
    if (streamEarly && streamEarly.kind === "done") {
      resolvedVideo = streamEarly.video;
    } else {
      // 快照已到但补源没收尾，或预算彻底用尽：后台继续跑完并写缓存。
      // 本次先用已经解析出的线路试播（有就立即播放），客户端重试时命中缓存。
      keepAlive(streamResolveTask.catch(() => null), ctx);
      resolvedVideo = isUsableResolvedVideo(streamPartial.video)
        ? streamPartial.video
        : await peekPartialResolvedVideo(movieForStream, env);
    }
    const response = await tryVideo(selectedPlaybackVideo(resolvedVideo, id, requestUrl));
    if (response) {
      return response;
    }
    // 缓存里那份直链已经失效（媒体源拒绝）：清掉缓存重新解析一次再试，
    // 避免“一个人遇到过期的地址，之后所有人都用不了”。
    if (resolvedVideo) {
      await forgetResolveVideoCache(movieForStream, env);
      triedSources.clear();
      // 这是“上一次拿到的直链已经失效/上游不回响应头”的补救机会：
      // 重新给一份换线预算，让重新解析出来的线路有机会真的连上。
      streamHeadersDeadline = Date.now() +
        positiveEnvMilliseconds(
          env,
          "STREAM_HEADERS_BUDGET_MS",
          STREAM_HEADERS_BUDGET_MS,
        );
      let retriedVideo = null;
      try {
        retriedVideo = await withTimeout(
          resolveVideoCached(movieForStream, env, fetchImpl, ctx),
          positiveEnvMilliseconds(
            env,
            "STREAM_RESOLVE_RETRY_BUDGET_MS",
            STREAM_RESOLVE_RETRY_BUDGET_MS,
          ),
        );
      } catch {
        retriedVideo = null;
      }
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
    path === "/Search/Hints" ||
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
    /^\/Users\/[^/]+\/(?:PlayedItems|UnplayedItems|PlayingItems|FavoriteItems)(?:\/[^/]+(?:\/Delete)?)?$/i.test(path) ||
    /^\/Users\/[^/]+\/Resume(?:\/[^/]+)?$/i.test(path) ||
    /^\/User(?:Played|Favorite)Items\/[^/]+$/i.test(path) ||
    path.toLowerCase().startsWith("/items/") ||
    path.toLowerCase().startsWith("/videos/") ||
    isLocalMediaPath(path)
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
    isLocalMediaPath(path)
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
  if (/^\/(?:Sessions\/Playing(?:\/Progress|\/Stopped)?|Items\/[^/]+\/UserData|Items\/[^/]+\/HideFromResume|Users\/[^/]+\/(?:PlayedItems|UnplayedItems|PlayingItems|FavoriteItems)\/[^/]+(?:\/Delete)?)$/i.test(path)) {
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
  "hidefromresume",
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
  if (action === "playeditems" && method === "DELETE") {
    // “标记未播放 / 删除观看记录”也必须走墓碑，否则客户端刷新后迟到的
    // 进度上报会立刻把记录重新创建出来。
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
  if (action === "userdata" && (method === "POST" || method === "PUT")) {
    // 部分客户端不用 DELETE，而是向 UserData 回写 PlaybackPositionTicks=0
    // 来清掉续播；这也必须立墓碑，否则紧接着补发的旧进度会再次把它带回列表。
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

function batchDeleteItemIds(url) {
  const ids = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (!/^(?:ids|itemids|itemid)$/i.test(key)) {
      continue;
    }
    const decoded = safeDecodeComponent(value);
    for (const part of decoded.split(/[,\s]+/)) {
      const itemId = part.trim();
      if (itemId) {
        ids.push(itemId);
      }
    }
  }
  return [...new Set(ids)];
}

// Emby 部分客户端不是按单条路径删除，而是批量请求：
// DELETE /Users/{uid}/Items/Resume?Ids=xxx 或 DELETE /Items?Ids=xxx。
// 这些路径平时会被列表读取分支接住，所以必须在读取前处理。
async function handleBatchPlaybackDelete(path, request, env, url) {
  const method = request.method;
  const isBatchPath = /^\/Items(?:\/(?:Resume|Delete|Remove))?$/i.test(path);
  const canDelete = method === "DELETE" || method === "POST" || method === "PUT";
  if (!isBatchPath || !canDelete) {
    return null;
  }
  const itemIds = batchDeleteItemIds(url);
  if (!itemIds.length) {
    return null;
  }

  const token = getToken(request, url);
  const state = await readPlaybackState(env, token);
  for (const itemId of itemIds.slice(0, 200)) {
    await removePlaybackRecord(env, token, state, itemId);
  }
  await writePlaybackState(env, state, token);
  return noContentResponse();
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

async function handleEmbyInternal(request, env = {}, fetchImpl = fetch, ctx = null) {
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
    return jsonResponse(systemInfo(request.url, env), 200, {
      "x-emby-build": SERVER_BUILD_ID,
    });
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
    // 访客模式默认开启时返回这个无密码账号，客户端可自动登录；
    // 显式关闭访客模式时不泄露任何用户，必须手动输入账号密码。
    return jsonResponse(guestAccessEnabled(env) ? [virtualUser(env)] : []);
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
      return errorResponse(
        503,
        "Playback state is temporarily unavailable; retry the request",
      );
    }
    return noContentResponse();
  }

  const token = getToken(request, url);
  const batchPlaybackDelete = await handleBatchPlaybackDelete(path, request, env, url);
  if (batchPlaybackDelete) {
    return batchPlaybackDelete;
  }
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
        prewarmSearchResults(personResult, env, fetchImpl, ctx);
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
          prewarmSearchResults(collectionResult, env, fetchImpl, ctx);
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
      if (query.get("SearchTerm") || query.get("searchTerm")) {
        prewarmSearchResults(result, env, fetchImpl, ctx);
      }
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
  const hideFromResumeMatch = path.match(/^\/Items\/([^/]+)\/HideFromResume$/i);
  if (hideFromResumeMatch) {
    const hideItemId = decodeURIComponent(hideFromResumeMatch[1]);
    const hide = isTruthyUserDataFlag(
      pickUserDataValue({}, url.searchParams, ["Hide", "hide"]),
    );
    const hiddenState = await readPlaybackState(env, token);
    if (hide) {
      await removePlaybackRecord(env, token, hiddenState, hideItemId);
      await writePlaybackState(env, hiddenState, token);
    } else {
      await clearPlaybackTombstone(
        env,
        await playbackStateKey(env, token),
        hideItemId,
      );
    }
    return jsonResponse(userDataForRecord(hiddenState[hideItemId]));
  }
  const userDataMatch = path.match(/^\/Items\/([^/]+)\/UserData$/i);
  if (userDataMatch) {
    const userDataItemId = decodeURIComponent(userDataMatch[1]);
    const userDataState = await readPlaybackState(env, token);
    if (request.method === "DELETE") {
      await removePlaybackRecord(env, token, userDataState, userDataItemId);
      await writePlaybackState(env, userDataState, token);
      return jsonResponse(userDataForRecord(userDataState[userDataItemId]));
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
      const favoriteOnly = favoriteParam !== undefined &&
        playedParam === undefined &&
        positionParam === undefined &&
        playCountParam === undefined;
      const explicitProgressClear =
        !favoriteOnly &&
        ((positionParam !== undefined && incomingPosition === 0) ||
          (playedParam !== undefined && incomingPlayed === false));
      if (explicitProgressClear) {
        // UserData 回写 0 进度（或未播状态）也是客户端的“移除续播”操作，
        // 按删除处理并立墓碑；收藏字段若同请求带回，仍按原值保留。
        await removePlaybackRecord(env, token, userDataState, userDataItemId);
        if (favoriteParam !== undefined) {
          const favoriteRecord = userDataState[userDataItemId] || {
            itemId: userDataItemId,
            positionTicks: 0,
            played: false,
            playCount: 0,
            lastPlayedDate: "",
          };
          favoriteRecord.itemId = userDataItemId;
          favoriteRecord.favorite = isTruthyUserDataFlag(favoriteParam);
          userDataState[userDataItemId] = favoriteRecord;
        }
        await writePlaybackState(env, userDataState, token);
        return noContentResponse();
      }
      if (incomingPosition > 0 || incomingPlayed === true) {
        // 客户端退出后常会补发一次“最后的进度”，刚移除过的条目不能被它复活
        if (await playbackWriteSuppressed(env, token, userDataItemId, {
          positionTicks: incomingPosition,
          playedToCompletion: incomingPlayed === true,
          playSessionId: pickPlaySessionId(body, url.searchParams),
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
  const playbackItemDeleteMatch = path.match(
    /^\/Users\/[^/]+\/(PlayedItems|FavoriteItems)\/([^/]+)\/Delete$/i,
  );
  if (playbackItemDeleteMatch && request.method === "POST") {
    const deleteAction = playbackItemDeleteMatch[1].toLowerCase();
    const deleteItemId = decodeURIComponent(playbackItemDeleteMatch[2]);
    const deleteState = await readPlaybackState(env, token);
    if (deleteAction === "playeditems") {
      await removePlaybackRecord(env, token, deleteState, deleteItemId);
      await writePlaybackState(env, deleteState, token);
      return jsonResponse(userDataForRecord(deleteState[deleteItemId]));
    }
    const favoriteRecord = deleteState[deleteItemId] || {
      itemId: deleteItemId,
      positionTicks: 0,
      played: false,
      playCount: 0,
      lastPlayedDate: "",
    };
    favoriteRecord.itemId = deleteItemId;
    favoriteRecord.favorite = false;
    deleteState[deleteItemId] = favoriteRecord;
    await writePlaybackState(env, deleteState, token);
    return jsonResponse(userDataForRecord(favoriteRecord));
  }
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
        playSessionId: pickPlaySessionId(playingBody, url.searchParams),
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
  if (path === "/SearchHints" || path === "/Search/Hints") {
    try {
      const hintQuery = new URLSearchParams();
      hintQuery.set("SearchTerm", url.searchParams.get("SearchTerm") || "");
      const hintStart = Number(url.searchParams.get("StartIndex") || 0);
      const hintLimit = Number(url.searchParams.get("Limit") || 100);
      if (Number.isFinite(hintStart) && hintStart > 0) hintQuery.set("StartIndex", String(hintStart));
      if (Number.isFinite(hintLimit) && hintLimit > 0) hintQuery.set("Limit", String(hintLimit));
      // 搜索联想是“边打字边发”的，保留快速分页；它不需要准确的 TotalRecordCount。
      const result = await getMoviePage(hintQuery, env, fetchImpl, token, { fastSearch: true });
      prewarmSearchResults(result, env, fetchImpl, ctx);
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

  // Emby 标准图片地址：/Items/{id}/Images/{ImageType}[/{index}]
  // 客户端详情页的“艺术图”就用 /Images/Backdrop/{index} 取图。
  const imageMatch = path.match(
    /^\/Items\/([^/]+)\/Images\/([A-Za-z]+)(?:\/(\d+))?$/i,
  );
  if (imageMatch) {
    try {
      return await imageResponse(
        decodeURIComponent(imageMatch[1]),
        request,
        env,
        fetchImpl,
        token,
        {
          imageType: imageMatch[2],
          imageIndex: imageMatch[3] ? Number(imageMatch[3]) : 0,
        },
      );
    } catch (error) {
      return errorResponse(502, error instanceof Error ? error.message : "Movie image unavailable");
    }
  }

  const playbackMatch = path.match(/^\/Items\/([^/]+)\/PlaybackInfo$/i);
  if (playbackMatch) {
    try {
      const requestDeadline = Date.now() + PLAYBACK_INFO_REQUEST_DEADLINE_MS;
      const metadataBudgetMs = remainingRequestMs(
        requestDeadline,
        ITEM_METADATA_BUDGET_MS,
      );
      const movie = await withTimeout(
        getMovieCached(
          decodeURIComponent(playbackMatch[1]),
          env,
          fetchImpl,
          token,
          { deadline: Date.now() + metadataBudgetMs },
        ),
        metadataBudgetMs,
      );
      const item = mapMovie(movie, request.url, env);
      const playbackToken = token || (guestAccessEnabled(env) ? guestToken(env) : "");
      const subtitleResolution = trackResolution(
        resolveSubtitlesCached(movie, env, fetchImpl).catch(() => []),
      );
      // 与详情页一致：给真实解析留出足够预算，超时则返回空列表并继续后台解析，
      // 不再返回无地址的假线路。
      // 命中旧成功源时立即返回，同时后台继续刷新；上游解析账号临时停用时
      // 仍能保留多线路，不会把客户端变成“没有播放按钮”。
      const videoResolution = await resolveVideoForResponse(
        movie,
        env,
        fetchImpl,
        ctx,
        remainingRequestMs(
          requestDeadline,
          positiveEnvMilliseconds(
            env,
            "PLAYBACK_INFO_RESOLVE_BUDGET_MS",
            PLAYBACK_INFO_RESOLVE_BUDGET_MS,
          ),
        ),
      );
      const video = videoResolution.video;
      const subtitleWaitMs = Math.min(
        PLAYBACK_INFO_SUBTITLE_WAIT_MS,
        remainingRequestMs(requestDeadline, PLAYBACK_INFO_SUBTITLE_WAIT_MS),
      );
      let subtitles = subtitleResolution.record.done
        ? subtitleResolution.record.value || []
        : await settledWithin(
          subtitleResolution.tracked,
          subtitleWaitMs,
        );
      if (!Array.isArray(subtitles)) {
        subtitles = await peekCachedSubtitles(movie, env);
      }
      if (!subtitleResolution.record.done) {
        // 播放源已经拿到:让字幕在后台继续解析完并写进缓存。
        keepAlive(subtitleResolution.tracked, ctx);
      }

      if (!video) {
        // 与详情页保持一致：无论是「还在后台解析」「刚才是超时/上游失败」还是
        // 「解析已经跑完但这一轮没有可用线路」，都返回同一条按需占位线路 +
        // 播放会话。绝不能回空 MediaSources：Emby 客户端会把它判为播放失败，
        // 弹 “Connection timeout, try again later”，并把本地播放记录/进度条
        // 一起清掉。占位线路的 Path 不带 source 参数，播放时由 /Videos/{id}/stream
        // 现场解析真实地址并转发，所以生成播放会话是安全的。
        const sources = pendingMediaSources(item, request.url, playbackToken, subtitles);
        const playSessionId = crypto.randomUUID();
        rememberPlaySession(
          await playbackStateKey(env, playbackToken),
          item.Id,
          playSessionId,
        );
        return jsonResponse({
          PlaySessionId: playSessionId,
          ItemId: item.Id,
          MediaSources: sources,
          MediaSourceCount: sources.length,
        });
      }
      const mediaSources = mediaSourcesForVideo(
        item,
        request.url,
        playbackToken,
        video,
        subtitles,
      );
      if (!mediaSources.length) {
        return temporaryPlaybackResponse(
          "Playback sources are not ready; retry the request",
        );
      }
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
      ctx,
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
    // 有些客户端（ExoPlayer / 部分 Android TV 外壳）拿到 HLS 媒体源后不请求
    // stream.m3u8，而是按 Emby 原生习惯先请求 master.m3u8 / main.m3u8。
    // 旧代码只认 stream/original/download/playback，这两个路径直接 404，
    // 客户端表现为 “Playback failed: Could not fetch …”。这里把它们并入
    // 同一条取流分支：单条媒体源直接回放，重写后的清单里已经是可直接播放的
    // 分片地址，不需要再生成多码率 master。
    /^\/Videos\/([^/]+)(?:\/[^/]+)?\/(?:stream(?:ing)?|original|download|playback|master|main)(?:[._-][^/]*)?$/i,
  );
  if (streamMatch) {
    return streamResponse(
      decodeURIComponent(streamMatch[1]),
      request,
      env,
      fetchImpl,
      token,
      ctx,
    );
  }

  if (isLocalMediaPath(path)) {
    const mediaUrl = safeMediaUrl(url.searchParams.get("url"), env);
    if (!mediaUrl) {
      return errorResponse(403, "Media URL is not allowed");
    }
    const hlsManifest = requestTargetsHlsManifest(request, mediaUrl.toString());
    const upstream = await fetchMediaUpstreamResponse(
      request,
      mediaUrl.toString(),
      env,
      fetchImpl,
      { hlsManifest, ctx },
    );
    return proxyMediaResponse(
      upstream,
      mediaUrl.toString(),
      request,
      env,
      hlsRewriteDepth(url.searchParams.get("depth")),
    );
  }

  const lateFallbackDelete = await handleFallbackDelete(path, request, env, url);
  if (lateFallbackDelete) {
    return lateFallbackDelete;
  }

  return errorResponse(404, `Emby endpoint not found: ${request.method} ${path}`);
}

export async function handleEmby(request, env = {}, fetchImpl = fetch, ctx = null) {
  try {
    return await handleEmbyInternal(request, env, fetchImpl, ctx);
  } catch (error) {
    console.error(JSON.stringify({
      message: "Emby request failed",
      method: request.method,
      path: new URL(request.url).pathname,
      error: error instanceof Error ? error.message : String(error),
    }));
    return errorResponse(
      503,
      "Emby state service is temporarily unavailable; retry the request",
    );
  }
}

// 集成测试会复用同一个模块实例；清空所有进程内状态，避免不同上游响应
// 被前一个用例的影片、播放源或播放记录缓存串用。
export function resetEmbyCachesForTests() {
  MOVIE_CACHE.clear();
  RESOLVE_VIDEO_CACHE.clear();
  PARTIAL_RESOLVE_CACHE.clear();
  RESOLVE_SUBTITLE_CACHE.clear();
  LIST_CACHE.clear();
  LIST_WINDOW_CACHE.clear();
  API_TOKEN_CACHE.clear();
  MEDIA_SEGMENT_BODY_CACHE.clear();
  MEDIA_SEGMENT_PREFIX_CACHE.clear();
  SUBTITLE_STREAM_TOKENS.clear();
  SUBTITLE_BODY_CACHE.clear();
  MEMORY_PLAYBACK_STATES.clear();
  MEMORY_PLAYBACK_STATE_WRITES.clear();
  MEMORY_LOGIN_PASSWORDS.clear();
  MEMORY_PLAYBACK_KEYS.clear();
  MEMORY_PLAYBACK_TOMBSTONES.clear();
  MEMORY_PLAY_SESSIONS.clear();
  MEMORY_LEGACY_ADOPT_GUARDS.clear();
}
