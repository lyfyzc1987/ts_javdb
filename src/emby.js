const DEFAULT_API_ORIGIN = "https://jdforrepam.com/api";
const DEFAULT_UPSTREAM_ORIGIN = "https://catembylegacy.fastcdn.dpdns.org";
const DEFAULT_RESOLVER_ORIGIN = "https://javstrm.emby-59f.workers.dev";
const SIGNATURE_KEY = "lpw6vgqzsp";
const SIGNATURE_SECRET =
  "71cf27bb3c0bcdf207b64abecddc970098c7421ee7203b9cdae54478478a199e7d5a6e1a57691123c1a931c057842fb73ba3b3c83bcd69c17ccf174081e3d8aa";
const ROOT_ID = "bbjavdb-root";
const PLAYABLE_LIBRARY_ID = "bbjavdb-playable";
const CHINESE_PLAYABLE_LIBRARY_ID = "bbjavdb-chinese-playable";
const USER_ID = "bbjavdb-user";
const PRODUCT_NAME = "月影emby";
const DEFAULT_GUEST_TOKEN = "bbjavdb-guest";
const LIBRARIES = [
  {
    id: PLAYABLE_LIBRARY_ID,
    name: "可播放",
    sourceFilter: "can_play",
    matches: (movie) => Boolean(movie?.can_play),
  },
  {
    id: CHINESE_PLAYABLE_LIBRARY_ID,
    name: "中文可播放",
    sourceFilter: "subtitle",
    matches: (movie) => isPlayableChinese(movie),
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
const HOME_SOURCE_PAGE_SIZE = 50;
const HOME_MAX_SOURCE_PAGES = 12;
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

      const shifted = (functionValue + a + constants[index] + words[offset + wordIndex]) | 0;
      const rotated = (rotateLeft(shifted, shifts[round][index % 4]) + b) | 0;
      a = d;
      d = c;
      c = b;
      b = rotated;
    }

    a = add32(originalA, a);
    b = add32(originalB, b);
    c = add32(originalC, c);
    d = add32(originalD, d);
  }

  return littleEndianHex(a) + littleEndianHex(b) + littleEndianHex(c) + littleEndianHex(d);
}

function serverId(env) {
  const id = env?.SERVER_ID || "bbjavdb";
  return id;
}

function isPlayableChinese(movie) {
  if (!movie) return false;
  const hasPlayable = Boolean(movie.can_play);
  const hasChineseSub = movie.subtitles?.some((sub) => sub.language === "chi" || sub.language === "zho");
  return hasPlayable && hasChineseSub;
}

function moviesFromPayload(payload) {
  const data = payload?.data || payload || {};
  const list = data.items || data.movies || data.results || [];
  if (!Array.isArray(list)) return [];
  return list;
}

function normalizeClientPath(path) {
  const normalized = path.replace(/^\/emby\//i, "/").replace(/^\/emby$/i, "/");
  return normalized;
}

function routePath(url) {
  const pathname = new URL(url).pathname;
  return normalizeClientPath(pathname);
}

function isHandledPath(path) {
  const handledPrefixes = [
    "/System/",
    "/Branding/",
    "/Startup/",
    "/Users/",
    "/UserViews",
    "/Library/",
    "/Sessions/",
    "/DisplayPreferences/",
    "/Items/",
    "/Shows/",
    "/Genres",
    "/Studios",
    "/Persons",
    "/SearchHints",
    "/Videos/",
    "/emby-media/",
    "/LiveTv/",
    "/Channels",
    "/Trailers",
    "/Artists/",
    "/Suggestions",
    "/PlaybackInfo",
    "/Download",
    "/Subtitles",
  ];
  const exactPaths = ["/"];
  if (exactPaths.includes(path)) return true;
  if (path === "/" || path === "/emby") return true;
  return handledPrefixes.some((prefix) => path.startsWith(prefix) || path === prefix);
}

function isEmbyClientRequest(request) {
  const accept = request.headers.get("accept") || "";
  const userAgent = request.headers.get("user-agent") || "";
  if (accept.includes("json") || accept.includes("emby")) return true;
  if (userAgent.includes("Emby") || userAgent.includes("JavDB")) return true;
  return false;
}

function browserPageBlocked(request) {
  const userAgent = request.headers.get("user-agent") || "";
  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/html") && !accept.includes("json") && !accept.includes("emby")) {
    if (userAgent.includes("Mozilla") || userAgent.includes("Chrome") || userAgent.includes("Safari")) {
      return true;
    }
  }
  return false;
}

