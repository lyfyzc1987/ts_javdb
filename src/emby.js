// ============================================================
// bb_javdb - Cloudflare Worker for Emby/JavDB bridge
// ============================================================

const USER_ID = "bbjavdb-user";
const ROOT_ID = "bbjavdb-root";
const CHINESE_PLAYABLE_LIBRARY_ID = "javdb-chinese";
const JAVDB_LIBRARY_ID = "javdb-all";
const DEFAULT_GUEST_TOKEN = "bbjavdb-guest";
const HOME_SOURCE_PAGE_SIZE = 40;
const HOME_MAX_SOURCE_PAGES = 8;
const PLAYBACK_MAX_RESUME_ITEMS = 12;
const PLAYBACK_STATE_KEY = "playback-state-v1";
const SESSION_USER_KEY_PREFIX = "session-user:v1:";

// 库定义（客户端侧边栏显示的媒体库）
const LIBRARIES = [
  {
    id: CHINESE_PLAYABLE_LIBRARY_ID,
    name: "中文番号",
    sourceFilter: "chinese",
    matches: (movie) => {
      // 有中文字幕或中文标题
      return !!(movie?.cn_title || movie?.has_chinese_subtitle);
    },
  },
  {
    id: JAVDB_LIBRARY_ID,
    name: "全部番号",
    sourceFilter: "",
    matches: () => true,
  },
];

// 允许的 Emby 路由前缀
const HANDLED_PATHS = [
  "/System",
  "/Branding",
  "/Startup",
  "/Users",
  "/UserViews",
  "/Library",
  "/Sessions",
  "/DisplayPreferences",
  "/Items",
  "/Shows",
  "/Genres",
  "/Studios",
  "/Persons",
  "/Videos",
];

// 简单的浏览器页面拦截（返回 404 给浏览器访问）
function browserPageBlocked(request) {
  const ua = request.headers.get("user-agent") || "";
  const accept = request.headers.get("accept") || "";
  // 如果 User-Agent 包含浏览器特征，且 Accept 包含 text/html，就认为是浏览器访问
  if (/Mozilla|Chrome|Safari|Firefox|Edge/i.test(ua) && /text\/html/.test(accept)) {
    const url = new URL(request.url);
    // 不拦截 /emby 根路径（Emby 客户端可能也用浏览器 UA）
    if (url.pathname === "/" || url.pathname === "/emby") return false;
    return true;
  }
  return false;
}

function notFoundPage() {
  return new Response("Not Found", { status: 404 });
}

// 解析路由路径：/emby/xxx -> /xxx，兼容 /emby 前缀
function routePath(requestUrl) {
  const url = new URL(requestUrl);
  let path = url.pathname;
  if (path.startsWith("/emby")) {
    path = path.slice(5) || "/";
  }
  return path;
}

function normalizeClientPath(path) {
  // 移除末尾的 / 除非是根
  if (path !== "/" && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path;
}

function isHandledPath(path) {
  return HANDLED_PATHS.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
}

function isEmbyClientRequest(request) {
  const ua = request.headers.get("user-agent") || "";
  return /Emby|Jellyfin|MediaBrowser/i.test(ua);
}

// 从请求中提取 token（Authorization 头或 URL 参数）
function getToken(request, url) {
  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/MediaBrowser\s+Token=([^,\s]+)/i);
  if (match) return match[1];
  const tokenParam = url?.searchParams?.get("api_key") || "";
  if (tokenParam) return tokenParam;
  // 也支持 X-Emby-Token
  const xToken = request.headers.get("x-emby-token") || "";
  if (xToken) return xToken;
  return "";
}

function guestToken(env) {
  return String(env.EMBY_GUEST_TOKEN || DEFAULT_GUEST_TOKEN);
}

