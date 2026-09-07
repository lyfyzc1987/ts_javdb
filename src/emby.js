// 完整 emby.js — 2026-09-07 修改版
// 登录强制密码 + M3U8→STRM + 标题完整 + 搜索多页 + 独立用户ID

const DEFAULT_API_ORIGIN = "https://catembylegacy.bbemby.com";
const DEFAULT_GUEST_TOKEN = "bbjavdb-guest";
const USER_ID = "bbjavdb-user";
const PLAYABLE_LIBRARY_ID = "bbjavdb-library";
const CHINESE_PLAYABLE_LIBRARY_ID = "bbjavdb-chinese";
const ROOT_ID = "bbjavdb-root";
const HOME_MAX_SOURCE_PAGES = 6;
const HOME_SOURCE_PAGE_SIZE = 32;
const PLAYBACK_MAX_RESUME_ITEMS = 30;

function md5(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return String(hash);
}

function md5hex(str) {
  return md5(str).toString(16).padStart(32, "0");
}

function serverId(env) {
  return env?.SERVER_ID || "bbjavdb-server";
}

function routePath(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\/emby/, "") || "/";
  } catch {
    return "/";
  }
}

function normalizeClientPath(path) {
  if (path === "/") return "/";
  return path.replace(/\/+$/, "") || "/";
}

function isHandledPath(path) {
  const handled = [
    "/System/Info/Public", "/System/Info", "/System/Endpoint",
    "/System/Configuration", "/Branding/Configuration",
    "/Startup/Configuration", "/Users/Public", "/Users",
    "/Users/AuthenticateByName", "/Users/Me",
    "/Users/GroupingOptions", "/Users/Views", "/UserViews",
    "/Library/MediaFolders", "/Library/VirtualFolders",
    "/Library/VirtualFolders/Query", "/Sessions",
    "/DisplayPreferences/usersettings", "/Sessions/Capabilities",
    "/Sessions/Capabilities/Full", "/Sessions/Viewing",
    "/Sessions/Playing", "/Sessions/Playing/Progress",
    "/Sessions/Playing/Stopped", "/Items/Root", "/Items",
    "/Items/Latest", "/Items/Resume", "/Shows/NextUp",
    "/Shows/Upcoming", "/Genres", "/Studios", "/Persons",
    "/Items/UserData",
  ];
  if (handled.some(h => path === h || path.startsWith(h + "/"))) return true;
  if (/^\/Videos\/[^/]+\/stream/i.test(path)) return true;
  if (/^\/Items\/[^/]+\/Images\/Primary/i.test(path)) return true;
  if (/^\/Items\/[^/]+\/PlaybackInfo/i.test(path)) return true;
  if (/^\/Items\/[^/]+\/Download/i.test(path)) return true;
  if (/^\/Items\/[^/]+$/i.test(path)) return true;
  if (/^\/Videos\/[^/]+\/[^/]+\/Subtitles\/\d+\/Stream\.[a-z0-9]+$/i.test(path)) return true;
  if (/^\/Videos\/[^/]+(?:\/[^/]+)?\/(?:stream(?:ing)?|original|download|playback)(?:[._-][^/]*)?$/i.test(path)) return true;
  if (path.startsWith("/emby-media/")) return true;
  return false;
}

function isEmbyClientRequest(request) {
  const ua = request.headers.get("user-agent") || "";
  return /emby|android|iphone|ipad|tvos|webos|firefox|chrome|safari/i.test(ua);
}

function browserPageBlocked(request) {
  const ua = request.headers.get("user-agent") || "";
  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/html") && !/emby|android|iphone|ipad|tvos|webos/i.test(ua)) {
    return true;
  }
  return false;
}