function notFoundPage() {
  return new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain" } });
}

function jsonResponse(value, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json");
  headers.set("access-control-allow-origin", "*");
  return new Response(JSON.stringify(value), { status, headers });
}

function errorResponse(status, message) {
  return jsonResponse({ Error: message }, status);
}

function noContentResponse() {
  return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
}

function emptyItemQuery() {
  return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
}

function itemQuery(items) {
  return { Items: items, TotalRecordCount: items.length, StartIndex: 0 };
}

function publicRoutePath(requestUrl, relativePath) {
  const url = new URL(requestUrl);
  const base = url.origin;
  return new URL(relativePath, base).toString();
}

function libraryView(library, env) {
  return {
    Name: library.name,
    Id: library.id,
    ServerId: serverId(env),
    Type: "CollectionFolder",
    CollectionType: "movies",
    LocationType: "Virtual",
    ImageTags: {},
    PrimaryImageAspectRatio: 1.333,
    IsFolder: true,
    ChildCount: 0,
  };
}

function virtualFolder(library) {
  return {
    Name: library.name,
    Id: library.id,
    Type: "CollectionFolder",
    CollectionType: "movies",
    LocationType: "Virtual",
  };
}

function displayPreferences(url) {
  const theme = url.searchParams.get("theme") || "dark";
  return {
    Id: "usersettings",
    ViewType: "List",
    SortBy: "SortName",
    SortOrder: "Ascending",
    ShowBackdrop: true,
    SkipForwardLength: 30000,
    HomeSectionOrder: [],
    CustomPrefs: {
      dashboardtheme: theme,
      displaymissingepisodes: "false",
    },
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
    },
  };
}

function isMediaHost(host) {
  if (MEDIA_HOSTS.has(host)) return true;
  return MEDIA_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function safeMediaUrl(input, env) {
  if (!input) return null;
  try {
    const url = new URL(input);
    if (isMediaHost(url.hostname)) {
      return url;
    }
    if (env?.ALLOWED_MEDIA_HOSTS) {
      const allowed = new Set(env.ALLOWED_MEDIA_HOSTS.split(",").map((h) => h.trim()));
      if (allowed.has(url.hostname)) return url;
    }
    return null;
  } catch {
    return null;
  }
}

function isInlineHls(playlist) {
  if (!playlist) return false;
  return INLINE_HLS_CONTENT_TYPES.has(playlist.contentType) && playlist.length < MAX_INLINE_HLS_LENGTH;
}

function resolveInlineHls(source, requestUrl, env) {
  const commaIndex = source.indexOf(",");
  if (commaIndex === -1 || commaIndex + 1 >= source.length) {
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
    url.searchParams.get("AccessToken") ||
    url.searchParams.get("token");
  if (queryToken) return queryToken;

  const authHeader = request.headers.get("x-emby-token") || request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  if (authHeader) return authHeader;

  const cookie = request.headers.get("cookie") || "";
  const cookieMatch = cookie.match(/(?:^|;)\s*emby_token=([^;]+)/);
  if (cookieMatch) return cookieMatch[1];

  return "";
}

function requestDeviceId(request) {
  const fromHeader = request.headers.get("x-emby-device-id") || request.headers.get("x-device-id") || "";
  if (fromHeader) return fromHeader;
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;)\s*device_id=([^;]+)/);
  if (match) return match[1];
  return "";
}

function deviceIdForToken(env, token) {
  if (!token) return null;
  return env.PLAYBACK_KV?.get(`device:v1:${token}`, "json") ?? null;
}

async function storeDeviceId(env, token, deviceId) {
  if (!token || !deviceId) return;
  await env.PLAYBACK_KV?.put(`device:v1:${token}`, JSON.stringify({ deviceId }));
}