// 默认“本地信任登录”：不要求真实 JavDB 账号，任意用户名都能登录成功。
// 只有显式设置 EMBY_REAL_JAVDB_LOGIN=true 时，才回到“必须真实 JavDB 账号验证”。
function realJavdbLoginEnabled(env) {
  const value = String(env.EMBY_REAL_JAVDB_LOGIN ?? "false").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function guestAccessEnabled(env) {
  const value = String(env.EMBY_GUEST_ACCESS ?? "true").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

// 用户信息结构（供 Emby 客户端展示）
function virtualUser(env, username = "JAVDB Guest") {
  return {
    Name: username,
    Id: USER_ID,
    ServerId: serverId(env),
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    LastLoginDate: new Date().toISOString(),
    DateCreated: new Date().toISOString(),
    ConnectLinkType: "None",
    Policy: {
      IsAdministrator: false,
      IsHidden: true,
      IsDisabled: false,
      EnableAllDevices: true,
      EnableAllChannels: true,
      EnableAllFolders: true,
      EnableRemoteAccess: true,
      EnableSyncTranscoding: false,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: false,
      EnableContentDownloading: false,
      EnableContentUploading: false,
      EnableSubtitleDownloading: true,
      EnableSubtitleManagement: false,
      EnableLiveTvManagement: false,
      EnableLiveTvAccess: false,
      EnableCollectionManagement: false,
      EnableSharedDeviceControl: false,
      EnablePublicSharing: false,
      EnableRemoteControlOfOtherUsers: false,
      BlockedChannels: [],
      BlockedMediaFolders: [],
      BlockedTags: [],
      MaxParentalRating: 0,
      MaxActiveSessions: 0,
      InvalidLoginAttemptCount: 0,
      LoginAttemptsBeforeLockout: -1,
      EnableUserPreferenceAccess: true,
    },
  };
}

function serverId(env) {
  return env.EMBY_SERVER_ID || "bbjavdb-server";
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

function noContentResponse() {
  return new Response(null, { status: 204 });
}

function emptyItemQuery() {
  return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
}

function itemQuery(items, startIndex = 0) {
  return {
    Items: items,
    TotalRecordCount: items.length,
    StartIndex: startIndex,
  };
}

function libraryView(library, env) {
  return {
    Name: library.name,
    Id: library.id,
    CollectionType: "movies",
    ServerId: serverId(env),
    Path: library.id,
    Locations: [],
    PrimaryImageAspectRatio: 2 / 3,
  };
}

function virtualFolder(library) {
  return {
    Name: library.name,
    Id: library.id,
    CollectionType: "movies",
    PrimaryImageAspectRatio: 2 / 3,
    Locations: [],
    RefreshStatus: "Idle",
  };
}

function displayPreferences(url) {
  return {
    Id: "usersettings",
    ViewType: "Poster",
    SortBy: "SortName",
    SortOrder: "Ascending",
    GroupItemsIntoCollections: false,
    ShowBackdrop: true,
    ShowSidebar: true,
    ShowPlayedIndicator: true,
    ShowUnplayedIndicator: true,
    ShowProgressBar: true,
    ShowStatusIndicator: true,
  };
}

function rootItem(env) {
  return {
    Name: "Media Library",
    Id: ROOT_ID,
    ServerId: serverId(env),
    IsFolder: true,
    Type: "CollectionFolder",
    CollectionType: "movies",
    Path: ROOT_ID,
    Locations: [],
    ChildCount: LIBRARIES.length,
  };
}

// ---------- 播放状态（KV 存储） ----------
function playbackKv(env) {
  return env.PLAYBACK_KV || null;
}

// 获取 token 对应的存储键
function playbackStateKey(token) {
  // 如果 token 为空或是 guest token，用全局键
  if (!token || token === DEFAULT_GUEST_TOKEN || token === "bbjavdb-guest") {
    return PLAYBACK_STATE_KEY;
  }
  // 用 md5 对 token 做哈希，避免特殊字符
  return PLAYBACK_STATE_KEY + ":" + md5hex(token);
}

// 获取用户名对应的存储键（用于按用户名分桶）
function userPlaybackStateKey(username) {
  if (!username || username === "JAVDB Guest") {
    return PLAYBACK_STATE_KEY;
  }
  return PLAYBACK_STATE_KEY + ":u:" + md5hex(username);
}

// 获取 token -> 用户名 映射键
function sessionUserKey(token) {
  return SESSION_USER_KEY_PREFIX + md5hex(token);
}

// MD5 简单实现（用于键名哈希）
function md5hex(str) {
  // 使用 Crypto API（Worker 环境）
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hash = crypto.subtle.digestSync("MD5", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 从 KV 读取播放状态（优先按用户名分桶，其次按 token 回退）
async function readPlaybackState(env, token) {
  const kv = playbackKv(env);
  if (!kv) return {};

  // 1. 尝试通过 token 查用户名
  const sessionKey = sessionUserKey(token);
  let username = null;
  try {
    const recordRaw = await kv.get(sessionKey, "json");
    if (recordRaw && recordRaw.username) {
      username = recordRaw.username;
    }
  } catch {
    // ignore
  }

  // 2. 如果有用户名，优先读用户名桶
  if (username) {
    const key = userPlaybackStateKey(username);
    try {
      const data = await kv.get(key, "json");
      if (data && typeof data === "object") return data;
    } catch {
      // ignore
    }
  }

  // 3. 回退到 per-token 桶
  const fallbackKey = playbackStateKey(token);
  try {
    const data = await kv.get(fallbackKey, "json");
    if (data && typeof data === "object") return data;
  } catch {
    // ignore
  }

  return {};
}

// 写入播放状态（按用户名分桶，同时保留 per-token 兼容）
async function writePlaybackState(env, state, token) {
  const kv = playbackKv(env);
  if (!kv) return;

  // 1. 尝试通过 token 查用户名
  const sessionKey = sessionUserKey(token);
  let username = null;
  try {
    const recordRaw = await kv.get(sessionKey, "json");
    if (recordRaw && recordRaw.username) {
      username = recordRaw.username;
    }
  } catch {
    // ignore
  }

  // 2. 如果有用户名，写入用户名桶
  if (username) {
    const key = userPlaybackStateKey(username);
    await kv.put(key, JSON.stringify(state));
  }

  // 3. 同时写入 per-token 桶（兼容旧客户端）
  const tokenKey = playbackStateKey(token);
  await kv.put(tokenKey, JSON.stringify(state));
}

// 存储 token -> 用户名 映射
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
    // 静默失败，不影响主流程
  }
}

// 设备绑定检查（限制 token 跨设备使用）
async function deviceBindingFailure(request, url, env, path) {
  // 登录/切换账号的请求不应被旧 token 的设备绑定拦住
  if (path === "/Users/AuthenticateByName") {
    return null;
  }
  const token = getToken(request, url);
  if (!token || token === guestToken(env)) {
    return null;
  }
  const kv = playbackKv(env);
  if (!kv) return null;
  const sessionKey = sessionUserKey(token);
  let record = null;
  try {
    record = await kv.get(sessionKey, "json");
  } catch {
    return null;
  }
  if (!record || !record.deviceId) return null;
  // 从请求中提取 deviceId（Emby 客户端会传 DeviceId 头）
  const clientDeviceId = request.headers.get("x-emby-deviceid") || request.headers.get("device-id") || "";
  if (!clientDeviceId) return null;
  if (record.deviceId !== clientDeviceId) {
    // 设备不匹配，返回 401 并要求重新登录
    return errorResponse(401, "This token is bound to another device. Please re-login.");
  }
  return null;
}

// ---------- 用户信息获取（按 token 反查用户名） ----------
async function userForRequest(request, url, env) {
  const token = getToken(request, url);
  if (!token || token === guestToken(env)) {
    return virtualUser(env);
  }
  // 查映射表
  const kv = playbackKv(env);
  if (kv) {
    try {
      const record = await kv.get(sessionUserKey(token), "json");
      if (record && record.username) {
        return virtualUser(env, record.username);
      }
    } catch {
      // ignore
    }
  }
  // 没找到映射，返回 guest
  return virtualUser(env);
}

// ---------- JavDB API 调用 ----------
function apiOrigin(env) {
  return String(env.API_BASE || "https://api.javdb.com");
}

// JavDB 请求签名（MD5 时间戳）
function createJavdbSignature() {
  const ts = Math.floor(Date.now() / 1000);
  const key = "javdb_emby_bridge_secret"; // 固定密钥
  const raw = `${ts}.${key}`;
  const hash = md5hex(raw);
  return `${ts}.${hash}`;
}

async function javdbRequest(path, env, fetchImpl, options = {}) {
  const url = new URL(`${apiOrigin(env)}${path}`);
  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  headers.set("user-agent", "bb-javdb-emby-bridge/1.0");
  headers.set("jdsignature", createJavdbSignature());
  if (options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  const body = options.body || undefined;
  const res = await fetchImpl(url.toString(), {
    method: options.method || "GET",
    headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JavDB API error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data;
}

// 从 JavDB 返回体中提取影片列表
function moviesFromPayload(payload) {
  if (!payload) return [];
  const data = payload.data || payload;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.movies)) return data.movies;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

// 影片映射到 Emby 格式
function mapMovie(movie, baseUrl, env, parentId = CHINESE_PLAYABLE_LIBRARY_ID) {
  const id = String(movie.id || movie.number || "");
  const title = movie.full_title || movie.title || movie.number || id;
  const year = movie.year || "";
  const overview = movie.description || movie.overview || "";
  const cover = movie.cover || movie.poster || "";
  const number = movie.number || "";
  const date = movie.date || movie.release_date || "";
  const runtime = movie.runtime || 0;
  const genres = movie.genres || [];
  const actors = movie.actors || [];
  const hasChinese = !!movie.cn_title || !!movie.has_chinese_subtitle;

  const item = {
    Id: id,
    Name: title,
    OriginalTitle: movie.title || "",
    ServerId: serverId(env),
    Container: "strm",
    IsFolder: false,
    Type: "Movie",
    ProductionYear: year ? parseInt(year, 10) : 0,
    PremiereDate: date || null,
    Overview: overview,
    Genres: genres,
    Actors: actors.map((a) => ({
      Name: typeof a === "string" ? a : a.name || "",
      Id: "",
      Role: "",
    })),
    Studios: [],
    Tags: [],
    ParentId: parentId,
    Path: `${baseUrl}/emby/Videos/${encodeURIComponent(id)}/stream`,
    MediaSources: [],
    MediaStreams: [],
    MediaSourceCount: 0,
    HasSubtitles: false,
    PlayAccess: "Full",
    IndexNumber: null,
    SortName: title,
    PrimaryImageAspectRatio: 2 / 3,
    ImageTags: {
      Primary: cover ? `cover-${id}` : undefined,
    },
    BackdropImageTags: [],
    UserData: {
      PlaybackPositionTicks: 0,
      PlayCount: 0,
      IsFavorite: false,
      LastPlayedDate: null,
      Played: false,
    },
  };

  // 如果有封面 URL，存到 ExternalUrls 或 ImageTags
  if (cover) {
    item.ImageTags.Primary = `cover-${id}`;
  }

  // 额外字段（番号）
  if (number) {
    item.Number = number;
  }
  if (hasChinese) {
    item.HasChineseSubtitle = true;
  }

  return item;
}

// 生成 MediaSource
function mediaSource(item, baseUrl, token, video, subtitles = []) {
  const id = item.Id;
  const isHls = true; // 使用 HLS 流
  const container = isHls ? "strm" : "mp4";
  const path = `${baseUrl}/emby/Videos/${encodeURIComponent(id)}/stream?api_key=${token}`;

  const streams = [];
  // 视频流
  streams.push({
    Codec: "h264",
    CodecTag: "avc1",
    Language: "und",
    DisplayLanguage: "Unknown",
    DisplayTitle: "1080p",
    Index: 0,
    IsDefault: true,
    IsForced: false,
    IsExternal: false,
    Type: "Video",
    Width: 1920,
    Height: 1080,
    BitRate: 0,
    AverageBitRate: 0,
    IsInterlaced: false,
    IsAVC: true,
    IsAnamorphic: false,
    PixelFormat: "yuv420p",
    ReferenceFrames: 1,
    Profile: "High",
    Level: 4.0,
    IsTextSubtitleStream: false,
    SupportsExternalSubtitleStream: true,
    DeliveryUrl: path,
  });

  // 音频流
  streams.push({
    Type: "Audio",
    Codec: "aac",
    CodecTag: "mp4a",
    Language: "und",
    DisplayLanguage: "Undetermined",
    DisplayTitle: "AAC stereo",
    Index: 1,
    Channels: 2,
    ChannelLayout: "stereo",
    SampleRate: 48000,
    IsDefault: true,
    IsForced: false,
    IsExternal: false,
  });

  // 字幕流
  for (const sub of subtitles) {
    streams.push({
      Type: "Subtitle",
      Codec: "srt",
      Language: sub.language || "chi",
      DisplayLanguage: sub.displayLanguage || "Chinese",
      DisplayTitle: sub.displayTitle || "Chinese",
      Index: streams.length,
      IsDefault: false,
      IsForced: false,
      IsExternal: true,
      DeliveryUrl: sub.url || "",
    });
  }

  return {
    Id: `source-${id}`,
    Path: path,
    Protocol: "Http",
    Container: container,
    Size: 0,
    Name: "JavDB Stream",
    IsRemote: true,
    ETag: "",
    RunTimeTicks: 0,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    SupportsIsoImagePlayback: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    IsInfiniteStream: false,
    SupportsProbing: false,
    MediaStreams: streams,
    MediaAttachments: [],
    Formats: [],
    Bitrate: 0,
    RequiredHttpHeaders: {},
    DefaultAudioStreamIndex: 1,
  };
}

// ---------- 单部影片获取 ----------
async function getMovie(id, env, fetchImpl, token = "") {
  try {
    const payload = await javdbRequest(`/v4/movies/${id}`, env, fetchImpl, {
      token: await apiToken(token, env),
    });
    const data = payload?.data || payload;
    if (data && data.id) return data;
    return null;
  } catch {
    return null;
  }
}

// API Token 处理（真实 JavDB token 或空）
async function apiToken(token, env) {
  if (!token || token === guestToken(env) || token === DEFAULT_GUEST_TOKEN) {
    return "";
  }
  // 如果有真实 token，直接返回
  // 注意：这里不会自动生成，只有真实登录才会存
  const kv = playbackKv(env);
  if (!kv) return "";
  try {
    const record = await kv.get(sessionUserKey(token), "json");
    if (record && record.trusted && record.javdbToken) {
      return record.javdbToken;
    }
  } catch {
    // ignore
  }
  return "";
}

// ---------- Emby 响应组装 ----------
function attachPlaybackUserData(item, userDataState) {
  const id = item.Id || "";
  const record = userDataState[id] || {};
  item.UserData = {
    PlaybackPositionTicks: record.positionTicks || 0,
    PlayCount: record.playCount || 0,
    IsFavorite: record.isFavorite || false,
    LastPlayedDate: record.lastPlayedDate || null,
    Played: (record.positionTicks || 0) > 0,
  };
  return item;
}

function itemResponse(item, env, token, requestUrl, video, subtitles) {
  if (!video) {
    item.PlayAccess = "None";
    item.MediaSources = [];
    item.MediaStreams = [];
    item.MediaSourceCount = 0;
    item.HasSubtitles = false;
    return jsonResponse(item);
  }
  const source = mediaSource(
    item,
    requestUrl,
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

// ---------- 搜索/列表 ----------
async function getMoviePage(query, env, fetchImpl, token = "") {
  const startIndex = Math.max(0, Number(query.get("StartIndex") || 0));
  const limit = Math.min(100, Math.max(1, Number(query.get("Limit") || 32)));
  const page = Math.floor(startIndex / limit) + 1;
  const searchTerm = query.get("SearchTerm") || query.get("searchTerm") || "";
  const requestedParentId = query.get("ParentId") || CHINESE_PLAYABLE_LIBRARY_ID;
  const library = LIBRARIES.find((item) => item.id === requestedParentId) ||
    LIBRARIES.find((item) => item.id === CHINESE_PLAYABLE_LIBRARY_ID);
  const parentId = requestedParentId === ROOT_ID ? ROOT_ID : library.id;

  if (searchTerm) {
    // 搜索支持多页累积，解决搜索结果不全的问题
    let allMovies = [];
    let totalCount = 0;
    let currentPage = page;
    let hasMore = true;
    const maxPages = 12;

    while (allMovies.length < startIndex + limit && currentPage <= maxPages && hasMore) {
      const payload = await javdbRequest("/v2/search", env, fetchImpl, {
        query: {
          q: searchTerm,
          page: currentPage,
          type: "movie",
          movie_filter_by: "p",
          limit: limit,
        },
        token: await apiToken(token, env),
      });
      const movies = moviesFromPayload(payload).filter(library.matches);
      allMovies.push(...movies);
      totalCount = Number(payload?.total_count || payload?.total || allMovies.length);
      hasMore = movies.length >= limit;
      currentPage++;
    }

    const resultMovies = allMovies.slice(startIndex, startIndex + limit);
    return {
      Items: resultMovies.map((movie) => mapMovie(
        movie,
        query.requestUrl || "https://localhost/",
        env,
        parentId,
      )),
      TotalRecordCount: totalCount,
      StartIndex: startIndex,
    };
  }

  const requiredCount = startIndex + limit;
  const matchingMovies = [];
  let sourcePage = 1;
  let hasMoreSource = true;

  while (
    matchingMovies.length < requiredCount &&
    sourcePage <= HOME_MAX_SOURCE_PAGES &&
    hasMoreSource
  ) {
    const payload = await javdbRequest("/v1/movies/latest", env, fetchImpl, {
      query: {
        page: sourcePage,
        filter_by: library.sourceFilter,
        limit: HOME_SOURCE_PAGE_SIZE,
      },
      token: await apiToken(token, env),
    });
    const movies = moviesFromPayload(payload);
    matchingMovies.push(...movies.filter(library.matches));
    hasMoreSource = movies.length >= HOME_SOURCE_PAGE_SIZE;
    sourcePage += 1;
  }

  const movies = matchingMovies.slice(startIndex, requiredCount);
  const totalRecordCount = hasMoreSource
    ? startIndex + movies.length + 1
    : matchingMovies.length;
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

// ---------- 播放事件记录 ----------
async function recordPlaybackEvent(path, request, env) {
  const url = new URL(request.url);
  const token = getToken(request, url);
  let body = {};
  try {
    body = await request.clone().json();
  } catch {
    // ignore
  }

  const itemId = body.ItemId || url.searchParams.get("ItemId") || body.Id || "";
  if (!itemId) return;

  const state = await readPlaybackState(env, token);
  const record = state[itemId] || { itemId };
  const now = new Date().toISOString();

  if (path === "/Sessions/Playing/Progress") {
    record.positionTicks = Math.max(0, Number(body.PlaybackPositionTicks) || 0);
    record.lastPlayedDate = now;
  } else if (path === "/Sessions/Playing/Stopped") {
    record.positionTicks = Math.max(0, Number(body.PlaybackPositionTicks) || 0);
    record.playCount = (record.playCount || 0) + 1;
    record.lastPlayedDate = now;
  } else if (path === "/Sessions/Playing") {
    record.positionTicks = 0;
    record.playCount = (record.playCount || 0) + 1;
    record.lastPlayedDate = now;
  }

  state[itemId] = record;
  await writePlaybackState(env, state, token);
}

// ---------- 认证 ----------
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

  // 没填用户名：保留“访客/免登录”模式（如果启用）
  if (!username) {
    if (guestAccessEnabled(env)) {
      return authenticationResponse(
        request,
        env,
        virtualUser(env),
        guestToken(env),
      );
    }
    return errorResponse(401, "Username is required");
  }

  // 用户名存在但密码为空 -> 拒绝登录
  if (username && !password) {
    return errorResponse(401, "密码不能为空");
  }

  // 如果启用了真实 JavDB 验证，则走上游
  if (realJavdbLoginEnabled(env)) {
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
      const realUsername = String(data?.user?.username || data?.username || username);
      if (token) {
        // 存储真实 token 到映射表
        await storeSessionUser(env, token, realUsername, "", { trusted: true, javdbToken: token });
        // 生成 Emby 侧 token（用 username 哈希）
        const embyToken = "emby-" + md5hex(realUsername + Date.now());
        await storeSessionUser(env, embyToken, realUsername, "", { trusted: true });
        return authenticationResponse(request, env, virtualUser(env, realUsername), embyToken);
      }
      // 登录成功但没有 token（罕见），回退
      const fallbackToken = "emby-" + md5hex(username + Date.now());
      await storeSessionUser(env, fallbackToken, username);
      return authenticationResponse(request, env, virtualUser(env, username), fallbackToken);
    } catch (error) {
      return errorResponse(401, "JavDB 账号或密码错误");
    }
  }

  // 默认：本地信任登录（任何用户名+非空密码都通过）
  const embyToken = "session-" + username + "-" + Date.now();
  await storeSessionUser(env, embyToken, username);
  return authenticationResponse(request, env, virtualUser(env, username), embyToken);
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

// ---------- 系统信息 ----------
function systemInfo(requestUrl, env) {
  const url = new URL(requestUrl);
  const host = url.hostname;
  const port = url.port || "443";
  const scheme = url.protocol.slice(0, -1);
  const baseUrl = `${scheme}://${host}${port ? ":" + port : ""}`;
  return {
    Id: serverId(env),
    Name: "JavDB Emby Bridge",
    Version: "1.0.0",
    OperatingSystem: "Linux",
    OperatingSystemDisplayName: "Cloudflare Workers",
    HasPendingRestart: false,
    IsShuttingDown: false,
    SupportsImageExtras: false,
    SupportsCustomDeviceProfiles: false,
    SupportsCollectionManagement: false,
    SupportsContentUploading: false,
    SupportsMediaProbe: false,
    SupportsLibrarySubscriptions: false,
    SupportsMovieFileNaming: false,
    SupportsPeople: false,
    SupportsLibraryAccessControl: false,
    SupportsOriginalImageResizing: false,
    SupportsOfflineDownloads: false,
    SupportsOfflineSync: false,
    SupportsSync: false,
    SupportsPersistentIdentifier: false,
    SupportsRemoteControl: false,
    SupportsFileCreation: false,
    SupportsPathSubstitution: false,
    SupportsLibraryScanMonitoring: false,
    SupportsImageUpload: false,
    SupportsImageDownload: false,
    SupportsThumbnailGeneration: false,
    SupportsLiveTv: false,
    SupportsDeviceLoudness: false,
    SupportsDeviceInfo: false,
    SupportsFcmPushNotifications: false,
    ServerName: "JavDB",
    ExternalUrl: baseUrl,
    LocalAddress: baseUrl,
    RemoteAddress: baseUrl,
    WanAddress: baseUrl,
    MacAddress: "00:00:00:00:00:00",
  };
}

// ---------- 主请求入口 ----------
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
      const entries = Object.values(resumeState)
        .filter((record) => record && record.itemId && Number(record.positionTicks) > 0)
        .sort((a, b) => String(b.lastPlayedDate || "").localeCompare(String(a.lastPlayedDate || "")))
        .slice(0, resumeLimit);
      const resumeItems = [];
      for (const record of entries) {
        try {
          const movie = await getMovie(record.itemId, env, fetchImpl, token);
          if (!movie || (!movie.id && !movie.number)) continue;
          resumeItems.push(attachPlaybackUserData(mapMovie(movie, request.url, env), resumeState));
        } catch {
          // Item may no longer be resolvable upstream; skip silently.
        }
      }
      return jsonResponse(itemQuery(resumeItems));
    } catch (error) {
      console.error(JSON.stringify({
        message: "Resume list failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      return jsonResponse(emptyItemQuery());
    }
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
        body = JSON.parse(await request.clone().text());
      } catch {
        body = {};
      }
      const record = userDataState[userDataItemId] || {
        itemId: userDataItemId,
      };
      if (body.PlaybackPositionTicks !== undefined) {
        record.positionTicks = Math.max(0, Number(body.PlaybackPositionTicks) || 0);
      }
      if (body.IsFavorite !== undefined) {
        record.isFavorite = Boolean(body.IsFavorite);
      }
      if (body.Played !== undefined) {
        record.played = Boolean(body.Played);
      }
      if (body.PlayCount !== undefined) {
        record.playCount = Math.max(0, Number(body.PlayCount) || 0);
      }
      if (body.LastPlayedDate) {
        record.lastPlayedDate = body.LastPlayedDate;
      }
      userDataState[userDataItemId] = record;
      await writePlaybackState(env, userDataState, token);
      return jsonResponse(record);
    }
    return jsonResponse(userDataState[userDataItemId] || {});
  }

  // 视频播放请求
  const videoMatch = path.match(/^\/Videos\/([^/]+)\/stream$/i);
  if (videoMatch) {
    const id = decodeURIComponent(videoMatch[1]);
    try {
      const movie = await getMovie(id, env, fetchImpl, token);
      if (!movie) {
        return errorResponse(404, "Movie not found");
      }
      const item = mapMovie(movie, request.url, env);
      // 尝试获取字幕
      const subtitles = [];
      try {
        const subPayload = await javdbRequest(`/v4/movies/${id}/subtitles`, env, fetchImpl, {
          token: await apiToken(token, env),
        });
        const subs = subPayload?.data || subPayload || [];
        if (Array.isArray(subs)) {
          for (const sub of subs) {
            subtitles.push({
              url: sub.url || "",
              language: sub.language || "chi",
              displayLanguage: sub.displayLanguage || "Chinese",
              displayTitle: sub.displayTitle || "Chinese",
            });
          }
        }
      } catch {
        // 无字幕，忽略
      }
      return itemResponse(item, env, token, request.url, movie, subtitles);
    } catch (error) {
      return errorResponse(502, error instanceof Error ? error.message : "Failed to fetch video");
    }
  }

  // 未匹配的 Emby 请求
  return errorResponse(404, "Emby endpoint not found");
}

export default {
  async fetch(request, env, ctx) {
    const response = await handleEmby(request, env, fetch);
    if (response) return response;
    return new Response("Not Found", { status: 404 });
  },
};