function notFoundPage() {
  return new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain" } });
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function noContentResponse() {
  return new Response(null, { status: 204 });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function itemQuery(items) {
  return {
    Items: items,
    TotalRecordCount: items.length,
    StartIndex: 0,
  };
}

function emptyItemQuery() {
  return { Items: [], TotalRecordCount: 0, StartIndex: 0 };
}

function parseJsonBodyText(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function safeMediaUrl(url, env) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const allowed = env?.ALLOWED_MEDIA_DOMAINS || ["fast-stream.jav.si", "jav.si", "catembylegacy.bbemby.com"];
    if (allowed.some(domain => u.hostname === domain || u.hostname.endsWith("." + domain))) {
      return u;
    }
    return null;
  } catch {
    return null;
  }
}

const LIBRARIES = [
  {
    id: PLAYABLE_LIBRARY_ID,
    name: "JAVDB 影片",
    sourceFilter: "all",
    matches: () => true,
  },
  {
    id: CHINESE_PLAYABLE_LIBRARY_ID,
    name: "中文 JAVDB",
    sourceFilter: "chinese",
    matches: (movie) => {
      const title = (movie.title || "").toLowerCase();
      const synopsis = (movie.synopsis || "").toLowerCase();
      return /[\u4e00-\u9fff]/.test(title) || /[\u4e00-\u9fff]/.test(synopsis);
    },
  },
];

function libraryView(library, env) {
  return {
    Name: library.name,
    Id: library.id,
    ServerId: serverId(env),
    Type: "CollectionFolder",
    CollectionType: "movies",
    IsFolder: true,
    ChildCount: 0,
    PrimaryImageTag: "",
  };
}

function virtualFolder(library) {
  return {
    Name: library.name,
    Id: library.id,
    CollectionType: "movies",
    IsVirtualFolder: true,
    PrimaryImageTag: "",
  };
}

function rootItem(env) {
  return {
    Name: "JAVDB",
    Id: ROOT_ID,
    ServerId: serverId(env),
    Type: "UserRootFolder",
    IsFolder: true,
    ChildCount: LIBRARIES.length,
    UserData: {
      Played: false,
      PlayCount: 0,
      IsFavorite: false,
    },
  };
}

function displayPreferences(url) {
  return {
    Id: "usersettings",
    ViewType: "Thumb",
    SortBy: "SortName",
    IndexBy: "None",
    RememberIndexing: false,
    PrimaryImageHeight: 250,
    PrimaryImageWidth: 180,
    CustomPrefs: {},
    ScrollDirection: "Horizontal",
    ShowBackdrop: true,
    RememberSorting: true,
    SortOrder: "Ascending",
    ShowSidebar: true,
    ShowTitle: true,
    ShowGenres: false,
  };
}

function getToken(request, url) {
  const queryToken = url.searchParams.get("api_key") ||
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

async function deviceIdForToken(env, token) {
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

function realJavdbLoginEnabled(env) {
  return env?.REAL_JAVDB_LOGIN === "true" || env?.REAL_JAVDB_LOGIN === true;
}

function generateUserId(username) {
  return "user-" + md5hex(username);
}

function virtualUser(env = {}, name = "JAVDB Guest", hasPassword = false) {
  const defaultName = guestAccessEnabled(env) ? "JAVDB Guest" : "JAVDB User";
  const displayName = name || defaultName;
  return {
    Name: displayName,
    Id: generateUserId(displayName),
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

async function storeSessionUser(env, token, username, deviceId = "") {
  if (!env?.PLAYBACK_KV) return;
  const key = `session-user:v1:${token}`;
  const value = { username, deviceId, updated: Date.now() };
  await env.PLAYBACK_KV.put(key, JSON.stringify(value));
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
  const username = await lookupSessionUsername(env, token);
  if (username) {
    stateKey = `playback-state-v1:u:${md5hex(username)}`;
  }
  const state = await env.PLAYBACK_KV.get(stateKey, "json");
  return state || {};
}

async function writePlaybackState(env, state, token) {
  if (!env?.PLAYBACK_KV) return;
  let stateKey = `playback-state-v1:${token}`;
  const username = await lookupSessionUsername(env, token);
  if (username) {
    stateKey = `playback-state-v1:u:${md5hex(username)}`;
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
  // 优先使用 full_title，避免标题被截断
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
    "/emby" + `/Videos/${encodeURIComponent(item.Id)}/stream.${container}`,
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

  // 用户名存在但密码为空 -> 拒绝登录（必须输入密码）
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
        await storeSessionUser(env, token, realUsername, "");
        const embyToken = "emby-" + md5hex(realUsername + Date.now());
        await storeSessionUser(env, embyToken, realUsername, "");
        return authenticationResponse(request, env, virtualUser(env, realUsername, true), embyToken);
      }
      const fallbackToken = "emby-" + md5hex(username + Date.now());
      await storeSessionUser(env, fallbackToken, username);
      return authenticationResponse(request, env, virtualUser(env, username, true), fallbackToken);
    } catch (error) {
      return errorResponse(401, "JavDB 账号或密码错误");
    }
  }

  // 默认：本地信任登录（任何用户名+非空密码都通过）
  const embyToken = "session-" + username + "-" + Date.now();
  await storeSessionUser(env, embyToken, username);
  return authenticationResponse(request, env, virtualUser(env, username, true), embyToken);
}

function authenticationResponse(request, env, user, token) {
  const sessionId = crypto.randomUUID();
  return jsonResponse({
    User: user,
    SessionInfo: {
      Id: sessionId,
      UserId: user.Id,
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
  const username = await lookupSessionUsername(env, token);
  if (username) return "";
  return token;
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

function moviesFromPayload(payload) {
  if (!payload) return [];
  if (payload.data?.movies) return payload.data.movies;
  if (payload.movies) return payload.movies;
  if (payload.data && Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
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
      const movie = await getMovie(decodeURIComponent(itemMatch[1]), env, fetchImpl, token);
      if (!movie) return errorResponse(404, "Movie not found");
      const item = mapMovie(movie, request.url, env);
      return jsonResponse(item);
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