async function deviceBindingFailure(request, url, env, path) {
  if (!env?.PLAYBACK_KV) return null;
  const token = getToken(request, url);
  if (!token) return null;
  const deviceId = requestDeviceId(request);
  if (!deviceId) return null;
  const bound = await deviceIdForToken(env, token);
  if (!bound) {
    await storeDeviceId(env, token, deviceId);
    return null;
  }
  if (bound.deviceId === deviceId) return null;
  return errorResponse(401, "Device not authorized for this token");
}

function guestAccessEnabled(env) {
  return env?.GUEST_ACCESS !== "false" && env?.GUEST_ACCESS !== false;
}

function guestToken(env) {
  return env?.GUEST_TOKEN || DEFAULT_GUEST_TOKEN;
}

function virtualUser(env = {}, name = "JAVDB Guest", hasPassword = false) {
  const defaultName = guestAccessEnabled(env) ? "JAVDB Guest" : "JAVDB User";
  return {
    Name: name || defaultName,
    Id: USER_ID,
    ServerId: serverId(env),
    HasPassword: hasPassword,
    HasConfiguredPassword: hasPassword,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    LastLoginDate: new Date().toISOString(),
    LastActivityDate: new Date().toISOString(),
    PrimaryImageTag: "",
    Configuration: {
      AudioLanguagePreference: "zh",
      PlayDefaultAudioTrack: true,
      SubtitleLanguagePreference: "zh",
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      SubtitleMode: "Default",
    },
    Policy: {
      IsAdministrator: false,
      IsDisabled: false,
      EnableRemoteAccess: true,
      EnableLiveTvAccess: false,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: true,
      EnableVideoPlaybackTranscoding: true,
      EnableContentDownloading: true,
      EnableContentUploading: false,
      EnableAllDevices: true,
      EnableAllChannels: true,
      EnablePublicSharing: false,
    },
  };
}

function realJavdbLoginEnabled(env) {
  return env?.REAL_JAVDB_LOGIN === "true" || env?.REAL_JAVDB_LOGIN === true;
}

async function storeSessionUser(env, token, username, deviceId = "") {
  if (!env?.PLAYBACK_KV) return;
  const key = `session-user:v1:${token}`;
  const value = { username, deviceId, updated: Date.now() };
  await env.PLAYBACK_KV.put(key, JSON.stringify(value));
  // also store username index for lookup
  await env.PLAYBACK_KV.put(`session-username:v1:${username}`, JSON.stringify({ tokens: [token] }));
}

async function lookupSessionUsername(env, token) {
  if (!env?.PLAYBACK_KV || !token) return null;
  const key = `session-user:v1:${token}`;
  const record = await env.PLAYBACK_KV.get(key, "json");
  if (record && record.username) return record.username;
  return null;
}

async function readPlaybackState(env, token) {
  if (!env?.PLAYBACK_KV) return {};
  let stateKey = `playback-state-v1:${token}`;
  // if token is trusted, use username bucket
  const username = await lookupSessionUsername(env, token);
  if (username) {
    stateKey = `playback-state-v1:u:${md5(username)}`;
  }
  const state = await env.PLAYBACK_KV.get(stateKey, "json");
  return state || {};
}

async function writePlaybackState(env, state, token) {
  if (!env?.PLAYBACK_KV) return;
  let stateKey = `playback-state-v1:${token}`;
  const username = await lookupSessionUsername(env, token);
  if (username) {
    stateKey = `playback-state-v1:u:${md5(username)}`;
  }
  await env.PLAYBACK_KV.put(stateKey, JSON.stringify(state));
}

function attachPlaybackUserData(item, userDataState) {
  if (!userDataState) return item;
  const id = item.Id || item.id;
  if (!id) return item;
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

function mapMovie(movie, requestUrl, env, parentId = PLAYABLE_LIBRARY_ID) {
  const title = movie.full_title || movie.title || movie.name || movie.number || "未知影片";
  const id = movie.number || movie.id || "unknown";
  const year = movie.year || "";
  const image = movie.poster || movie.image || movie.cover || "";
  const images = movie.images || [];
  const poster = image || (images.length > 0 ? images[0] : "");
  const item = {
    Name: title,
    Id: id,
    ServerId: serverId(env),
    Guid: id,
    Type: "Movie",
    IsFolder: false,
    LocationType: "Virtual",
    MediaType: "Video",
    ParentId: parentId,
    ProductionYear: year ? Number(year) : null,
    PremiereDate: year ? `${year}-01-01` : null,
    Overview: movie.synopsis || movie.description || movie.plot || "",
    Genres: movie.genres || [],
    Tags: movie.tags || [],
    Studios: movie.studio ? [{ Name: movie.studio }] : [],
    People: [],
    ImageTags: {
      Primary: id,
    },
    BackdropImageTags: [],
    PrimaryImageAspectRatio: 1.333,
    UserData: {
      Played: false,
      PlayCount: 0,
      IsFavorite: false,
    },
    Path: poster ? `/emby-media/?url=${encodeURIComponent(poster)}` : "",
    // additional fields for playback
    can_play: movie.can_play || false,
    sourceUrl: movie.sourceUrl || "",
    sourceType: movie.sourceType || "",
  };
  return item;
}

function mediaSource(item, requestUrl, token, video, subtitles = []) {
  const isHls = /mpegurl|m3u8/i.test(video.sourceType || video.sourceUrl);
  // 修改：M3U8 改为 STRM
  const container = isHls ? "strm" : "mp4";
  const height = Number(video.quality || 0);
  const width = height > 0 ? Math.round((height * 16) / 9 / 2) * 2 : undefined;
  const streamUrl = new URL(
    publicRoutePath(
      requestUrl,
      `/Videos/${encodeURIComponent(item.Id)}/stream.${container}`,
    ),
    requestUrl,
  );
  streamUrl.searchParams.set("api_key", token);
  streamUrl.searchParams.set("static", "true");
  streamUrl.searchParams.set("mediaSourceId", item.Id);

  const mediaStreams = [
    {
      Codec: "h264",
      Type: "Video",
      Index: 0,
      IsDefault: true,
      IsForced: false,
      IsExternal: false,
      Width: width || 1280,
      Height: height || 720,
      BitRate: 4000000,
    },
  ];
  if (subtitles.length) {
    for (let i = 0; i < subtitles.length; i++) {
      const sub = subtitles[i];
      mediaStreams.push({
        Codec: "srt",
        Type: "Subtitle",
        Index: i + 1,
        IsDefault: false,
        IsForced: false,
        IsExternal: true,
        Language: sub.language || "chi",
        DisplayLanguage: sub.displayLanguage || "Chinese",
        DisplayTitle: sub.displayTitle || "Chinese",
        DeliveryUrl: sub.url || "",
      });
    }
  }

  return {
    Id: item.Id,
    Path: streamUrl.toString(),
    Protocol: "Http",
    Container: container,
    Size: 0,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    SupportsTranscoding: true,
    SupportsProbing: false,
    IsInfiniteStream: false,
    IsRemote: false,
    MediaStreams: mediaStreams,
    Bitrate: 4000000,
    VideoType: "VideoFile",
    DefaultAudioStreamIndex: 0,
    DefaultSubtitleStreamIndex: subtitles.length > 0 ? 1 : -1,
  };
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
        await storeSessionUser(env, token, realUsername, "", { trusted: true, javdbToken: token });
        const embyToken = "emby-" + md5hex(realUsername + Date.now());
        await storeSessionUser(env, embyToken, realUsername, "", { trusted: true });
        return authenticationResponse(request, env, virtualUser(env, realUsername), embyToken);
      }
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

async function userForRequest(request, url, env) {
  const token = getToken(request, url);
  const username = await lookupSessionUsername(env, token);
  if (username) {
    return virtualUser(env, username, true);
  }
  if (guestAccessEnabled(env)) {
    return virtualUser(env);
  }
  return virtualUser(env, "JAVDB User", false);
}

async function apiToken(token, env) {
  if (!token) return "";
  if (token === guestToken(env)) return "";
  // Check if token is a trusted session token
  const username = await lookupSessionUsername(env, token);
  if (username) return ""; // local token, not for upstream
  return token; // assume it's a real JavDB token
}

async function javdbRequest(path, env, fetchImpl, options = {}) {
  const base = env?.API_ORIGIN || DEFAULT_API_ORIGIN;
  const url = new URL(path, base);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = new Headers();
  if (options.token) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  if (options.method === "POST" && !(options.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }

  const fetchOptions = {
    method: options.method || "GET",
    headers,
    redirect: "follow",
  };
  if (options.body) {
    if (options.body instanceof FormData) {
      fetchOptions.body = options.body;
    } else {
      fetchOptions.body = JSON.stringify(options.body);
    }
  }

  const res = await fetchImpl(url.toString(), fetchOptions);
  if (!res.ok) {
    throw new Error(`JavDB API error: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { data: text };
  }
}

async function getMovie(id, env, fetchImpl, token = "") {
  const payload = await javdbRequest(`/v4/movies/${id}`, env, fetchImpl, {
    token: await apiToken(token, env),
  });
  const movie = payload?.data || payload;
  return movie;
}

async function resolveVideo(movie, env, fetchImpl) {
  if (!movie) return null;
  const sources = movie.sources || movie.videos || [];
  if (sources.length === 0) return null;
  const source = sources[0];
  if (typeof source === "string") {
    return { sourceUrl: source, sourceType: "m3u8" };
  }
  return { sourceUrl: source.url || source, sourceType: source.type || "m3u8" };
}

async function resolveSubtitles(movie, env, fetchImpl) {
  if (!movie) return [];
  const subs = movie.subtitles || [];
  return subs.map((sub) => ({
    url: sub.url || "",
    language: sub.language || "chi",
    displayLanguage: sub.displayLanguage || "Chinese",
    displayTitle: sub.displayTitle || "Chinese",
  }));
}

async function imageResponse(id, request, env, fetchImpl, token) {
  const movie = await getMovie(id, env, fetchImpl, token);
  if (!movie) return errorResponse(404, "Movie not found");
  const image = movie.poster || movie.image || movie.cover || "";
  if (!image) return errorResponse(404, "No image");
  const url = safeMediaUrl(image, env);
  if (!url) return errorResponse(403, "Invalid image URL");
  const upstream = await fetchImpl(url.toString(), { redirect: "follow" });
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("access-control-allow-origin", "*");
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function streamResponse(id, request, env, fetchImpl, token) {
  const movie = await getMovie(id, env, fetchImpl, token);
  if (!movie) return errorResponse(404, "Movie not found");
  const video = await resolveVideo(movie, env, fetchImpl);
  if (!video) return errorResponse(404, "No video source");
  const url = safeMediaUrl(video.sourceUrl, env);
  if (!url) return errorResponse(403, "Invalid video URL");
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  const upstream = await fetchImpl(url.toString(), {
    method: request.method,
    headers,
    redirect: "follow",
  });
  const responseHeaders = new Headers();
  for (const name of ["accept-ranges", "content-length", "content-range", "content-type"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("access-control-allow-origin", "*");
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

async function subtitleResponse(id, subIndex, request, env, fetchImpl, token) {
  const movie = await getMovie(id, env, fetchImpl, token);
  if (!movie) return errorResponse(404, "Movie not found");
  const subtitles = await resolveSubtitles(movie, env, fetchImpl);
  if (subIndex >= subtitles.length) return errorResponse(404, "Subtitle not found");
  const sub = subtitles[subIndex];
  const url = safeMediaUrl(sub.url, env);
  if (!url) return errorResponse(403, "Invalid subtitle URL");
  const upstream = await fetchImpl(url.toString(), { redirect: "follow" });
  const headers = new Headers();
  for (const name of ["content-type", "content-length"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("access-control-allow-origin", "*");
  return new Response(upstream.body, { status: upstream.status, headers });
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

  const videoMatch = path.match(/^\/Videos\/([^/]+)\/stream$/i);
  if (videoMatch) {
    const id = decodeURIComponent(videoMatch[1]);
    try {
      const movie = await getMovie(id, env, fetchImpl, token);
      if (!movie) {
        return errorResponse(404, "Movie not found");
      }
      const item = mapMovie(movie, request.url, env);
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

export default {
  async fetch(request, env, ctx) {
    const response = await handleEmby(request, env, fetch);
    if (response) return response;
    return new Response("Not Found", { status: 404 });
  },
};
