import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { beforeEach } from "node:test";

import {
  applyReplicaOverrides,
  handleProxy,
  isAllowedMediaHost,
  resolverPayloadHasUsableSource,
  resolveUpstreamTarget,
  rewriteText,
} from "../src/proxy.js";
import {
  createJavdbSignature,
  resetEmbyCachesForTests,
} from "../src/emby.js";

const UPSTREAM = "https://catembylegacy.fastcdn.dpdns.org";
const RESOLVER = "https://catembylegacy.fastcdn.dpdns.org";
const RESOLVER_REGRESSION_DELAY_MS = 1900;

test("recognizes upstream-relative resolver sources as usable", () => {
  const env = { UPSTREAM_ORIGIN: UPSTREAM };

  assert.equal(
    resolverPayloadHasUsableSource({
      variants: [{ variant: "original", sourceUrl: "/video/fresh.mp4" }],
    }, env),
    true,
  );
  assert.equal(
    resolverPayloadHasUsableSource({
      variants: [{ variant: "original", sourceUrl: `${UPSTREAM}/video/fresh.mp4` }],
    }, env),
    true,
  );
  assert.equal(
    resolverPayloadHasUsableSource({
      variants: [{
        variant: "pseudo",
        sourceUrl: "data:application/vnd.apple.mpegurl,%23EXTM3U",
      }],
    }, env),
    false,
  );
  assert.equal(
    resolverPayloadHasUsableSource({
      variants: [{
        variant: "untrusted",
        sourceUrl: "https://cdn-a.example/stream/index.m3u8",
      }],
    }, env),
    false,
  );
});

function delayedResolverResponse(delayMs = RESOLVER_REGRESSION_DELAY_MS) {
  const fakePlaylist = [
    "#EXTM3U",
    "#EXTINF:1,",
    "https://lh3.googleusercontent.com/not-a-video.jpg",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const fakeSource = `data:application/vnd.apple.mpegurl,${encodeURIComponent(fakePlaylist)}`;
  const earlyVariants = [
    { variant: "fcjav_original", sourceUrl: fakeSource, sourceType: "application/vnd.apple.mpegurl" },
    { variant: "fcjav_reducing_mosaic", sourceUrl: fakeSource, sourceType: "application/vnd.apple.mpegurl" },
    { variant: "javgg_original", sourceUrl: fakeSource, sourceType: "application/vnd.apple.mpegurl" },
    { variant: "javgg_reducing_mosaic", sourceUrl: fakeSource, sourceType: "application/vnd.apple.mpegurl" },
  ];
  const lateVariants = [
    {
      variant: "getav_raw_4k",
      sourceUrl: "https://fast-stream.jav.si/video/rctd-740-4k.mp4",
      sourceType: "video/mp4",
      quality: 2160,
    },
    {
      variant: "getav_raw_1080p",
      sourceUrl: "https://fast-stream.jav.si/video/rctd-740-1080p.mp4",
      sourceType: "video/mp4",
      quality: 1080,
    },
  ];
  const fragments = [
    `{"variants":[${earlyVariants.map(JSON.stringify).join(",")}`,
    `,${lateVariants.map(JSON.stringify).join(",")}]}`,
  ];
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      if (index >= fragments.length) {
        controller.close();
        return;
      }
      const fragment = fragments[index];
      index += 1;
      if (index > 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      controller.enqueue(encoder.encode(fragment));
    },
  }), {
    headers: { "content-type": "application/json" },
  });
}

async function encryptAes128Cbc(plaintext, keyBytes, iv) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-CBC" },
    false,
    ["encrypt"],
  );
  return new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-CBC", iv },
    key,
    plaintext,
  ));
}

beforeEach(() => {
  resetEmbyCachesForTests();
});

function embyJsonRequest(path, body, method = "POST") {
  const init = {
    method,
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`https://clone.example/emby${path}`, init);
}

function callLocalEmby(request, env = {}) {
  return handleProxy(request, env, {}, async () => {
    throw new Error("fetch must not be called");
  });
}

function createPlaybackD1(options = {}) {
  const rows = new Map();
  const failWrites = options.failWrites === true;
  const rowKey = (namespace, key) => `${namespace}\u0000${key}`;
  return {
    rows,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (!/SELECT value FROM playback_json/i.test(sql)) {
                throw new Error(`Unexpected D1 first() query: ${sql}`);
              }
              const value = rows.get(rowKey(values[0], values[1]));
              return value === undefined ? null : { value };
            },
            async all() {
              const simpleLike = /SELECT key FROM playback_json WHERE namespace = \? AND key LIKE \? LIMIT 2/i
                .test(sql);
              const fullLike = /SELECT key, value FROM playback_json WHERE namespace = \? AND key LIKE \? LIMIT \?/i
                .test(sql);
              if (!simpleLike && !fullLike) {
                throw new Error(`Unexpected D1 all() query: ${sql}`);
              }
              const likePattern = String(values[1] || "");
              const likeRegex = new RegExp(
                "^" + likePattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$",
              );
              const limit = fullLike ? Math.max(0, Number(values[2]) || 0) : 2;
              const results = [];
              for (const [id, value] of rows.entries()) {
                const separator = id.indexOf("\u0000");
                const namespace = id.slice(0, separator);
                const key = id.slice(separator + 1);
                if (namespace === values[0] && likeRegex.test(key)) {
                  results.push(fullLike ? { key, value } : { key });
                  if (results.length >= limit) break;
                }
              }
              return { results };
            },
            async run() {
              if (failWrites) {
                throw new Error("simulated D1 write failure");
              }
              if (/INSERT INTO playback_json/i.test(sql)) {
                rows.set(rowKey(values[0], values[1]), values[2]);
                return { success: true };
              }
              if (/DELETE FROM playback_json/i.test(sql)) {
                rows.delete(rowKey(values[0], values[1]));
                return { success: true };
              }
              throw new Error(`Unexpected D1 run() query: ${sql}`);
            },
          };
        },
      };
    },
  };
}

function createGatedMultiSourceResolve() {
  const mediaUrls = [2160, 1080, 720, 480].map((quality) =>
    `https://fast-stream.jav.si/rctd-740/gated-${quality}.mp4`
  );
  let releaseResolver;
  let markResolverStarted;
  const resolverGate = new Promise((resolve) => {
    releaseResolver = resolve;
  });
  const resolverStarted = new Promise((resolve) => {
    markResolverStarted = resolve;
  });
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/v4/movies/42")) {
      return new Response(
        JSON.stringify({
          success: 1,
          data: {
            movie: {
              id: 42,
              number: "RCTD-740",
              title: "RCTD-740 Gated result",
              can_play: true,
              has_cnsub: true,
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes(`${RESOLVER}/api/v/resolve?code=RCTD-740`)) {
      markResolverStarted();
      await resolverGate;
      return new Response(
        JSON.stringify({
          variants: mediaUrls.map((sourceUrl, index) => ({
            variant: `gated-${index + 1}`,
            label: `线路 ${index + 1}`,
            sourceUrl,
            sourceType: "video/mp4",
            quality: [2160, 1080, 720, 480][index],
          })),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (mediaUrls.includes(target)) {
      assert.equal(init.headers.get("range"), "bytes=0-511");
      return new Response(
        Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
        {
          status: 206,
          headers: {
            "content-range": "bytes 0-7/8",
            "content-type": "video/mp4",
          },
        },
      );
    }
    if (/\/api\/subtitle\?name=RCTD-740/.test(target)) {
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected gated request: ${target}`);
  };
  return {
    fetchImpl,
    mediaUrls,
    releaseResolver,
    resolverStarted,
  };
}

function expectedItemEtag(payload, options = {}) {
  const userData = payload?.UserData || {};
  const sources = Array.isArray(payload?.MediaSources)
    ? payload.MediaSources.map((source) => ({
      Id: source?.Id || "",
      MediaSourceId: source?.MediaSourceId || "",
      Name: source?.Name || "",
      Container: source?.Container || "",
      Type: source?.Type || "",
      RunTimeTicks: Number(source?.RunTimeTicks) || 0,
    }))
    : [];
  const stableDto = {
    version: "item-dto-v13",
    // 播放源仍在后台解析时，生产代码会把 20 秒时间桶拼进指纹，这里同步复现。
    ...(options.pendingSources === true
      ? { PendingSourcesBucket: Math.floor(Date.now() / (20 * 1000)) }
      : {}),
    Id: payload?.Id || "",
    Name: payload?.Name || "",
    OriginalTitle: payload?.OriginalTitle || "",
    Overview: payload?.Overview || "",
    PremiereDate: payload?.PremiereDate || "",
    ProductionYear: payload?.ProductionYear || 0,
    RunTimeTicks: Number(payload?.RunTimeTicks) || 0,
    Genres: payload?.Genres || [],
    Tags: payload?.Tags || [],
    People: payload?.People || [],
    Studios: payload?.Studios || [],
    ImageTags: payload?.ImageTags || {},
    BackdropImageTags: payload?.BackdropImageTags || [],
    MediaSourceCount: Number(payload?.MediaSourceCount) || sources.length,
    MediaSources: sources,
    Played: Boolean(userData.Played),
    PlayCount: Number(userData.PlayCount) || 0,
    IsFavorite: Boolean(userData.IsFavorite),
    PlaybackPositionTicks: Number(userData.PlaybackPositionTicks) || 0,
    PlayedPercentage: Number(userData.PlayedPercentage) || 0,
  };
  const digest = createHash("md5")
    .update(JSON.stringify(stableDto))
    .digest("hex");
  return `"${digest}"`;
}

test("maps application routes to the source site", () => {
  const target = resolveUpstreamTarget(
    "https://clone.example/movie/z4VJpy?page=2",
  );

  assert.equal(target.kind, "application");
  assert.equal(
    target.url.toString(),
    `${UPSTREAM}/movie/z4VJpy?page=2`,
  );
});

test("allows only known media hosts", () => {
  assert.equal(isAllowedMediaHost("jdforrepam.com"), true);
  assert.equal(isAllowedMediaHost("fast-stream.jav.si"), true);
  assert.equal(isAllowedMediaHost("h7.gzankun.com"), true);
  assert.equal(isAllowedMediaHost("s6pb.vendorconnection.shop"), true);
  assert.equal(isAllowedMediaHost("smhx.summitdigitalhub.space"), true);
  assert.equal(isAllowedMediaHost("evil.example"), false);

  const target = resolveUpstreamTarget(
    "https://clone.example/__media/h7.gzankun.com/video/seg.ts?sign=abc",
  );

  assert.equal(target.kind, "media");
  assert.equal(
    target.url.toString(),
    "https://h7.gzankun.com/video/seg.ts?sign=abc",
  );
});

test("keeps signed external URLs direct by default", () => {
  const source = [
    `${UPSTREAM}/assets/app.js`,
    "https://jdforrepam.com/api/v1/movies/latest",
    "https://tp.spfcas.com/covers/a.jpg",
    "https://h1.gzankun.com/video/seg.ts",
  ].join("\n");

  assert.equal(
    rewriteText(source, "https://clone.example", UPSTREAM),
    [
      "https://clone.example/assets/app.js",
      "https://jdforrepam.com/api/v1/movies/latest",
      "https://tp.spfcas.com/covers/a.jpg",
      "https://h1.gzankun.com/video/seg.ts",
    ].join("\n"),
  );
});

test("renames the visible site brand", () => {
  const source = 'children:"catemby\u9057\u4ea7"';
  const result = applyReplicaOverrides(source);

  assert.equal(result, 'children:"月影emby"');
  assert.doesNotMatch(result, /catemby/);
});

test("keeps five desktop columns and 32 movies per page", () => {
  const source = [
    "--container-7xl:80rem",
    "grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8",
    "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
    'pathname:"/v1/movies/latest",query:{page:t,filter_by:n}',
    "function bG(t,n=1,e=24,r=",
    "function CG(t,{filterByTags:n,page:e=1,limit:r=24,sortBy:",
    "movie_filter_by:r.movieFilterBy,movie_sort_by:r.sortBy,limit:r.limit",
    "const jx=24,pK=5",
  ].join("\n");

  const result = applyReplicaOverrides(source);

  assert.match(result, /--container-7xl:100rem/);
  assert.match(result, /grid-cols-2 sm:grid-cols-4\n/);
  assert.match(
    result,
    /grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5/,
  );
  assert.match(result, /filter_by:n,limit:32/);
  assert.match(result, /function bG\(t,n=1,e=32,r=/);
  assert.match(result, /limit:r=32,sortBy:/);
  assert.match(result, /limit:r\.limit\|\|32/);
  assert.match(result, /const jx=32,pK=5/);
  assert.doesNotMatch(result, /lg:grid-cols-8/);
  assert.doesNotMatch(result, /--container-7xl:80rem/);
});

test("adds copy controls beside mobile and desktop magnet links", () => {
  const source = [
    "function dY({magnet:t})",
    't.downloadUrl?f.jsx("a",{href:t.downloadUrl,target:"_blank",rel:"noreferrer",className:"text-sm font-medium text-primary hover:underline break-all",children:t.name}):f.jsx("span",{className:"text-sm font-medium break-all",children:t.name})',
    'f.jsx(ff,{className:"max-w-md truncate font-medium",children:e.downloadUrl?f.jsx("a",{href:e.downloadUrl,target:"_blank",rel:"noreferrer",className:"text-primary hover:underline",children:e.name}):e.name})',
  ].join("\n");

  const result = applyReplicaOverrides(source);

  assert.match(result, /magnet:\?xt=urn:btih:/);
  assert.match(result, /navigator\.clipboard/);
  assert.match(result, /"aria-label":"\u590d\u5236\u78c1\u529b\u94fe\u63a5"/);
  assert.match(result, /bbCopyButton\(t\.hash\)/);
  assert.match(result, /bbCopyButton\(e\.hash\)/);
  assert.doesNotMatch(result, /max-w-md truncate font-medium/);
});

test("can rewrite external media URLs when explicitly enabled", () => {
  const source = [
    "https://jdforrepam.com/api/v1/movies/latest",
    "https://tp.spfcas.com/covers/a.jpg",
    "https://h1.gzankun.com/video/seg.ts",
  ].join("\n");

  assert.equal(
    rewriteText(source, "https://clone.example", UPSTREAM, {
      PROXY_EXTERNAL_MEDIA: "true",
    }),
    [
      "https://clone.example/__media/jdforrepam.com/api/v1/movies/latest",
      "https://clone.example/__media/tp.spfcas.com/covers/a.jpg",
      "https://clone.example/__media/h1.gzankun.com/video/seg.ts",
    ].join("\n"),
  );
});

test("forwards Range requests and streams binary responses unchanged", async () => {
  const payload = new Uint8Array([0, 1, 2, 3]);
  let received;
  const response = await handleProxy(
    new Request("https://clone.example/preview.mp4?number=MBMA-279", {
      headers: { range: "bytes=0-3" },
    }),
    {},
    {},
    async (url, init) => {
      received = { url, init };
      return new Response(payload, {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-range": "bytes 0-3/4",
          "content-type": "video/mp4",
        },
      });
    },
  );

  assert.equal(received.url, `${UPSTREAM}/preview.mp4?number=MBMA-279`);
  assert.equal(received.init.headers.get("range"), "bytes=0-3");
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-3/4");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
});

test("rewrites text, redirects, and cookie domains", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/login", {
      headers: {
        origin: "https://clone.example",
        referer: "https://clone.example/login",
      },
    }),
    {},
    {},
    async (_url, init) => {
      assert.equal(init.headers.get("origin"), UPSTREAM);
      assert.equal(init.headers.get("referer"), `${UPSTREAM}/`);

      return new Response(`location = '${UPSTREAM}/account'`, {
        status: 302,
        headers: {
          "content-type": "text/html; charset=utf-8",
          location: `${UPSTREAM}/account`,
          "set-cookie":
            "session=abc; Domain=catembylegacy.fastcdn.dpdns.org; Path=/; Secure; HttpOnly",
        },
      });
    },
  );

  assert.equal(response.headers.get("location"), "https://clone.example/account");
  assert.equal(
    response.headers.get("set-cookie"),
    "session=abc; Path=/; Secure; HttpOnly",
  );
  assert.match(await response.text(), /https:\/\/clone\.example\/account/);
});

test("forwards login methods, headers, and request bodies", async () => {
  let forwarded;
  const response = await handleProxy(
    new Request("https://clone.example/api/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "device=web",
      },
      body: "username=test&password=secret",
    }),
    {},
    {},
    async (url, init) => {
      forwarded = {
        url,
        method: init.method,
        cookie: init.headers.get("cookie"),
        body: await new Response(init.body).text(),
      };
      return new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
      });
    },
  );

  assert.deepEqual(forwarded, {
    url: `${UPSTREAM}/api/login`,
    method: "POST",
    cookie: "device=web",
    body: "username=test&password=secret",
  });
  assert.deepEqual(await response.json(), { ok: true });
});

test("blocks arbitrary proxy targets", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/__media/127.0.0.1/admin"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );

  assert.equal(response.status, 403);
});

test("creates the same JavDB MD5 signature format as the web client", () => {
  assert.equal(
    createJavdbSignature(1700000000),
    "1700000000.lpw6vgqzsp.dacaffcd8b4e1b35c2752f065e906f3a",
  );
});

test("serves Emby system metadata without contacting the upstream", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/emby/System/Info/Public"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ProductName, "Emby Compatible Server");
});

test("advertises an auto-login Emby guest without a password", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/emby/Users/Public"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );

  const [user] = await response.json();
  assert.equal(response.status, 200);
  assert.equal(user.Name, "JAVDB Guest");
  assert.equal(user.HasPassword, false);
  assert.equal(user.HasConfiguredPassword, false);
  assert.equal(user.EnableAutoLogin, true);
});

test("authenticates an empty Emby login as the local guest", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/emby/Users/AuthenticateByName", {
      method: "POST",
    }),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.AccessToken, "bbjavdb-guest");
  assert.equal(payload.User.Name, "JAVDB Guest");
  assert.equal(payload.User.HasPassword, false);
});

test("can disable passwordless Emby guest access", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/emby/Users/AuthenticateByName", {
      method: "POST",
    }),
    { EMBY_GUEST_ACCESS: "false" },
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );

  assert.equal(response.status, 401);
});

test("advertises the configured Emby server version", async () => {
  const response = await callLocalEmby(
    new Request("https://clone.example/emby/System/Info/Public"),
    { EMBY_SERVER_VERSION: "4.11.0.4" },
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).Version, "4.11.0.4");
});

test("accepts the official POST PlayedItems Delete form and returns UserData", async () => {
  await callLocalEmby(embyJsonRequest("/Sessions/Playing", {
    ItemId: "42",
    PlaySessionId: "session-old",
    PositionTicks: 120_000_000,
  }));

  const response = await callLocalEmby(embyJsonRequest(
    "/Users/bbjavdb-user/PlayedItems/42/Delete",
  ));
  const userData = await response.json();
  assert.equal(response.status, 200);
  assert.equal(userData.Played, false);
  assert.equal(userData.PlaybackPositionTicks, 0);

  const readBack = await callLocalEmby(new Request(
    "https://clone.example/emby/Items/42/UserData",
  ));
  assert.equal((await readBack.json()).PlaybackPositionTicks, 0);
});

test("accepts DELETE PlayedItems and returns UserData JSON", async () => {
  await callLocalEmby(embyJsonRequest("/Sessions/Playing", {
    ItemId: "42",
    PlaySessionId: "session-old",
    PositionTicks: 120_000_000,
  }));

  const response = await callLocalEmby(embyJsonRequest(
    "/Users/bbjavdb-user/PlayedItems/42",
    undefined,
    "DELETE",
  ));
  const userData = await response.json();
  assert.equal(response.status, 200);
  assert.equal(userData.Played, false);
  assert.equal(userData.PlaybackPositionTicks, 0);
});

test("accepts the official POST FavoriteItems Delete form", async () => {
  await callLocalEmby(embyJsonRequest("/Users/bbjavdb-user/FavoriteItems/42"));
  const response = await callLocalEmby(embyJsonRequest(
    "/Users/bbjavdb-user/FavoriteItems/42/Delete",
  ));
  const userData = await response.json();

  assert.equal(response.status, 200);
  assert.equal(userData.IsFavorite, false);
});

test("HideFromResume true removes the record and false clears the tombstone", async () => {
  await callLocalEmby(embyJsonRequest("/Sessions/Playing", {
    ItemId: "42",
    PlaySessionId: "session-old",
    PositionTicks: 120_000_000,
  }));

  const hidden = await callLocalEmby(embyJsonRequest(
    "/Users/bbjavdb-user/Items/42/HideFromResume?Hide=true",
  ));
  assert.equal((await hidden.json()).PlaybackPositionTicks, 0);

  const shown = await callLocalEmby(embyJsonRequest(
    "/Users/bbjavdb-user/Items/42/HideFromResume?Hide=false",
  ));
  assert.equal((await shown.json()).PlaybackPositionTicks, 0);

  await callLocalEmby(embyJsonRequest("/Sessions/Playing/Progress", {
    ItemId: "42",
    PlaySessionId: "session-new",
    PositionTicks: 10_000_000,
  }));
  const readBack = await callLocalEmby(new Request(
    "https://clone.example/emby/Items/42/UserData",
  ));
  assert.equal((await readBack.json()).PlaybackPositionTicks, 10_000_000);
});

test("does not resurrect a deleted record from late playback progress", async () => {
  await callLocalEmby(embyJsonRequest("/Sessions/Playing", {
    ItemId: "42",
    PlaySessionId: "session-old",
    PositionTicks: 120_000_000,
  }));
  await callLocalEmby(embyJsonRequest("/Users/bbjavdb-user/PlayedItems/42/Delete"));

  await callLocalEmby(embyJsonRequest("/Sessions/Playing/Progress", {
    ItemId: "42",
    PlaySessionId: "session-old",
    PositionTicks: 120_000_000,
  }));
  const readBack = await callLocalEmby(new Request(
    "https://clone.example/emby/Items/42/UserData",
  ));
  assert.equal((await readBack.json()).PlaybackPositionTicks, 0);
});

test("keeps a D1-backed deletion across a fresh instance cache", async () => {
  const env = { PLAYBACK_DB: createPlaybackD1() };
  await callLocalEmby(embyJsonRequest("/Sessions/Playing", {
    ItemId: "42",
    PlaySessionId: "session-d1-old",
    PositionTicks: 120_000_000,
  }), env);
  await callLocalEmby(embyJsonRequest("/Users/bbjavdb-user/PlayedItems/42/Delete"), env);

  // 模拟请求落到一个全新的 Worker 实例：内存缓存全空，只能相信 D1。
  resetEmbyCachesForTests();

  const lateProgress = await callLocalEmby(embyJsonRequest("/Sessions/Playing/Progress", {
    ItemId: "42",
    PlaySessionId: "session-d1-old",
    PositionTicks: 120_000_000,
  }), env);
  assert.equal(lateProgress.status, 204);

  const readBack = await callLocalEmby(new Request(
    "https://clone.example/emby/Items/42/UserData",
  ), env);
  assert.equal((await readBack.json()).PlaybackPositionTicks, 0);
});

test("recovers the sole username playback bucket when the session mapping was lost", async () => {
  const db = createPlaybackD1();
  const env = { PLAYBACK_DB: db };
  const username = "recovery-user";
  const stateKey =
    `playback-state-v1:u:${createHash("md5").update(username).digest("hex")}`;
  db.rows.set(
    `playback\u0000${stateKey}`,
    JSON.stringify({
      "42": {
        positionTicks: 345_000_000,
        played: false,
      },
    }),
  );

  const readBack = await callLocalEmby(
    new Request("https://clone.example/emby/Items/42/UserData", {
      headers: { "X-MediaBrowser-Token": "old-token-without-session-map" },
    }),
    env,
  );
  assert.equal(readBack.status, 200);
  assert.equal((await readBack.json()).PlaybackPositionTicks, 345_000_000);

  const sessionKey = `session-user:v1:${
    createHash("md5").update("old-token-without-session-map").digest("hex")
  }`;
  const sessionRow = await db
    .prepare("SELECT value FROM playback_json WHERE namespace = ? AND key = ?")
    .bind("session-user", sessionKey)
    .first();
  assert.ok(sessionRow && sessionRow.value.includes(stateKey));
});

test("merges legacy token playback buckets into the username bucket without reviving removed items", async () => {
  const db = createPlaybackD1();
  const env = { PLAYBACK_DB: db };
  const username = "migration-user";
  const usernameHash = createHash("md5").update(username).digest("hex");
  const usernameKey = `playback-state-v1:u:${usernameHash}`;
  const token = "fresh-login-token";
  const tokenHash = createHash("md5").update(token).digest("hex");
  const legacyHash = "1f8984e04c580dff1da18f103d8ed9d5";

  // 新 token 能解析出用户名，但历史映射丢失，用户名分桶还是空的。
  db.rows.set(
    `session-user\u0000session-user:v1:${tokenHash}`,
    JSON.stringify({ at: 1791131217921, username, trusted: true }),
  );
  // 旧部署把进度写在 token 分桶里。
  db.rows.set(
    `playback\u0000playback-state-v1:${legacyHash}`,
    JSON.stringify({
      "42": {
        itemId: "42",
        positionTicks: 700_000_000,
        played: false,
        lastPlayedDate: "2026-10-03T20:05:11.025Z",
      },
      "77": {
        itemId: "77",
        positionTicks: 100_000_000,
        played: false,
        lastPlayedDate: "2026-10-03T19:00:00.000Z",
      },
    }),
  );
  // 用户此前“移除播放记录”的条目必须继续被墓碑挡住。
  db.rows.set(
    `tombstone\u0000${usernameKey}:removed-v2`,
    JSON.stringify({
      "77": {
        at: 1791131300000,
        positionTicks: 100_000_000,
        played: false,
        playSessionId: "",
        pendingPlaySessionId: "",
        pendingAt: 0,
      },
    }),
  );

  const readBack = await callLocalEmby(
    new Request("https://clone.example/emby/Items/42/UserData", {
      headers: { "X-MediaBrowser-Token": token },
    }),
    env,
  );
  assert.equal(readBack.status, 200);
  assert.equal((await readBack.json()).PlaybackPositionTicks, 700_000_000);

  const migratedRow = await db
    .prepare("SELECT value FROM playback_json WHERE namespace = ? AND key = ?")
    .bind("playback", usernameKey)
    .first();
  assert.ok(migratedRow, "legacy data must be merged into the username bucket");
  const migrated = JSON.parse(migratedRow.value);
  assert.ok(migrated["42"], "watched item should be restored");
  assert.ok(!migrated["77"], "removed item must stay deleted after migration");

  const markerRow = await db
    .prepare("SELECT value FROM playback_json WHERE namespace = ? AND key = ?")
    .bind("session-user", `session-user:v1:migrate-v1:${usernameHash}`)
    .first();
  assert.ok(markerRow && markerRow.value.includes("sources"), "migration marker must be persisted");
});

test("does not adopt orphan playback buckets when the deployment has multiple users", async () => {
  const db = createPlaybackD1();
  const env = { PLAYBACK_DB: db };
  const token = "alice-token";
  const otherToken = "bob-token";
  db.rows.set(
    `session-user\u0000session-user:v1:${createHash("md5").update(token).digest("hex")}`,
    JSON.stringify({ at: 1, username: "alice", trusted: true }),
  );
  db.rows.set(
    `session-user\u0000session-user:v1:${createHash("md5").update(otherToken).digest("hex")}`,
    JSON.stringify({ at: 1, username: "bob", trusted: true }),
  );
  db.rows.set(
    "playback\u0000playback-state-v1:deadbeefdeadbeefdeadbeefdeadbeef",
    JSON.stringify({
      "42": { itemId: "42", positionTicks: 999_000_000, played: false },
    }),
  );

  const readBack = await callLocalEmby(
    new Request("https://clone.example/emby/Items/42/UserData", {
      headers: { "X-MediaBrowser-Token": token },
    }),
    env,
  );
  assert.equal(readBack.status, 200);
  assert.equal((await readBack.json()).PlaybackPositionTicks, 0);
});

test("reports a D1 write failure instead of silently accepting playback state", async () => {
  const env = { PLAYBACK_DB: createPlaybackD1({ failWrites: true }) };
  const progress = await callLocalEmby(embyJsonRequest("/Sessions/Playing", {
    ItemId: "42",
    PlaySessionId: "session-d1-broken",
    PositionTicks: 120_000_000,
  }), env);
  assert.equal(progress.status, 503);

  const deleted = await callLocalEmby(
    embyJsonRequest("/Users/bbjavdb-user/PlayedItems/42/Delete"),
    env,
  );
  assert.equal(deleted.status, 503);
});

test("persists the exact DELETE PlayedItems route to D1 instead of only answering 200", async () => {
  const env = { PLAYBACK_DB: createPlaybackD1() };
  await callLocalEmby(embyJsonRequest("/Sessions/Playing", {
    ItemId: "42",
    PlaySessionId: "session-exact-delete",
    PositionTicks: 120_000_000,
  }), env);

  // Emby 官方客户端的“移除播放记录”就是这个精确路由。它必须真的把
  // playback 清空并写入墓碑，否则客户端刷新后旧进度会把记录带回来。
  const deleted = await callLocalEmby(embyJsonRequest(
    "/Users/bbjavdb-user/PlayedItems/42",
    undefined,
    "DELETE",
  ), env);
  assert.equal(deleted.status, 200);

  const db = env.PLAYBACK_DB;
  const stateRow = await db
    .prepare("SELECT value FROM playback_json WHERE namespace = ? AND key = ?")
    .bind("playback", "playback-state-v1")
    .first();
  assert.equal(stateRow.value, "{}");

  const tombstoneRow = await db
    .prepare("SELECT value FROM playback_json WHERE namespace = ? AND key = ?")
    .bind("tombstone", "playback-state-v1:removed-v2")
    .first();
  assert.ok(tombstoneRow && tombstoneRow.value.includes("\"42\""), "tombstone for the removed item must be persisted");

  // 全新实例（内存缓存清空）补发同一会话的旧进度也不能复活记录。
  resetEmbyCachesForTests();
  await callLocalEmby(embyJsonRequest("/Sessions/Playing/Progress", {
    ItemId: "42",
    PlaySessionId: "session-exact-delete",
    PositionTicks: 120_000_000,
  }), env);
  const readBack = await callLocalEmby(new Request(
    "https://clone.example/emby/Items/42/UserData",
  ), env);
  assert.equal((await readBack.json()).PlaybackPositionTicks, 0);
});

test("does not resurrect a batch-deleted record from late playback progress", async () => {
  await callLocalEmby(embyJsonRequest("/Sessions/Playing", {
    ItemId: "42",
    PlaySessionId: "session-batch-old",
    PositionTicks: 120_000_000,
  }));

  const deleted = await callLocalEmby(
    new Request("https://clone.example/emby/Items?Ids=42", {
      method: "DELETE",
    }),
  );
  assert.equal(deleted.status, 204);

  await callLocalEmby(embyJsonRequest("/Sessions/Playing/Progress", {
    ItemId: "42",
    PlaySessionId: "session-batch-old",
    PositionTicks: 120_000_000,
  }));
  const readBack = await callLocalEmby(new Request(
    "https://clone.example/emby/Items/42/UserData",
  ));
  assert.equal((await readBack.json()).PlaybackPositionTicks, 0);
});

test("allows a strict zero-progress restart to clear the deleted tombstone", async () => {
  await callLocalEmby(embyJsonRequest("/Sessions/Playing", {
    ItemId: "42",
    PlaySessionId: "session-old",
    PositionTicks: 120_000_000,
  }));
  await callLocalEmby(embyJsonRequest("/Users/bbjavdb-user/PlayedItems/42/Delete"));

  await callLocalEmby(embyJsonRequest("/Sessions/Playing", {
    ItemId: "42",
    PlaySessionId: "session-new",
    PositionTicks: 0,
  }));
  await callLocalEmby(embyJsonRequest("/Sessions/Playing/Progress", {
    ItemId: "42",
    PlaySessionId: "session-new",
    PositionTicks: 5_000_000,
  }));

  const readBack = await callLocalEmby(new Request(
    "https://clone.example/emby/Items/42/UserData",
  ));
  assert.equal((await readBack.json()).PlaybackPositionTicks, 5_000_000);
});

test("maps JavDB movies into an Emby item list", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/Items?ParentId=bbjavdb-root&Limit=10"),
    {},
    {},
    async (url) => {
      assert.match(url, /jdforrepam\.com\/api\/v1\/movies\/latest/);
      assert.match(url, /filter_by=subtitle/);
      assert.match(url, /limit=50/);
      return new Response(
        JSON.stringify({
          success: 1,
          data: {
            movies: [
              {
                id: 42,
                number: "TEST-001",
                title: "Test Movie",
                release_date: "2024-01-02",
                duration: 120,
                summary: "A test movie",
                cover_url: "https://jdforrepam.com/covers/test.jpg",
                tags: [{ name: "Drama" }],
                can_play: true,
                has_cnsub: true,
              },
              {
                id: 43,
                number: "TEST-002",
                title: "Not Playable",
                can_play: false,
                has_cnsub: true,
              },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.Items[0].Id, "42");
  assert.equal(payload.Items[0].Name, "TEST-001 Test Movie");
  assert.equal(payload.Items[0].Type, "Movie");
  assert.equal(payload.Items[0].ServerId, "bbjavdb-emby");
  assert.equal(payload.Items[0].ParentId, "bbjavdb-root");
  assert.equal(payload.Items.length, 1);
  assert.deepEqual(payload.Items[0].Genres, ["中文字幕", "Drama"]);
});

test("supports both SearchHints aliases used by Emby clients", async () => {
  const movies = [
    {
      id: "NQ7Mdg",
      number: "RCTD-740",
      title: "Exact result",
      can_play: true,
      has_cnsub: true,
    },
    {
      id: "rzKDJ",
      number: "RCTD-740",
      title: "Backup result",
      can_play: true,
      has_cnsub: true,
    },
    {
      id: "wrong-code",
      number: "RCTD-340",
      title: "Wrong fuzzy result",
      can_play: true,
      has_cnsub: true,
    },
  ];

  for (const path of ["/SearchHints", "/Search/Hints"]) {
    const response = await handleProxy(
      new Request(
        `https://clone.example/emby${path}?SearchTerm=RCTD-740&Limit=20`,
      ),
      {},
      {},
      async (url) => {
        assert.match(url, /\/v2\/search\?/);
        assert.match(url, /q=RCTD-740/);
        assert.match(url, /movie_filter_by=can_play/);
        return new Response(
          JSON.stringify({ success: 1, data: { movies } }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );

    const payload = await response.json();
    assert.equal(response.status, 200, path);
    assert.deepEqual(
      payload.SearchHints.map((item) => item.ItemId),
      ["NQ7Mdg", "rzKDJ"],
      path,
    );
    assert.equal(payload.SearchHints[0].Name, "RCTD-740 Exact result", path);
  }
});

test("reports the exact search count after filtering fuzzy results", async () => {
  const movies = [
    {
      id: "NQ7Mdg",
      number: "RCTD-740",
      title: "Exact result",
      can_play: true,
      has_cnsub: true,
    },
    {
      id: "wrong-code",
      number: "RCTD-340",
      title: "Wrong fuzzy result",
      can_play: true,
      has_cnsub: true,
    },
  ];
  const response = await handleProxy(
    new Request(
      "https://clone.example/emby/Items?SearchTerm=RCTD-740&Recursive=true&IncludeItemTypes=Movie&Limit=20",
    ),
    {},
    {},
    async () => new Response(
      JSON.stringify({ success: 1, data: { movies } }),
      { headers: { "content-type": "application/json" } },
    ),
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.TotalRecordCount, 1);
  assert.deepEqual(payload.Items.map((item) => item.Id), ["NQ7Mdg"]);
});

test("expands single-character searches with a wildcard and a larger page size", async () => {
  const searchCalls = [];
  const movies = [
    {
      id: "mother-1",
      number: "ABC-001",
      title: "母の日",
      can_play: true,
      has_cnsub: true,
    },
  ];
  const response = await handleProxy(
    new Request(
      "https://clone.example/emby/Items?SearchTerm=%E6%AF%8D&Recursive=true&IncludeItemTypes=Movie&Limit=20",
    ),
    {},
    {},
    async (url) => {
      const target = String(url);
      if (target.includes("/v2/search?") || target.includes("/v2/search&")) {
        searchCalls.push(target);
      }
      return new Response(
        JSON.stringify({ success: 1, data: { movies } }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.Items.map((item) => item.Id), ["mother-1"]);
  assert.equal(searchCalls.length > 0, true);
  for (const target of searchCalls) {
    // 单字关键词必须补通配符，否则上游固定返回 0 条。
    assert.match(target, /q=%E6%AF%8D\*/);
    // 每页 50 条（上游上限决定单库最多 ~950 条，20 条/页时只有 ~380 条）。
    assert.match(target, /limit=50/);
  }
});

test("returns every playable movie for a global search without a ParentId", async () => {
  const filters = [];
  const movies = [
    {
      id: "cn-1",
      number: "CN-001",
      title: "母 中文字幕",
      can_play: true,
      has_cnsub: true,
    },
    {
      id: "raw-1",
      number: "RAW-001",
      title: "母 无字幕",
      can_play: true,
      has_cnsub: false,
    },
    {
      id: "off-1",
      number: "OFF-001",
      title: "母 不能播",
      can_play: false,
      has_cnsub: true,
    },
  ];
  const response = await handleProxy(
    new Request(
      "https://clone.example/emby/Items?SearchTerm=%E6%AF%8D&Recursive=true&IncludeItemTypes=Movie&Limit=20",
    ),
    {},
    {},
    async (url) => {
      filters.push(new URL(String(url)).searchParams.get("movie_filter_by"));
      return new Response(
        JSON.stringify({ success: 1, data: { movies } }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  // 全局搜索不再限制“中文字幕”，只按上游 can_play 过滤，单次查询、不跨库汇总。
  assert.deepEqual([...new Set(filters)], ["can_play"]);
  // 可播放的都返回（含没有中文字幕的），不能播放的仍然被过滤掉。
  assert.deepEqual(payload.Items.map((item) => item.Id).sort(), ["cn-1", "raw-1"]);
  // TotalRecordCount 要是过滤后的真实数量，客户端才会继续往下翻页。
  assert.equal(payload.TotalRecordCount, 2);
});

test("reuses one upstream scan across search pages", async () => {
  // 全量扫描类的列表每翻一页都重扫上游会明显变慢，并把 Worker 推到
  // Cloudflare 1102（CPU / 内存超限）。这里锁住“整轮扫描只做一次”的行为。
  let searchCalls = 0;
  const movies = Array.from({ length: 40 }, (_, index) => ({
    id: `page-${index}`,
    number: `PAGE-${String(index).padStart(3, "0")}`,
    title: `母 ${index}`,
    can_play: true,
    has_cnsub: true,
  }));
  const fetchImpl = async (url) => {
    if (String(url).includes("/v2/search")) {
      searchCalls += 1;
    }
    return new Response(
      JSON.stringify({ success: 1, data: { movies } }),
      { headers: { "content-type": "application/json" } },
    );
  };

  const firstResponse = await handleProxy(
    new Request(
      "https://clone.example/emby/Items?SearchTerm=%E6%AF%8D&Recursive=true&IncludeItemTypes=Movie&Limit=30&StartIndex=0",
    ),
    {},
    {},
    fetchImpl,
  );
  const first = await firstResponse.json();
  const callsAfterFirstPage = searchCalls;
  assert.equal(firstResponse.status, 200);
  assert.equal(callsAfterFirstPage > 0, true);
  assert.equal(first.Items.length, 30);
  assert.equal(first.TotalRecordCount, 40);

  const secondResponse = await handleProxy(
    new Request(
      "https://clone.example/emby/Items?SearchTerm=%E6%AF%8D&Recursive=true&IncludeItemTypes=Movie&Limit=30&StartIndex=30",
    ),
    {},
    {},
    fetchImpl,
  );
  const second = await secondResponse.json();
  assert.equal(secondResponse.status, 200);
  // 第二页没有把上游重扫一遍：翻页只是从同一份扫描结果里切。
  assert.equal(searchCalls, callsAfterFirstPage);
  // 切片位置要对得上第一页的续页：两页拼起来正好是 40 条、且互不重叠。
  const firstIds = first.Items.map((item) => item.Id);
  const secondIds = second.Items.map((item) => item.Id);
  assert.equal(secondIds.length, 10);
  assert.equal(secondIds.some((id) => firstIds.includes(id)), false);
  assert.equal(new Set([...firstIds, ...secondIds]).size, 40);
  assert.equal(second.TotalRecordCount, 40);
});

test("prewarms cached list pages but not cold upstream scans", async () => {
  // 后台预热会挂住 Worker 实例（wrangler tail 实测 wallTime 8-30 秒），
  // 冷启动的全量扫描再叠一层预热最容易撞 Cloudflare 1102。
  // 这里锁住策略：只有命中缓存、很便宜的那次响应才登记后台预热。
  const movies = Array.from({ length: 40 }, (_, index) => ({
    id: `warm-${index}`,
    number: `WARM-${String(index).padStart(3, "0")}`,
    title: `母 ${index}`,
    can_play: true,
    has_cnsub: true,
  }));
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes("/api/subtitle")) {
      return new Response(JSON.stringify({ code: 0, data: [] }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (text.includes("/api/v/resolve")) {
      return new Response(JSON.stringify({ success: 1, data: { movie: {} } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ success: 1, data: { movies } }),
      { headers: { "content-type": "application/json" } },
    );
  };

  const coldTasks = [];
  const coldResponse = await handleProxy(
    new Request(
      "https://clone.example/emby/Items?SearchTerm=%E6%AF%8D&Recursive=true&IncludeItemTypes=Movie&Limit=30&StartIndex=0",
    ),
    {},
    { waitUntil: (task) => coldTasks.push(task) },
    fetchImpl,
  );
  assert.equal(coldResponse.status, 200);
  // 冷启动要扫满上游，这次响应不该再登记任何后台预热。
  assert.equal(coldTasks.length, 0);

  const warmTasks = [];
  const warmResponse = await handleProxy(
    new Request(
      "https://clone.example/emby/Items?SearchTerm=%E6%AF%8D&Recursive=true&IncludeItemTypes=Movie&Limit=30&StartIndex=30",
    ),
    {},
    { waitUntil: (task) => warmTasks.push(task) },
    fetchImpl,
  );
  assert.equal(warmResponse.status, 200);
  // 第二页命中扫描窗口：便宜，允许（且只允许）预热 1 部。
  assert.equal(warmTasks.length, 1);
  await Promise.all(warmTasks.map((task) => Promise.resolve(task).catch(() => {})));
});

test("keeps a ParentId search inside that single library", async () => {
  const filters = [];
  const response = await handleProxy(
    new Request(
      "https://clone.example/emby/Items?SearchTerm=%E6%AF%8D&ParentId=bbjavdb-chinese-playable&Recursive=true&IncludeItemTypes=Movie&Limit=20",
    ),
    {},
    {},
    async (url) => {
      filters.push(new URL(String(url)).searchParams.get("movie_filter_by"));
      return new Response(
        JSON.stringify({
          success: 1,
          data: {
            movies: [
              {
                id: "cn-1",
                number: "CN-001",
                title: "母 中文字幕",
                can_play: true,
                has_cnsub: true,
              },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual([...new Set(filters)], ["subtitle"]);
  assert.deepEqual(payload.Items.map((item) => item.Id), ["cn-1"]);
});

test("resolves a movie number through exact search and exposes all playback sources", async () => {
  const mediaUrls = [2160, 1080, 720, 480].map((quality) =>
    `https://fast-stream.jav.si/rctd-740/source-${quality}.mp4`
  );
  const calls = [];
  const response = await handleProxy(
    new Request("https://clone.example/Items/RCTD-740"),
    {},
    {},
    async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/RCTD-740")) {
        return new Response(
          JSON.stringify({ success: 0, message: "movie id not found" }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes("/v2/search?")) {
        assert.match(target, /q=RCTD-740/);
        assert.match(target, /movie_filter_by=can_play/);
        return new Response(
          JSON.stringify({
            success: 1,
            data: {
              movies: [
                {
                  id: "NQ7Mdg",
                  number: "RCTD-740",
                  title: "RCTD-740 Exact result",
                  can_play: true,
                  has_cnsub: true,
                },
                {
                  id: "wrong-code",
                  number: "RCTD-340",
                  title: "Wrong fuzzy result",
                  can_play: true,
                  has_cnsub: true,
                },
              ],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes("/v4/movies/NQ7Mdg")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: {
              movie: {
                id: "NQ7Mdg",
                number: "RCTD-740",
                title: "RCTD-740 Exact result",
                can_play: true,
                has_cnsub: true,
                media_source_count: 4,
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (/\/api\/(?:v\/)?resolve\?code=RCTD-740/.test(target)) {
        return new Response(
          JSON.stringify({
            variants: mediaUrls.map((sourceUrl, index) => ({
              variant: `source-${index + 1}`,
              label: `线路 ${index + 1}`,
              sourceUrl,
              sourceType: "video/mp4",
              quality: [2160, 1080, 720, 480][index],
            })),
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (mediaUrls.includes(target)) {
        return new Response(Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), {
          status: 206,
          headers: { "content-type": "video/mp4" },
        });
      }
      if (target.includes("/api/subtitle?name=RCTD-740")) {
        return new Response(
          JSON.stringify({ code: 0, data: [] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${target}`);
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.Id, "NQ7Mdg");
  assert.equal(payload.Name, "RCTD-740 Exact result");
  assert.equal(payload.MediaSourceCount, 4);
  assert.equal(payload.MediaSources.length, 4);
  assert.equal(
    calls.some((target) => target.includes("/v4/movies/RCTD-740")),
    true,
  );
  assert.equal(
    calls.some((target) => target.includes("/v4/movies/NQ7Mdg")),
    true,
  );
});

test("returns a retryable detail response while cold resolution continues", async () => {
  const db = createPlaybackD1();
  const fixture = createGatedMultiSourceResolve();
  const env = {
    PLAYBACK_DB: db,
    ITEM_DETAIL_RESOLVE_BUDGET_MS: 40,
  };

  const first = await handleProxy(
    new Request("https://clone.example/Items/42"),
    env,
    {},
    fixture.fetchImpl,
  );
  const firstPayload = await first.json();
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-type"), /^application\/json/);
  assert.equal(first.headers.get("retry-after"), null);
  assert.equal(first.headers.get("x-emby-retryable"), null);
  assert.equal(firstPayload.Id, "42");
  assert.equal(firstPayload.PlayAccess, "Full");
  // 解析未完成时下发一条“按需线路”占位：客户端只在 MediaSources 非空时
  // 才显示播放按钮（空列表会被整个藏掉），这条占位源播放时由取流接口
  // 现场解析真实地址，不会播到假地址。
  assert.equal(firstPayload.MediaSourceCount, 1);
  assert.equal(firstPayload.MediaSources.length, 1);
  assert.equal(firstPayload.MediaSources[0].Name, "自动线路（解析中）");
  // 占位线路的 Path 必须指向本服务的取流接口且不带 source 参数，
  // 否则客户端会去播一个伪造的上游地址。
  assert.match(firstPayload.MediaSources[0].Path, /\/Videos\/42\/stream\.mp4\?/);
  assert.equal(
    new URL(firstPayload.MediaSources[0].Path).searchParams.has("source"),
    false,
  );
  assert.equal(typeof firstPayload.UserData, "object");
  assert.equal(
    firstPayload.Etag,
    expectedItemEtag(firstPayload, { pendingSources: true }),
  );
  assert.equal(
    [...db.rows.keys()].some((key) => key.startsWith("video-persist-v1\u0000")),
    false,
  );

  await fixture.resolverStarted;
  fixture.releaseResolver();
  const second = await handleProxy(
    new Request("https://clone.example/Items/42"),
    {
      ...env,
      ITEM_DETAIL_RESOLVE_BUDGET_MS: 2000,
    },
    {},
    fixture.fetchImpl,
  );
  const secondPayload = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondPayload.MediaSourceCount, 4);
  assert.equal(secondPayload.MediaSources.length, 4);
  assert.equal(
    new Set(secondPayload.MediaSources.map((source) => source.Name)).size,
    secondPayload.MediaSources.length,
  );
  assert.equal(secondPayload.Etag, expectedItemEtag(secondPayload));
  assert.equal(
    [...db.rows.keys()].some((key) => key.includes("sources-v31|RCTD-740")),
    true,
  );
});

test("keeps unverified multi-source HLS lines when validation budget expires", async () => {
  const hlsUrls = [2160, 1080, 720, 480].map((quality) =>
    `https://fast-stream.jav.si/12345/line-${quality}/index.m3u8`
  );
  let abortedProbes = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/v4/movies/42")) {
      return new Response(
        JSON.stringify({
          success: 1,
          data: {
            movie: {
              id: 42,
              number: "12345",
              title: "12345 Slow HLS",
              duration: 120,
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes("/api/v/resolve?code=12345")) {
      return new Response(
        JSON.stringify({
          variants: hlsUrls.map((sourceUrl, index) => ({
            variant: `line-${index + 1}`,
            label: `线路 ${index + 1}`,
            sourceUrl,
            sourceType: "application/vnd.apple.mpegurl",
            quality: [2160, 1080, 720, 480][index],
          })),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (hlsUrls.includes(target)) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 300);
        init.signal?.addEventListener("abort", () => {
          abortedProbes += 1;
          clearTimeout(timer);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
      return new Response("#EXTM3U\n", {
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    if (target.includes("/api/subtitle?name=12345")) {
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected request: ${target}`);
  };

  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {
      PLAYBACK_INFO_RESOLVE_BUDGET_MS: 2000,
      REMOTE_HLS_VALIDATION_BUDGET_MS: 30,
    },
    {},
    fetchImpl,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 4);
  assert.equal(
    new Set(payload.MediaSources.map((source) => source.Name)).size,
    payload.MediaSources.length,
  );
  for (const source of payload.MediaSources) {
    assert.ok(source.Size > 0);
    assert.ok(source.Bitrate > 0);
  }
  assert.ok(abortedProbes <= 2);
});

test("keeps an oversized inline HLS line without scanning the whole manifest", async () => {
  const segmentUrl = "https://cdn.oversize.example/hls/seg";
  const lines = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-VERSION:3",
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  // 约 1.2MB / 两万行：远超 64KB 扫描上限。旧实现会把整份清单 split
  // 展开并逐条探测，命中 Cloudflare 1102；新实现只看前缀并 fail-open。
  for (let index = 0; index < 20_000; index += 1) {
    lines.push("#EXTINF:6.000,");
    lines.push(`${segmentUrl}-${index}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");
  const inlineSource =
    `data:application/vnd.apple.mpegurl,${encodeURIComponent(lines.join("\n"))}`;
  let segmentProbes = 0;
  const fontBytes = Uint8Array.from([
    0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00,
  ]);

  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("/v4/movies/77")) {
      return new Response(
        JSON.stringify({
          success: 1,
          data: { movie: { id: 77, number: "OVERSIZE", title: "OVERSIZE" } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes("/api/v/resolve?code=OVERSIZE")) {
      return new Response(
        JSON.stringify({
          variants: [{
            variant: "original",
            label: "原版",
            sourceUrl: inlineSource,
            sourceType: "application/vnd.apple.mpegurl",
            quality: 1080,
          }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (target.startsWith(segmentUrl)) {
      segmentProbes += 1;
      return new Response(fontBytes, {
        status: 206,
        headers: { "content-type": "font/woff2" },
      });
    }
    if (target.includes("/api/subtitle")) {
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected request: ${target}`);
  };

  const response = await handleProxy(
    new Request("https://clone.example/Items/77/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    fetchImpl,
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 1);
  assert.ok(payload.MediaSources[0].Size > 0);
  // 前缀里的分片探测量必须受预算限制，绝不能与 2 万条分片成正比。
  assert.ok(segmentProbes <= 4);
});

test("returns a placeholder playback session while PlaybackInfo resolution continues", async () => {
  const db = createPlaybackD1();
  const fixture = createGatedMultiSourceResolve();
  const env = {
    PLAYBACK_DB: db,
    PLAYBACK_INFO_RESOLVE_BUDGET_MS: 40,
  };

  const first = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", { method: "POST" }),
    env,
    {},
    fixture.fetchImpl,
  );
  const firstPayload = await first.json();
  // 详情页已经给了“按需线路”占位，PlaybackInfo 继续回 503 会让用户在
  // 有点击按钮的情况下看到 “Connection timeout, try again later”。
  // 所以这里返回同一条占位线路 + 一个真实 PlaySessionId。
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("retry-after"), null);
  assert.equal(first.headers.get("x-emby-retryable"), null);
  assert.ok(firstPayload.PlaySessionId);
  assert.equal(firstPayload.MediaSources.length, 1);
  assert.equal(firstPayload.MediaSources[0].Name, "自动线路（解析中）");

  const deleted = await callLocalEmby(
    embyJsonRequest("/Users/bbjavdb-user/PlayedItems/42/Delete"),
    env,
  );
  assert.equal(deleted.status, 200);
  const tombstoneRow = await db
    .prepare("SELECT value FROM playback_json WHERE namespace = ? AND key = ?")
    .bind("tombstone", "playback-state-v1:removed-v2")
    .first();
  const tombstone = JSON.parse(tombstoneRow.value);
  // 移除记录时会记下当前正在使用的播放会话（这里是刚下发的占位会话），
  // 之后同一会话的残留进度上报会被墓碑挡掉。
  assert.equal(tombstone["42"].playSessionId, firstPayload.PlaySessionId);

  await fixture.resolverStarted;
  fixture.releaseResolver();
  const second = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", { method: "POST" }),
    {
      ...env,
      PLAYBACK_INFO_RESOLVE_BUDGET_MS: 2000,
    },
    {},
    fixture.fetchImpl,
  );
  const secondPayload = await second.json();
  assert.equal(second.status, 200);
  assert.ok(secondPayload.PlaySessionId);
  assert.equal(secondPayload.MediaSources.length, 4);
});

test("returns an authoritative empty result after source resolution completes", async () => {
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("/v4/movies/42")) {
      return new Response(
        JSON.stringify({
          success: 1,
          data: {
            movie: {
              id: 42,
              number: "RCTD-740",
              title: "RCTD-740 Missing",
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes("/api/v/resolve?code=RCTD-740")) {
      return new Response(
        JSON.stringify({ variants: [] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (
      target.includes("javtiful.com") ||
      target.includes("r.jina.ai") ||
      target.includes("getav.net")
    ) {
      return new Response("<html>No matching video</html>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (/\/api\/subtitle\?name=RCTD-740/.test(target)) {
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected empty-source request: ${target}`);
  };
  const env = {
    ITEM_DETAIL_RESOLVE_BUDGET_MS: 500,
    PLAYBACK_INFO_RESOLVE_BUDGET_MS: 500,
    RESOLVER_MERGE_BUDGET_MS: 10,
    SELF_HOSTED_MERGE_BUDGET_MS: 10,
  };

  const detail = await handleProxy(
    new Request("https://clone.example/Items/42"),
    env,
    {},
    fetchImpl,
  );
  const detailPayload = await detail.json();
  assert.equal(detail.status, 200);
  assert.equal(detailPayload.PlayAccess, "None");
  assert.deepEqual(detailPayload.MediaSources, []);

  const playback = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", { method: "POST" }),
    env,
    {},
    fetchImpl,
  );
  const playbackPayload = await playback.json();
  assert.equal(playback.status, 200);
  assert.equal(playbackPayload.PlaySessionId, "");
  assert.deepEqual(playbackPayload.MediaSources, []);
});

test("buckets the pending detail ETag so clients refresh within 20 seconds", async () => {
  const fixture = createGatedMultiSourceResolve();
  const env = { ITEM_DETAIL_RESOLVE_BUDGET_MS: 40 };
  const realNow = Date.now;
  const base = realNow.call(Date);
  try {
    Date.now = () => base;
    const first = await handleProxy(
      new Request("https://clone.example/Items/42"),
      env,
      {},
      fixture.fetchImpl,
    );
    const firstPayload = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstPayload.MediaSources.length, 1);
    assert.equal(firstPayload.MediaSources[0].Name, "自动线路（解析中）");

    // 同一个 20 秒桶内 ETag 稳定，但“解析中”绝不回 304：客户端把整份 DTO
    // 存在本地库里，304 会让它继续用没有播放按钮的旧副本。
    const sameBucket = await handleProxy(
      new Request("https://clone.example/Items/42", {
        headers: { "if-none-match": firstPayload.Etag },
      }),
      env,
      {},
      fixture.fetchImpl,
    );
    assert.equal(sameBucket.status, 200);
    assert.equal((await sameBucket.json()).Etag, firstPayload.Etag);

    // 跨过 20 秒桶后 ETag 必须变化，客户端重新进详情页才会刷新。
    Date.now = () => base + 20 * 1000;
    const later = await handleProxy(
      new Request("https://clone.example/Items/42", {
        headers: { "if-none-match": firstPayload.Etag },
      }),
      env,
      {},
      fixture.fetchImpl,
    );
    assert.equal(later.status, 200);
    assert.notEqual((await later.json()).Etag, firstPayload.Etag);
  } finally {
    Date.now = realNow;
    fixture.releaseResolver();
  }
});

test("keeps Worker and Pages playback records separate on one shared D1", async () => {
  const db = createPlaybackD1();
  const workerEnv = { PLAYBACK_DB: db, PLAYBACK_DEPLOY_TAG: "worker" };
  const pagesEnv = { PLAYBACK_DB: db, PLAYBACK_DEPLOY_TAG: "pages" };

  await callLocalEmby(embyJsonRequest("/Sessions/Playing", {
    ItemId: "42",
    PlaySessionId: "session-worker",
    PositionTicks: 60_000_000,
  }), workerEnv);

  const workerRead = await callLocalEmby(
    new Request("https://clone.example/emby/Items/42/UserData"),
    workerEnv,
  );
  assert.equal((await workerRead.json()).PlaybackPositionTicks, 60_000_000);
  assert.equal(
    db.rows.has("playback\u0000playback-state-v1:worker"),
    true,
  );

  // Pages 绑定同一个 D1，但分桶带自己的部署标记，读不到 Worker 的记录。
  resetEmbyCachesForTests();
  const pagesRead = await callLocalEmby(
    new Request("https://clone.example/emby/Items/42/UserData"),
    pagesEnv,
  );
  assert.equal((await pagesRead.json()).PlaybackPositionTicks, 0);
  // 只读取不会凭空建分桶，更不能把 Worker 的记录搬到 Pages 名下。
  assert.equal(
    db.rows.has("playback\u0000playback-state-v1:worker"),
    true,
  );

  // 反过来也一样：Pages 写入的记录不会出现在 Worker 上。
  await callLocalEmby(embyJsonRequest("/Sessions/Playing", {
    ItemId: "77",
    PlaySessionId: "session-pages",
    PositionTicks: 30_000_000,
  }), pagesEnv);
  resetEmbyCachesForTests();
  const workerAfter = await callLocalEmby(
    new Request("https://clone.example/emby/Items/77/UserData"),
    workerEnv,
  );
  assert.equal((await workerAfter.json()).PlaybackPositionTicks, 0);
});

test("adopts the legacy shared bucket once so deletions stay deleted", async () => {
  const db = createPlaybackD1();
  // 旧版本没有部署标记，Worker 与 Pages 共用这个分桶。
  db.rows.set(
    "playback\u0000playback-state-v1",
    JSON.stringify({
      "42": {
        itemId: "42",
        positionTicks: 120_000_000,
        played: false,
        playCount: 0,
        lastPlayedDate: "",
      },
    }),
  );
  const env = { PLAYBACK_DB: db, PLAYBACK_DEPLOY_TAG: "worker" };

  // 升级后第一次读取：把旧分桶整份收养过来，用户不会看到记录凭空消失。
  const adopted = await callLocalEmby(
    new Request("https://clone.example/emby/Items/42/UserData"),
    env,
  );
  assert.equal((await adopted.json()).PlaybackPositionTicks, 120_000_000);

  await callLocalEmby(
    embyJsonRequest("/Users/bbjavdb-user/PlayedItems/42/Delete"),
    env,
  );
  const afterDelete = await callLocalEmby(
    new Request("https://clone.example/emby/Items/42/UserData"),
    env,
  );
  assert.equal((await afterDelete.json()).PlaybackPositionTicks, 0);

  // 换一个全新实例（内存全空）：收养标记已经落在 D1 里，旧分桶不能再被
  // 重新收养，否则用户刚删掉的记录又会被历史数据灌回来。
  resetEmbyCachesForTests();
  const fresh = await callLocalEmby(
    new Request("https://clone.example/emby/Items/42/UserData"),
    env,
  );
  assert.equal((await fresh.json()).PlaybackPositionTicks, 0);
});

test("moves a legacy session stateKey into the tagged bucket without losing records", async () => {
  const db = createPlaybackD1();
  const env = { PLAYBACK_DB: db, PLAYBACK_DEPLOY_TAG: "worker" };
  const username = "legacy-session-user";
  const usernameHash = createHash("md5").update(username).digest("hex");
  const legacyKey = `playback-state-v1:u:${usernameHash}`;
  const token = "legacy-session-token";
  const tokenHash = createHash("md5").update(token).digest("hex");

  // 升级前的 SESSION 记录直接把无标记 key 存进了 stateKey。
  db.rows.set(
    `session-user\u0000session-user:v1:${tokenHash}`,
    JSON.stringify({ at: Date.now(), username, trusted: true, stateKey: legacyKey }),
  );
  db.rows.set(
    `playback\u0000${legacyKey}`,
    JSON.stringify({
      "42": {
        itemId: "42",
        positionTicks: 900_000_000,
        played: false,
        lastPlayedDate: "2026-10-05T10:00:00.000Z",
      },
    }),
  );

  const readBack = await callLocalEmby(
    new Request("https://clone.example/emby/Items/42/UserData", {
      headers: { "X-MediaBrowser-Token": token },
    }),
    env,
  );
  assert.equal(readBack.status, 200);
  // 记录不能因为换了分桶 key 就消失。
  assert.equal((await readBack.json()).PlaybackPositionTicks, 900_000_000);
  // 之后读写都落在带部署标记的分桶上。
  assert.equal(
    db.rows.has(`playback\u0000playback-state-v1:worker:u:${usernameHash}`),
    true,
  );
});

test("forwards Emby access tokens to JavDB catalog requests", async () => {
  let authorization;
  const response = await handleProxy(
    new Request(
      "https://clone.example/Users/bbjavdb-user/Items?ParentId=bbjavdb-root&Limit=1",
      { headers: { "X-MediaBrowser-Token": "javdb-token" } },
    ),
    {},
    {},
    async (_url, init) => {
      authorization = init.headers.get("authorization");
      return new Response(
        JSON.stringify({ success: 1, data: { movies: [] } }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  assert.equal(response.status, 200);
  assert.equal(authorization, null);
});

test("maps the playable media library to the playable JavDB filter", async () => {
  const response = await handleProxy(
    new Request(
      "https://clone.example/Items?ParentId=bbjavdb-playable&Limit=10",
    ),
    {},
    {},
    async (url) => {
      assert.match(url, /filter_by=can_play/);
      return new Response(
        JSON.stringify({
          success: 1,
          data: {
            movies: [{
              id: 44,
              number: "TEST-003",
              title: "Playable without subtitles",
              can_play: true,
              has_cnsub: false,
              tags: [{ name: "Drama" }],
            }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(payload.Items.length, 1);
  assert.equal(payload.Items[0].ParentId, "bbjavdb-chinese-playable");
  assert.deepEqual(payload.Items[0].Genres, ["Drama"]);
});

test("supports an Emby-prefixed server probe", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/emby/"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ProductName, "Emby Compatible Server");
});

test("maps the user-scoped latest route into an Emby item array", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/emby/Users/bbjavdb-user/Items/Latest?Limit=1"),
    {},
    {},
    async (url) => {
      assert.match(url, /jdforrepam\.com\/api\/v1\/movies\/latest/);
      return new Response(
        JSON.stringify({
          success: 1,
          data: {
            movies: [{
              id: 42,
              number: "TEST-001",
              title: "Latest Movie",
              can_play: true,
              has_cnsub: true,
            }],
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(Array.isArray(payload), true);
  assert.equal(payload[0].Name, "TEST-001 Latest Movie");
  assert.equal(payload[0].ParentId, "bbjavdb-chinese-playable");
  assert.equal("Path" in payload[0], false);
});

test("returns JSON placeholders for optional Emby home sections", async () => {
  const paths = [
    "/emby/Users/bbjavdb-user/Items/Resume",
    "/emby/Shows/NextUp",
    "/emby/Shows/Upcoming",
    "/emby/Genres",
    "/emby/Studios",
    "/emby/Persons",
  ];

  for (const path of paths) {
    const response = await handleProxy(
      new Request(`https://clone.example${path}`),
      {},
      {},
      () => {
        throw new Error("fetch must not be called");
      },
    );
    const payload = await response.json();
    assert.equal(response.status, 200, path);
    assert.deepEqual(payload.Items, [], path);
  }
});

test("serves Emby display preferences that enable latest media", async () => {
  const response = await handleProxy(
    new Request(
      "https://clone.example/emby/DisplayPreferences/usersettings?UserId=bbjavdb-user&Client=Forward",
    ),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.UserId, "bbjavdb-user");
  assert.equal(payload.Client, "Forward");
  assert.equal(payload.Configuration.homesection0, "latestmedia");
});

test("supports common Emby client bootstrap and session endpoints", async () => {
  const me = await handleProxy(
    new Request("https://clone.example/emby/Users/Me"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );
  const endpoint = await handleProxy(
    new Request("https://clone.example/emby/System/Endpoint"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );
  const capabilities = await handleProxy(
    new Request("https://clone.example/emby/Sessions/Capabilities/Full", {
      method: "POST",
    }),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );

  assert.equal(me.status, 200);
  assert.equal((await me.json()).Id, "bbjavdb-user");
  assert.deepEqual(await endpoint.json(), { IsLocal: false, IsInNetwork: false });
  assert.equal(capabilities.status, 204);
});

test("advertises a non-empty virtual movie library", async () => {
  const views = await handleProxy(
    new Request("https://clone.example/emby/Users/bbjavdb-user/Views"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );
  const counts = await handleProxy(
    new Request("https://clone.example/emby/Items/Counts"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );

  const viewsPayload = await views.json();
  const countsPayload = await counts.json();
  assert.equal(viewsPayload.Items[0].ChildCount, 1000);
  assert.equal(viewsPayload.TotalRecordCount, 4);
  assert.equal(viewsPayload.StartIndex, 0);
  assert.deepEqual(
    viewsPayload.Items.map((item) => [item.Id, item.Name]),
    [
      ["bbjavdb-chinese-playable", "中文字幕"],
      ["bbjavdb-censored", "有码"],
      ["bbjavdb-uncensored", "无码"],
      ["bbjavdb-western", "欧美"],
    ],
  );
  assert.equal(countsPayload.MovieCount, 1000);
  assert.equal(countsPayload.ItemCount, 1000);
});

test("returns Emby-compatible media folder and virtual folder queries", async () => {
  const mediaFolders = await handleProxy(
    new Request("https://clone.example/emby/Library/MediaFolders"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );
  const virtualFolders = await handleProxy(
    new Request("https://clone.example/emby/Library/VirtualFolders/Query"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );

  const mediaPayload = await mediaFolders.json();
  const virtualPayload = await virtualFolders.json();
  assert.equal(mediaPayload.TotalRecordCount, 4);
  assert.equal(mediaPayload.Items[0].Id, "bbjavdb-chinese-playable");
  assert.equal(mediaPayload.Items[0].Type, "CollectionFolder");
  assert.equal(virtualPayload.TotalRecordCount, 4);
  assert.equal(virtualPayload.Items[0].ItemId, "bbjavdb-chinese-playable");
  assert.equal(virtualPayload.Items[0].CollectionType, "movies");
});

test("serves the user root item and user-scoped suggestions", async () => {
  const root = await handleProxy(
    new Request("https://clone.example/emby/Users/bbjavdb-user/Items/Root"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );
  const suggestions = await handleProxy(
    new Request("https://clone.example/emby/Users/bbjavdb-user/Suggestions"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );

  const rootPayload = await root.json();
  assert.equal(rootPayload.Id, "bbjavdb-root");
  assert.equal(rootPayload.Type, "Folder");
  assert.equal(rootPayload.ChildCount, 4);
  assert.deepEqual(await suggestions.json(), {
    Items: [],
    TotalRecordCount: 0,
    StartIndex: 0,
  });
});

test("returns JSON errors for unknown Emby routes instead of proxying HTML", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/emby/Unknown/Endpoint"),
    {},
    {},
    () => {
      throw new Error("fetch must not be called");
    },
  );

  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.match((await response.json()).Message, /^Emby endpoint not found/);
});

test("authenticates Emby users against JavDB and returns an access token", async () => {
  let receivedBody;
  const env = { EMBY_REAL_JAVDB_LOGIN: "true" };
  const response = await handleProxy(
    new Request("https://clone.example/Users/AuthenticateByName", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Username: "demo", Pw: "secret" }),
    }),
    env,
    {},
    async (url, init) => {
      assert.match(url, /jdforrepam\.com\/api\/v1\/sessions/);
      receivedBody = await new Response(init.body).formData();
      return new Response(
        JSON.stringify({
          success: 1,
          data: { token: "javdb-token", user: { username: "demo" } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.notEqual(payload.AccessToken, "");
  assert.equal(payload.User.Name, "demo");
  assert.equal(receivedBody.get("username"), "demo");
  assert.equal(receivedBody.get("password"), "secret");
});

test("maps full-video resolution into Emby playback info", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url) => {
      if (url.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "TEST-001", title: "Test Movie" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [{ variant: "original", sourceUrl: "https://jdforrepam.com/video/test.mp4", sourceType: "video/mp4" }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      assert.match(url, /\/api\/subtitle\?name=TEST-001/);
      return new Response(
        JSON.stringify({
          code: 0,
          data: [{
            cid: "subtitle-1",
            url: "https://subtitle.example/test.srt",
            ext: "srt",
            name: "TEST-001.srt",
          }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources[0].Container, "mp4");
  assert.match(payload.MediaSources[0].Path, /\/Videos\/42\/stream\.mp4/);
  assert.match(payload.MediaSources[0].Path, /api_key=bbjavdb-guest/);
  assert.match(payload.MediaSources[0].Path, /static=true/);
  assert.match(payload.MediaSources[0].Path, /mediaSourceId=/);
  assert.match(payload.MediaSources[0].Path, /source=https%3A%2F%2Fjdforrepam\.com/);
  assert.match(payload.MediaSources[0].DirectStreamUrl, /^\/Videos\/42\/stream\.mp4/);
  assert.equal(payload.MediaSources[0].MediaStreams[1].Type, "Audio");
  assert.equal(payload.MediaSources[0].MediaStreams[1].Codec, "aac");
  assert.equal(payload.MediaSources[0].MediaStreams[2].Language, "chi");
  assert.match(payload.MediaSources[0].MediaStreams[2].DeliveryUrl, /\/Subtitles\/2\/Stream\.srt/);
});

test("uses the configured resolver path and the public fallback path", async () => {
  const calls = [];
  const resolverOrigin = "https://resolver.example";
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    { JAVSTRM_ORIGIN: resolverOrigin },
    {},
    async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "TEST-001" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === `${resolverOrigin}/api/resolve?code=TEST-001&lang=zh`) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "original",
              sourceUrl: "https://fast-stream.jav.si/video/test.mp4",
              sourceType: "video/mp4",
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === `${UPSTREAM}/api/v/resolve?code=TEST-001&lang=zh`) {
        return new Response(JSON.stringify({ variants: [] }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (target === "https://fast-stream.jav.si/video/test.mp4") {
        return new Response(new Uint8Array([0, 0, 0, 32]), {
          status: 206,
          headers: {
            "content-range": "bytes 0-3/4",
            "content-type": "video/mp4",
          },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=TEST-001/);
      return new Response(JSON.stringify({ code: 0, data: [] }), {
        headers: { "content-type": "application/json" },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.ok(calls.includes(`${resolverOrigin}/api/resolve?code=TEST-001&lang=zh`));
  assert.ok(calls.includes(`${UPSTREAM}/api/v/resolve?code=TEST-001&lang=zh`));
  assert.equal(calls.some((target) => target.startsWith(`${resolverOrigin}/api/v/resolve`)), false);
});

test("keeps every playback source uniquely addressable across repeated reads", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/v4/movies/42")) {
      return new Response(
        JSON.stringify({
          success: 1,
          data: { movie: { id: 42, number: "TEST-001", title: "Test Movie" } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes(`${RESOLVER}/api/v/resolve`)) {
      return new Response(
        JSON.stringify({
          variants: [
            {
              variant: "original",
              sourceUrl: "https://jdforrepam.com/video/original.mp4",
              sourceType: "video/mp4",
              quality: 1080,
            },
            {
              variant: "fcjav_reducing_mosaic",
              sourceUrl: "https://jdforrepam.com/video/reduced.mp4",
              sourceType: "video/mp4",
              quality: 720,
            },
            {
              variant: "javgg_original",
              sourceUrl: "https://fast-stream.jav.si/video/alternate.mp4",
              sourceType: "video/mp4",
              quality: 1080,
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    assert.match(url, /\/api\/subtitle\?name=TEST-001/);
    return new Response(
      JSON.stringify({ code: 0, data: [] }),
      { headers: { "content-type": "application/json" } },
    );
  };

  const readSources = async () => {
    const response = await handleProxy(
      new Request("https://clone.example/Items/42/PlaybackInfo", {
        method: "POST",
      }),
      {},
      {},
      fetchImpl,
    );
    assert.equal(response.status, 200);
    return (await response.json()).MediaSources;
  };

  const first = await readSources();
  const second = await readSources();
  assert.equal(first.length, 3);
  assert.equal(second.length, 3);

  for (const field of ["Id", "MediaSourceId", "Path", "DirectStreamUrl"]) {
    assert.equal(new Set(first.map((source) => source[field])).size, first.length);
    assert.deepEqual(
      first.map((source) => source[field]),
      second.map((source) => source[field]),
    );
  }
  for (const source of first) {
    assert.equal(source.Id, source.MediaSourceId);
    const streamUrl = new URL(source.Path);
    assert.equal(streamUrl.searchParams.get("mediaSourceId"), source.Id);
    assert.match(source.DirectStreamUrl, new RegExp(`mediaSourceId=${source.Id}`));
  }
});

test("keeps same-name sources from distinct URLs and removes exact duplicates", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url) => {
      if (url.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "TEST-001", title: "Test Movie" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [
              {
                variant: "original",
                sourceUrl: "https://jdforrepam.com/video/source-a.mp4",
                sourceType: "video/mp4",
              },
              {
                variant: "original",
                sourceUrl: "https://fast-stream.jav.si/video/source-b.mp4",
                sourceType: "video/mp4",
              },
              {
                variant: "original",
                sourceUrl: "https://jdforrepam.com/video/source-a.mp4",
                sourceType: "video/mp4",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      assert.match(url, /\/api\/subtitle\?name=TEST-001/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  const sources = payload.MediaSources;
  assert.equal(sources.length, 2);
  assert.match(sources[0].Path, /source-a\.mp4/);
  assert.match(sources[1].Path, /source-b\.mp4/);
  assert.equal(new Set(sources.map((source) => source.Id)).size, 2);
  assert.equal(new Set(sources.map((source) => source.Name)).size, 2);
});

test("keeps late GetAV sources after early pseudo-HLS variants", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url) => {
      if (url.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "RCTD-740", title: "RCTD-740" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes(`${RESOLVER}/api/v/resolve`)) {
        return delayedResolverResponse();
      }
      assert.match(url, /\/api\/subtitle\?name=RCTD-740/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 2);
  assert.deepEqual(
    payload.MediaSources.map((source) => source.Name),
    ["getav_raw_4k", "getav_raw_1080p"],
  );
  for (const source of payload.MediaSources) {
    assert.match(source.Path, /fast-stream\.jav\.si/);
    assert.doesNotMatch(source.Path, /googleusercontent/);
  }
});

test("keeps extensionless Google Drive HLS and embedded TS .image HLS", async () => {
  const googlePlaylist = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:8",
    "#EXTINF:8,",
    "https://lh3.googleusercontent.com/d/segment-one=d",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const imagePlaylist = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:10",
    "#EXTINF:10,",
    "https://p16-ad-site-sign-sg.tiktokcdn.com/video/origin.image?token=abc",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const googleSource =
    `data:application/vnd.apple.mpegurl,${encodeURIComponent(googlePlaylist)}`;
  const imageSource =
    `data:application/vnd.apple.mpegurl,${encodeURIComponent(imagePlaylist)}`;
  const imageSegmentUrl =
    "https://p16-ad-site-sign-sg.tiktokcdn.com/video/origin.image?token=abc";
  const pngPrefix = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const imageSegmentBytes = new Uint8Array(512);
  imageSegmentBytes.set(pngPrefix, 0);
  imageSegmentBytes[70] = 0x47;
  imageSegmentBytes[258] = 0x47;
  imageSegmentBytes[446] = 0x47;

  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url) => {
      if (url.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "NQ7Mdg", title: "NQ7Mdg" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [
              {
                variant: "fcjav_original",
                sourceUrl: googleSource,
                sourceType: "application/vnd.apple.mpegurl",
              },
              {
                variant: "fcjav_reducing_mosaic",
                sourceUrl: googleSource,
                sourceType: "application/vnd.apple.mpegurl",
              },
              {
                variant: "javgg_original",
                sourceUrl: imageSource,
                sourceType: "application/vnd.apple.mpegurl",
              },
              {
                variant: "javgg_reducing_mosaic",
                sourceUrl: imageSource,
                sourceType: "application/vnd.apple.mpegurl",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === imageSegmentUrl) {
        return new Response(imageSegmentBytes, {
          status: 206,
          headers: {
            "content-range": "bytes 0-511/512",
            "content-type": "image/png",
          },
        });
      }
      assert.match(url, /\/api\/subtitle\?name=NQ7Mdg/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 4);
  assert.deepEqual(
    payload.MediaSources.map((source) => source.Name),
    ["fcjav_original", "压缩版 · 1", "javgg_original", "压缩版 · 2"],
  );
  assert.equal(
    new Set(payload.MediaSources.map((source) => source.Name)).size,
    payload.MediaSources.length,
  );
  for (const source of payload.MediaSources) {
    assert.equal(source.Container, "m3u8");
    assert.match(source.Path, /\/Videos\/42\/stream\.m3u8/);
  }
});

test("drops .image pseudo-HLS sources when the body is a real PNG", async () => {
  const imageSegmentUrl =
    "https://p19-ad-site-sign-sg.tiktokcdn.com/video/origin.image?token=abc";
  const imagePlaylist = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:10",
    "#EXTINF:10,",
    imageSegmentUrl,
    "#EXT-X-ENDLIST",
  ].join("\n");
  const imageSource =
    `data:application/vnd.apple.mpegurl,${encodeURIComponent(imagePlaylist)}`;
  const pngBytes = new Uint8Array(512);
  pngBytes.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ], 0);

  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url) => {
      if (url.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "RCTD-740", title: "RCTD-740" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "javgg_original",
              sourceUrl: imageSource,
              sourceType: "application/vnd.apple.mpegurl",
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === imageSegmentUrl) {
        return new Response(pngBytes, {
          status: 206,
          headers: {
            "content-range": "bytes 0-511/512",
            "content-type": "image/png",
          },
        });
      }
      assert.match(url, /\/api\/subtitle\?name=RCTD-740/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 0);
});

test("drops remote HLS sources whose segment body is real font data", async () => {
  const sourceUrl = "https://static.worldstatic.com/rctd-740/4k/index.txt";
  const segmentUrl = "https://static.worldstatic.com/rctd-740/4k/seg-0.woff2";
  const calls = [];
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "RCTD-740", title: "RCTD-740" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "getav_raw_4k",
              sourceUrl,
              sourceType: "application/vnd.apple.mpegurl",
              quality: 2160,
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === sourceUrl) {
        return new Response([
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          "#EXTINF:6,",
          "seg-0.woff2",
          "#EXT-X-ENDLIST",
        ].join("\n"), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (target === segmentUrl) {
        return new Response(Uint8Array.from([
          0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00,
        ]), {
          status: 206,
          headers: { "content-type": "font/woff2" },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=RCTD-740/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 0);
  assert.equal(calls.filter((target) => target === sourceUrl).length, 1);
  assert.equal(calls.includes(segmentUrl), true);
});

test("keeps four RCTD-740 playback sources including GG font-path HLS variants", async () => {
  const getav4kSource =
    "https://static.worldstatic.com/rctd-740/4k/index.txt?t=4k";
  const getav1080Source =
    "https://static.worldstatic.com/rctd-740/1080/index.txt?t=1080";
  const ggOriginalSegment =
    "https://dd2stliwt0bc.cloudvexario.xyz/hls/01/08392/seg-1-f3-v1-a1.woff2";
  const ggReducedSegment =
    "https://wt4pjiive9agjpl.startupmarketingaid.cfd/hls/01/08392/seg-1-f3-v1-a1.woff2";
  const inlinePlaylist = (segmentUrl) => [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:10",
    "#EXT-X-VERSION:3",
    "#EXT-X-MEDIA-SEQUENCE:1",
    "#EXTINF:10.010,",
    segmentUrl,
    "#EXT-X-ENDLIST",
  ].join("\n");
  const inlineSource = (playlist) =>
    `data:application/vnd.apple.mpegurl,${encodeURIComponent(playlist)}`;
  const segmentBytes = Uint8Array.from([0x47, 0x40, 0x11, 0x10, 0x00, 0x01]);
  const calls = [];

  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "RCTD-740", title: "RCTD-740" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [
              {
                variant: "getav_raw_4k",
                label: "原版 4K (GetAV)",
                sourceUrl: getav4kSource,
                sourceType: "application/vnd.apple.mpegurl",
                quality: 2160,
              },
              {
                variant: "getav_raw_1080p",
                label: "原版 1080P (GetAV)",
                sourceUrl: getav1080Source,
                sourceType: "application/vnd.apple.mpegurl",
                quality: 1080,
              },
              {
                variant: "javgg_original",
                label: "原版 (服务器GG)",
                sourceUrl: inlineSource(inlinePlaylist(ggOriginalSegment)),
                sourceType: "application/vnd.apple.mpegurl",
              },
              {
                variant: "javgg_reducing_mosaic",
                label: "去码版 (服务器GG)",
                sourceUrl: inlineSource(inlinePlaylist(ggReducedSegment)),
                sourceType: "application/vnd.apple.mpegurl",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === getav4kSource || target === getav1080Source) {
        const directory = target.includes("/4k/") ? "4k" : "1080";
        return new Response([
          "#EXTM3U",
          "#EXT-X-TARGETDURATION:10",
          "#EXT-X-VERSION:3",
          "#EXT-X-MEDIA-SEQUENCE:1",
          "#EXTINF:10.010,",
          `https://static.worldstatic.com/rctd-740/${directory}/seg-1.ts`,
          "#EXT-X-ENDLIST",
        ].join("\n"), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (
        /static\.worldstatic\.com\/rctd-740\/(?:4k|1080)\/seg-1\.ts/.test(target) ||
        target === ggOriginalSegment ||
        target === ggReducedSegment
      ) {
        return new Response(segmentBytes, {
          status: 206,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=RCTD-740/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("expires"), "0");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(payload.MediaSources.length, 4);
  assert.deepEqual(
    payload.MediaSources.map((source) => source.Name),
    [
      "原版 4K (GetAV)",
      "原版 1080P (GetAV)",
      "原版 (服务器GG)",
      "去码版 (服务器GG)",
    ],
  );
  assert.equal(
    payload.MediaSources.every((source) => source.Container === "m3u8"),
    true,
  );
  assert.equal(calls.includes(ggOriginalSegment), true);
  assert.equal(calls.includes(ggReducedSegment), true);
});

test("keeps AES-128 HLS sources whose encrypted segments use font paths", async () => {
  const sourceUrl = "https://static.worldstatic.com/rctd-740/4k/index.txt";
  const keyUrl = "https://static.worldstatic.com/rctd-740/4k/glyph.woff?e=1";
  const segmentUrl = "https://static.worldstatic.com/rctd-740/4k/seg-0.woff2?e=1";
  const keyBytes = Uint8Array.from({ length: 16 }, (_, index) => index);
  const iv = new Uint8Array(16);
  const segment = new Uint8Array(188);
  for (let index = 0; index < segment.length; index += 1) {
    segment[index] = (index * 37 + 11) & 0xff;
  }
  segment[0] = 0x47;
  segment[15] = 0;
  const encrypted = await encryptAes128Cbc(segment, keyBytes, iv);
  assert.ok(encrypted.length > 16);
  const calls = [];
  let segmentHeaders;
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url, init = {}) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "RCTD-740", title: "RCTD-740" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "getav_raw_4k",
              sourceUrl,
              sourceType: "application/vnd.apple.mpegurl",
              quality: 2160,
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === sourceUrl) {
        return new Response([
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          "#EXT-X-MEDIA-SEQUENCE:0",
          `#EXT-X-KEY:METHOD=AES-128,URI="glyph.woff?e=1",IV=0x${Buffer.from(iv).toString("hex")}`,
          "#EXTINF:6,",
          "seg-0.woff2?e=1",
          "#EXT-X-ENDLIST",
        ].join("\n"), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (target === keyUrl) {
        return new Response(keyBytes, {
          headers: { "content-type": "font/woff2" },
        });
      }
      if (target === segmentUrl) {
        segmentHeaders = init.headers;
        return new Response(encrypted, {
          status: 206,
          headers: { "content-type": "font/woff2" },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=RCTD-740/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 1);
  assert.equal(payload.MediaSources[0].Name, "RCTD-740");
  assert.equal(payload.MediaSources[0].Container, "m3u8");
  assert.equal(calls.includes(keyUrl), true);
  assert.equal(calls.includes(segmentUrl), true);
  assert.equal(new Headers(segmentHeaders).get("range"), "bytes=0-511");
});

test("drops AES-128 HLS sources when the decryption key is not 16 bytes", async () => {
  const sourceUrl = "https://static.worldstatic.com/rctd-740/1080/index.txt";
  const keyUrl = "https://static.worldstatic.com/rctd-740/1080/glyph.woff?e=1";
  const segmentUrl = "https://static.worldstatic.com/rctd-740/1080/seg-0.woff2?e=1";
  const calls = [];
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "RCTD-740", title: "RCTD-740" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "getav_raw_1080p",
              sourceUrl,
              sourceType: "application/vnd.apple.mpegurl",
              quality: 1080,
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === sourceUrl) {
        return new Response([
          "#EXTM3U",
          "#EXT-X-MEDIA-SEQUENCE:0",
          "#EXT-X-KEY:METHOD=AES-128,URI=\"glyph.woff?e=1\",IV=0x00000000000000000000000000000000",
          "#EXTINF:6,",
          "seg-0.woff2?e=1",
          "#EXT-X-ENDLIST",
        ].join("\n"), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (target === keyUrl) {
        return new Response(new Uint8Array(15), {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=RCTD-740/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 0);
  assert.equal(calls.includes(segmentUrl), false);
});

test("keeps a remote HLS source only after a playable segment probe", async () => {
  const masterUrl = "https://fast-stream.jav.si/live/master.m3u8";
  const childUrl = "https://fast-stream.jav.si/live/video/index.m3u8";
  const segmentUrl = "https://fast-stream.jav.si/live/video/segments/one.ts";
  const calls = [];
  let segmentHeaders;
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url, init = {}) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "TEST-001", title: "HLS Movie" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "original",
              sourceUrl: masterUrl,
              sourceType: "application/vnd.apple.mpegurl",
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === masterUrl) {
        return new Response([
          "#EXTM3U",
          "#EXT-X-STREAM-INF:BANDWIDTH=1280000",
          childUrl,
          "#EXT-X-ENDLIST",
        ].join("\n"), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (target === childUrl) {
        return new Response([
          "#EXTM3U",
          "#EXTINF:6,",
          segmentUrl,
          "#EXT-X-ENDLIST",
        ].join("\n"), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (target === segmentUrl) {
        segmentHeaders = init.headers;
        return new Response(new Uint8Array([0x47, 0x40, 0x11, 0x10, 0x00]), {
          status: 206,
          headers: { "content-type": "video/mp2t" },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=TEST-001/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 1);
  assert.equal(payload.MediaSources[0].Container, "m3u8");
  assert.deepEqual(
    calls.filter((target) => [masterUrl, childUrl, segmentUrl].includes(target)),
    [masterUrl, childUrl, segmentUrl],
  );
  assert.equal(new Headers(segmentHeaders).get("range"), "bytes=0-511");
});

test("probes ordinary remote MP4 resolver sources before advertising them", async () => {
  const sourceUrl = "https://fast-stream.jav.si/video/test.mp4";
  const calls = [];
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url, init = {}) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "TEST-001", title: "MP4 Movie" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "original",
              sourceUrl,
              sourceType: "video/mp4",
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === sourceUrl) {
        assert.equal(init.headers.get("range"), "bytes=0-511");
        return new Response(new Uint8Array([0, 0, 0, 32]), {
          status: 206,
          headers: {
            "content-range": "bytes 0-3/4",
            "content-type": "video/mp4",
          },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=TEST-001/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 1);
  assert.equal(calls.filter((target) => target === sourceUrl).length, 1);
});

test("drops resolver sources marked metadata_invalid_reference", async () => {
  const sourceUrl = "https://fast-stream.jav.si/video/invalid-reference.mp4";
  const calls = [];
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url, init = {}) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "TEST-001", title: "Invalid Reference" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "original",
              sourceUrl,
              sourceType: "video/mp4",
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === sourceUrl) {
        assert.equal(init.headers.get("range"), "bytes=0-511");
        return new Response(new Uint8Array([0, 0, 0, 32]), {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "x-media-failure": "metadata_invalid_reference",
          },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=TEST-001/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.MediaSources, []);
  assert.equal(calls.filter((target) => target === sourceUrl).length, 1);
});

test("keeps a valid root-relative resolver source while starting self-hosted supplements", async () => {
  const sourceUrl = `${UPSTREAM}/video/relative.mp4`;
  const calls = [];
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url, init = {}) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "SAN-449", title: "SAN-449 Test" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve?code=SAN-449`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "original",
              sourceUrl: "/video/relative.mp4",
              sourceType: "video/mp4",
              quality: 1080,
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === sourceUrl) {
        assert.equal(init.headers.get("range"), "bytes=0-511");
        return new Response(new Uint8Array([0, 0, 0, 32]), {
          status: 206,
          headers: {
            "content-range": "bytes 0-3/4",
            "content-type": "video/mp4",
          },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=SAN-449/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 1);
  assert.equal(calls.includes(sourceUrl), true);
  assert.equal(calls.some((target) => /javtiful\.com/.test(target)), true);
  assert.equal(calls.some((target) => /getav\.net|r\.jina\.ai/.test(target)), true);
});

test("merges one public resolver source with two Javtiful qualities", async () => {
  const publicUrl = "https://fast-stream.jav.si/san-449/public.mp4";
  const fullHdUrl = "https://fast-stream.jav.si/san-449/1080.mp4";
  const hdUrl = "https://fast-stream.jav.si/san-449/720.mp4";
  const detailUrl = "https://javtiful.com/zh/video/12345/SAN-449";
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    { SELF_HOSTED_MERGE_BUDGET_MS: 1000 },
    {},
    async (url, init = {}) => {
      const target = String(url);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "SAN-449", title: "SAN-449 Test" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve?code=SAN-449`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "original",
              sourceUrl: publicUrl,
              sourceType: "video/mp4",
              quality: 1080,
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === "https://javtiful.com/zh/search?q=SAN-449") {
        return new Response(
          `<a href="${detailUrl}">SAN-449 Test</a>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (target === detailUrl) {
        return new Response(
          `<script id="frontWatchConfig">${JSON.stringify({
            videoTitle: "SAN-449 Test",
            playerSources: [
              { src: fullHdUrl, type: "video/mp4", size: 1080 },
              { src: hdUrl, type: "video/mp4", size: 720 },
            ],
          })}</script>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (
        target === "https://r.jina.ai/https://getav.net/zh/videos/san-449" ||
        target === "https://getav.net/zh/videos/san-449"
      ) {
        return new Response("<html><title>Not found</title></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if ([publicUrl, fullHdUrl, hdUrl].includes(target)) {
        assert.equal(init.headers.get("range"), "bytes=0-511");
        return new Response(new Uint8Array([0, 0, 0, 32]), {
          status: 206,
          headers: {
            "content-range": "bytes 0-3/4",
            "content-type": "video/mp4",
          },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=SAN-449/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(
    payload.MediaSources.map((source) => source.Name),
    ["原版", "Javtiful 1080P", "Javtiful 720P"],
  );
});

test("merges public resolver sources with GetAV qualities when the CDN requires its Referer", async () => {
  const public4kUrl = "https://fast-stream.jav.si/rctd-740/public-4k.mp4";
  const public1080Url = "https://h1.gzankun.com/rctd-740/public-1080.mp4";
  const getav4kUrl = "https://static.worldstatic.com/rctd-740/4k/index.txt";
  const getav1080Url = "https://static.worldstatic.com/rctd-740/1080/index.txt";
  const pseudoPlaylist =
    "#EXTM3U\n#EXTINF:1,\nhttps://lh3.googleusercontent.com/not-a-video.jpg\n#EXT-X-ENDLIST\n";
  const pseudoSource =
    `data:application/vnd.apple.mpegurl,${encodeURIComponent(pseudoPlaylist)}`;
  const readerUrl = "https://r.jina.ai/https://getav.net/zh/videos/rctd-740";
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    { SELF_HOSTED_MERGE_BUDGET_MS: 1000 },
    {},
    async (url, init = {}) => {
      const target = String(url);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "RCTD-740", title: "RCTD-740 Test" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve?code=RCTD-740`)) {
        return new Response(
          JSON.stringify({
            variants: [
              {
                variant: "getav_raw_4k",
                label: "原版 4K (GetAV)",
                sourceUrl: public4kUrl,
                sourceType: "video/mp4",
                quality: 2160,
              },
              {
                variant: "getav_raw_1080p",
                label: "原版 1080P (GetAV)",
                sourceUrl: public1080Url,
                sourceType: "video/mp4",
                quality: 1080,
              },
              {
                variant: "javgg_original",
                sourceUrl: pseudoSource,
                sourceType: "application/vnd.apple.mpegurl",
              },
              {
                variant: "javgg_reducing_mosaic",
                sourceUrl: pseudoSource,
                sourceType: "application/vnd.apple.mpegurl",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === "https://javtiful.com/zh/search?q=RCTD-740") {
        return new Response("<html>No matching video</html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (target === readerUrl) {
        return new Response(
          `<html><title>RCTD-740 Test | GetAV</title>${JSON.stringify({
            videoSources: [
              { movieId: "RCTD-740", type: "raw_4k", url: getav4kUrl, quality: 2160 },
              { movieId: "RCTD-740", type: "raw_1080p", url: getav1080Url, quality: 1080 },
            ],
          })}</html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if ([public4kUrl, public1080Url].includes(target)) {
        assert.equal(init.headers.get("range"), "bytes=0-511");
        return new Response(new Uint8Array([0, 0, 0, 32]), {
          status: 206,
          headers: {
            "content-range": "bytes 0-3/4",
            "content-type": "video/mp4",
          },
        });
      }
      if (target === getav4kUrl || target === getav1080Url) {
        if (init.headers.get("referer") !== "https://getav.net/") {
          return new Response(null, { status: 403 });
        }
        return new Response([
          "#EXTM3U",
          "#EXT-X-TARGETDURATION:6",
          "#EXTINF:6,",
          "segment.ts",
          "#EXT-X-ENDLIST",
        ].join("\n"), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (/\/rctd-740\/\d+\/segment\.ts$/.test(target)) {
        if (init.headers.get("referer") !== "https://getav.net/") {
          return new Response(null, { status: 403 });
        }
        return new Response(new Uint8Array([0x47, 0x40, 0x11, 0x10, 0, 0]), {
          status: 206,
          headers: { "content-type": "video/mp2t" },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=RCTD-740/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  const sourceUrls = payload.MediaSources.map((source) =>
    new URL(source.Path).searchParams.get("source")
  );
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 4);
  assert.equal(new Set(sourceUrls).size, 4);
  assert.equal(sourceUrls.filter((source) => source === getav4kUrl).length, 1);
  assert.equal(sourceUrls.filter((source) => source === getav1080Url).length, 1);
});

test("keeps a public source when self-hosted supplement times out", async () => {
  const publicUrl = "https://fast-stream.jav.si/san-449/public.mp4";
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    { SELF_HOSTED_MERGE_BUDGET_MS: 40 },
    {},
    async (url, init = {}) => {
      const target = String(url);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "SAN-449", title: "SAN-449 Test" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve?code=SAN-449`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "original",
              sourceUrl: publicUrl,
              sourceType: "video/mp4",
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === "https://javtiful.com/zh/search?q=SAN-449") {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return new Response("<html>No matching video</html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (
        target === "https://r.jina.ai/https://getav.net/zh/videos/san-449" ||
        target === "https://getav.net/zh/videos/san-449"
      ) {
        return new Response("<html><title>Not found</title></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (target === publicUrl) {
        assert.equal(init.headers.get("range"), "bytes=0-511");
        return new Response(new Uint8Array([0, 0, 0, 32]), {
          status: 206,
          headers: {
            "content-range": "bytes 0-3/4",
            "content-type": "video/mp4",
          },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=SAN-449/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 1);
  assert.match(payload.MediaSources[0].Path, /public\.mp4/);
});

test("does not persist a thin GetAV result while supplement is pending", async () => {
  const db = createPlaybackD1();
  const env = {
    PLAYBACK_DB: db,
    SELF_HOSTED_MERGE_BUDGET_MS: 40,
  };
  const publicUrls = [
    "https://fast-stream.jav.si/rctd-740/public-4k.mp4",
    "https://fast-stream.jav.si/rctd-740/public-1080.mp4",
  ];
  const getavUrls = [
    "https://static.worldstatic.com/rctd-740/4k/index.txt",
    "https://static.worldstatic.com/rctd-740/1080/index.txt",
    "https://static.worldstatic.com/rctd-740/720/index.txt",
    "https://static.worldstatic.com/rctd-740/480/index.txt",
  ];
  const pageUrl = "https://getav.net/zh/videos/rctd-740";
  const readerUrl = `https://r.jina.ai/${pageUrl}`;
  let delayGetavPage = true;
  const getavHtml =
    `<html><title>RCTD-740 Test | GetAV</title>` +
    JSON.stringify({
      videoSources: [
        { movieId: "RCTD-740", type: "raw_4k", url: getavUrls[0], quality: 2160 },
        { movieId: "RCTD-740", type: "raw_1080p", url: getavUrls[1], quality: 1080 },
        { movieId: "RCTD-740", type: "raw_720p", url: getavUrls[2], quality: 720 },
        { movieId: "RCTD-740", type: "raw_480p", url: getavUrls[3], quality: 480 },
      ],
    }) +
    "</html>";

  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/v4/movies/42")) {
      return new Response(
        JSON.stringify({
          success: 1,
          data: { movie: { id: 42, number: "RCTD-740", title: "RCTD-740 Test" } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes(`${RESOLVER}/api/v/resolve?code=RCTD-740`)) {
      return new Response(
        JSON.stringify({
          variants: publicUrls.map((sourceUrl, index) => ({
            variant: index === 0 ? "original" : "backup",
            sourceUrl,
            sourceType: "video/mp4",
          })),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (target === "https://javtiful.com/zh/search?q=RCTD-740") {
      return new Response("<html>No matching video</html>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (target === pageUrl || target === readerUrl) {
      if (delayGetavPage) {
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
      return new Response(getavHtml, {
        headers: { "content-type": "text/html" },
      });
    }
    if (publicUrls.includes(target)) {
      assert.equal(init.headers.get("range"), "bytes=0-511");
      return new Response(new Uint8Array([0, 0, 0, 32]), {
        status: 206,
        headers: {
          "content-range": "bytes 0-3/4",
          "content-type": "video/mp4",
        },
      });
    }
    if (getavUrls.includes(target)) {
      return new Response([
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:6",
        "#EXTINF:6,",
        "segment.ts",
        "#EXT-X-ENDLIST",
      ].join("\n"), {
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    if (/\/rctd-740\/\d+\/segment\.ts$/.test(target)) {
      return new Response(new Uint8Array([0x47, 0x40, 0x11, 0x10, 0, 0]), {
        status: 206,
        headers: { "content-type": "video/mp2t" },
      });
    }
    assert.match(target, /\/api\/subtitle\?name=RCTD-740/);
    return new Response(
      JSON.stringify({ code: 0, data: [] }),
      { headers: { "content-type": "application/json" } },
    );
  };

  const firstResponse = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    env,
    {},
    fetchImpl,
  );
  const firstPayload = await firstResponse.json();
  assert.equal(firstPayload.MediaSources.length, 2);
  assert.equal(
    [...db.rows.keys()].some((key) =>
      key.startsWith("video-persist-v1\u0000")
    ),
    false,
  );

  delayGetavPage = false;
  await new Promise((resolve) => setTimeout(resolve, 220));
  resetEmbyCachesForTests();

  const secondResponse = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    env,
    {},
    fetchImpl,
  );
  const secondPayload = await secondResponse.json();
  assert.equal(secondPayload.MediaSources.length, 6);
  assert.deepEqual(
    secondPayload.MediaSources.map((source) =>
      new URL(source.Path).searchParams.get("source")
    ),
    [...publicUrls, ...getavUrls],
  );
});

test("does not persist a thin result after the supplement finishes below target", async () => {
  const db = createPlaybackD1();
  const env = {
    PLAYBACK_DB: db,
    SELF_HOSTED_MERGE_BUDGET_MS: 60,
  };
  const publicUrls = [
    "https://fast-stream.jav.si/rctd-740/public-4k.mp4",
    "https://fast-stream.jav.si/rctd-740/public-1080.mp4",
  ];
  const pageUrl = "https://getav.net/zh/videos/rctd-740";
  const readerUrl = `https://r.jina.ai/${pageUrl}`;

  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    env,
    {},
    async (url, init = {}) => {
      const target = String(url);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: {
              movie: {
                id: 42,
                number: "RCTD-740",
                title: "RCTD-740 Test",
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve?code=RCTD-740`)) {
        return new Response(
          JSON.stringify({
            variants: publicUrls.map((sourceUrl, index) => ({
              variant: index === 0 ? "original" : "backup",
              sourceUrl,
              sourceType: "video/mp4",
            })),
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === "https://javtiful.com/zh/search?q=RCTD-740") {
        return new Response("<html>No matching video</html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (target === pageUrl || target === readerUrl) {
        return new Response("<html><title>Not found</title></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (publicUrls.includes(target)) {
        assert.equal(init.headers.get("range"), "bytes=0-511");
        return new Response(new Uint8Array([0, 0, 0, 32]), {
          status: 206,
          headers: {
            "content-range": "bytes 0-3/4",
            "content-type": "video/mp4",
          },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=RCTD-740/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(payload.MediaSources.length, 2);
  assert.equal(
    [...db.rows.keys()].some((key) =>
      key.startsWith("video-persist-v1\u0000")
    ),
    false,
  );
});

test("drops pseudo-HLS supplements and keeps validated self-hosted lines", async () => {
  const publicUrl = "https://fast-stream.jav.si/rctd-740/public.mp4";
  const javtifulUrl = "https://fast-stream.jav.si/rctd-740/720.mp4";
  const javtifulDetail = "https://javtiful.com/zh/video/12345/RCTD-740";
  const getav4kUrl = "https://static.worldstatic.com/rctd-740/4k/index.txt";
  const getavPseudoUrl = "https://static.worldstatic.com/rctd-740/1080/index.txt";
  const pseudoImageUrl = "https://static.worldstatic.com/rctd-740/1080/cover.jpg";
  const readerUrl = "https://r.jina.ai/https://getav.net/zh/videos/rctd-740";
  const calls = [];
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    { SELF_HOSTED_MERGE_BUDGET_MS: 1000 },
    {},
    async (url, init = {}) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "RCTD-740", title: "RCTD-740 Test" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve?code=RCTD-740`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "original",
              sourceUrl: publicUrl,
              sourceType: "video/mp4",
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === "https://javtiful.com/zh/search?q=RCTD-740") {
        return new Response(
          `<a href="${javtifulDetail}">RCTD-740 Test</a>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (target === javtifulDetail) {
        return new Response(
          `<script id="frontWatchConfig">${JSON.stringify({
            videoTitle: "RCTD-740 Test",
            playerSources: [
              { src: javtifulUrl, type: "video/mp4", size: 720 },
            ],
          })}</script>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (target === readerUrl) {
        return new Response(
          `<html><title>RCTD-740 Test | GetAV</title>${JSON.stringify({
            videoSources: [
              { movieId: "RCTD-740", type: "raw_4k", url: getav4kUrl, quality: 2160 },
              {
                movieId: "RCTD-740",
                type: "raw_1080p",
                url: getavPseudoUrl,
                quality: 1080,
              },
            ],
          })}</html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if ([publicUrl, javtifulUrl].includes(target)) {
        assert.equal(init.headers.get("range"), "bytes=0-511");
        return new Response(new Uint8Array([0, 0, 0, 32]), {
          status: 206,
          headers: {
            "content-range": "bytes 0-3/4",
            "content-type": "video/mp4",
          },
        });
      }
      if (target === getav4kUrl) {
        return new Response([
          "#EXTM3U",
          "#EXT-X-TARGETDURATION:6",
          "#EXTINF:6,",
          "segment.ts",
          "#EXT-X-ENDLIST",
        ].join("\n"), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (target === getavPseudoUrl) {
        return new Response([
          "#EXTM3U",
          "#EXT-X-TARGETDURATION:6",
          "#EXTINF:6,",
          pseudoImageUrl,
          "#EXT-X-ENDLIST",
        ].join("\n"), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (target === "https://static.worldstatic.com/rctd-740/4k/segment.ts") {
        return new Response(new Uint8Array([0x47, 0x40, 0x11, 0x10, 0, 0]), {
          status: 206,
          headers: { "content-type": "video/mp2t" },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=RCTD-740/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(
    payload.MediaSources.map((source) => source.Name).sort(),
    ["原版", "Javtiful 720P", "原版 4K (GetAV)"].sort(),
  );
  assert.equal(calls.includes(pseudoImageUrl), false);
});

test("deduplicates exact cross-source URLs but keeps distinct URLs", async () => {
  const publicUrl = "https://h1.gzankun.com/rctd-740/public.mp4";
  const sharedUrl = "https://fast-stream.jav.si/rctd-740/1080.mp4";
  const javtifulDetail = "https://javtiful.com/zh/video/12345/RCTD-740";
  const getavUrl = "https://static.worldstatic.com/rctd-740/1080/index.txt";
  const readerUrl = "https://r.jina.ai/https://getav.net/zh/videos/rctd-740";
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    { SELF_HOSTED_MERGE_BUDGET_MS: 1000 },
    {},
    async (url, init = {}) => {
      const target = String(url);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "RCTD-740", title: "RCTD-740 Test" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve?code=RCTD-740`)) {
        return new Response(
          JSON.stringify({
            variants: [
              {
                variant: "original",
                sourceUrl: publicUrl,
                sourceType: "video/mp4",
              },
              {
                variant: "javtiful_1080",
                label: "Javtiful 1080P",
                sourceUrl: sharedUrl,
                sourceType: "video/mp4",
                quality: 1080,
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === "https://javtiful.com/zh/search?q=RCTD-740") {
        return new Response(
          `<a href="${javtifulDetail}">RCTD-740 Test</a>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (target === javtifulDetail) {
        return new Response(
          `<script id="frontWatchConfig">${JSON.stringify({
            videoTitle: "RCTD-740 Test",
            playerSources: [
              { src: sharedUrl, type: "video/mp4", size: 1080 },
            ],
          })}</script>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (target === readerUrl) {
        return new Response(
          `<html><title>RCTD-740 Test | GetAV</title>${JSON.stringify({
            videoSources: [
              { movieId: "RCTD-740", type: "raw_1080p", url: getavUrl, quality: 1080 },
            ],
          })}</html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if ([publicUrl, sharedUrl].includes(target)) {
        assert.equal(init.headers.get("range"), "bytes=0-511");
        return new Response(new Uint8Array([0, 0, 0, 32]), {
          status: 206,
          headers: {
            "content-range": "bytes 0-3/4",
            "content-type": "video/mp4",
          },
        });
      }
      if (target === getavUrl) {
        return new Response([
          "#EXTM3U",
          "#EXT-X-TARGETDURATION:6",
          "#EXTINF:6,",
          "segment.ts",
          "#EXT-X-ENDLIST",
        ].join("\n"), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (target === "https://static.worldstatic.com/rctd-740/1080/segment.ts") {
        return new Response(new Uint8Array([0x47, 0x40, 0x11, 0x10, 0, 0]), {
          status: 206,
          headers: { "content-type": "video/mp2t" },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=RCTD-740/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  const sourceUrls = payload.MediaSources.map((source) =>
    new URL(source.Path).searchParams.get("source")
  );
  assert.equal(response.status, 200);
  assert.equal(payload.MediaSources.length, 3);
  assert.equal(sourceUrls.filter((source) => source === sharedUrl).length, 1);
  assert.equal(sourceUrls.includes(publicUrl), true);
  assert.equal(sourceUrls.includes(getavUrl), true);
});

test("loads Javtiful MP4 qualities in order and probes each stream", async () => {
  const detailUrl = "https://javtiful.com/zh/video/12345/SAN-449";
  const fullHdUrl = "https://fast-stream.jav.si/san-449/1080.mp4";
  const hdUrl = "https://fast-stream.jav.si/san-449/720.mp4";
  const calls = [];
  const rangeHeaders = new Map();
  const javtifulWatch = JSON.stringify({
    videoTitle: "SAN-449 Test",
    playerSources: [
      { src: fullHdUrl, type: "video/mp4", size: 1080 },
      { src: hdUrl, type: "video/mp4", size: 720 },
    ],
  });

  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url, init = {}) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "SAN-449", title: "SAN-449 Test" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve?code=SAN-449`)) {
        return new Response(
          JSON.stringify({ variants: [] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === "https://javtiful.com/zh/search?q=SAN-449") {
        return new Response(
          `<a href="${detailUrl}">SAN-449 Test</a>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (target === detailUrl) {
        return new Response(
          `<script id="frontWatchConfig">${javtifulWatch}</script>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (
        target ===
          "https://r.jina.ai/https://getav.net/zh/videos/san-449" ||
        target === "https://getav.net/zh/videos/san-449"
      ) {
        return new Response("<html><title>Not found</title></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (target === fullHdUrl || target === hdUrl) {
        rangeHeaders.set(target, init.headers.get("range"));
        return new Response(new Uint8Array([0, 0, 0, 32]), {
          status: 206,
          headers: {
            "content-range": "bytes 0-3/4",
            "content-type": "video/mp4",
          },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=SAN-449/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(
    payload.MediaSources.map((source) => source.Name),
    ["Javtiful 1080P", "Javtiful 720P"],
  );
  assert.deepEqual(
    payload.MediaSources.map((source) =>
      source.MediaStreams.find((stream) => stream.Type === "Video").Height
    ),
    [1080, 720],
  );
  assert.equal(calls.filter((target) => target === fullHdUrl).length, 1);
  assert.equal(calls.filter((target) => target === hdUrl).length, 1);
  assert.equal(rangeHeaders.get(fullHdUrl), "bytes=0-511");
  assert.equal(rangeHeaders.get(hdUrl), "bytes=0-511");
});

test("loads all GetAV qualities through parallel page requests", async () => {
  const calls = [];
  const sourceQualities = [
    ["raw_4k", 2160],
    ["raw_1080p", 1080],
    ["raw_720p", 720],
    ["raw_480p", 480],
  ];
  const videoSources = sourceQualities.map(([type, quality]) => ({
    movieId: "RCTD-740",
    type,
    url: `https://static.worldstatic.com/rctd-740/${quality}/index.txt`,
    quality,
  }));
  const pageUrl = "https://getav.net/zh/videos/rctd-740";
  const readerUrl = `https://r.jina.ai/${pageUrl}`;

  const response = await handleProxy(
    new Request("https://clone.example/Items/42/PlaybackInfo", {
      method: "POST",
    }),
    {},
    {},
    async (url, init = {}) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "RCTD-740", title: "RCTD-740 Test" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve?code=RCTD-740`)) {
        return new Response(
          JSON.stringify({ variants: [] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target === "https://javtiful.com/zh/search?q=RCTD-740") {
        return new Response("<html>No matching video</html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (target === readerUrl) {
        assert.equal(init.headers.get("x-respond-with"), "html");
        return new Response(
          `<html><title>RCTD-740 Test | GetAV</title>` +
          `${JSON.stringify({ videoSources })}</html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (target === pageUrl) {
        return new Response(
          `<html><title>RCTD-740 Test | GetAV</title>` +
          `${JSON.stringify({ videoSources })}</html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (/\/rctd-740\/\d+\/index\.txt$/.test(target)) {
        return new Response([
          "#EXTM3U",
          "#EXT-X-TARGETDURATION:6",
          "#EXTINF:6,",
          "segment.ts",
          "#EXT-X-ENDLIST",
        ].join("\n"), {
          headers: { "content-type": "application/vnd.apple.mpegurl" },
        });
      }
      if (/\/rctd-740\/\d+\/segment\.ts$/.test(target)) {
        return new Response(new Uint8Array([0x47, 0x40, 0x11, 0x10, 0, 0]), {
          status: 206,
          headers: { "content-type": "video/mp2t" },
        });
      }
      assert.match(target, /\/api\/subtitle\?name=RCTD-740/);
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(calls.includes(readerUrl), true);
  assert.equal(calls.includes(pageUrl), true);
  assert.deepEqual(
    payload.MediaSources.map((source) => source.Name),
    [
      "原版 4K (GetAV)",
      "原版 1080P (GetAV)",
      "原版 720P (GetAV)",
      "原版 480P (GetAV)",
    ],
  );
  assert.deepEqual(
    payload.MediaSources.map((source) =>
      source.MediaStreams.find((stream) => stream.Type === "Video").Height
    ),
    [2160, 1080, 720, 480],
  );
});

test("public resolver proxy waits for variants after a 1.8 second gap", async () => {
  let resolverCalls = 0;
  const response = await handleProxy(
    new Request("https://clone.example/api/v/resolve?code=RCTD-740&lang=zh"),
    { JAVSTRM_ORIGIN: UPSTREAM },
    {},
    async (url) => {
      assert.match(url, /\/api\/(?:v\/)?resolve\?code=RCTD-740/);
      resolverCalls += 1;
      return delayedResolverResponse();
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(resolverCalls, 2);
  assert.equal(payload.variants.length, 6);
  assert.deepEqual(
    payload.variants
      .map((variant) => variant.variant)
      .filter((variant) => variant.startsWith("getav_")),
    ["getav_raw_4k", "getav_raw_1080p"],
  );
});

test("public resolver keeps waiting when the first result only has pseudo-HLS sources", async () => {
  const fakePlaylist = [
    "#EXTM3U",
    "#EXTINF:1,",
    "https://lh3.googleusercontent.com/not-a-video.jpg",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const pseudoSource = `data:application/vnd.apple.mpegurl,${encodeURIComponent(fakePlaylist)}`;
  const earlyVariants = [
    { variant: "fcjav_original", sourceUrl: pseudoSource, sourceType: "application/vnd.apple.mpegurl" },
    { variant: "fcjav_reducing_mosaic", sourceUrl: pseudoSource, sourceType: "application/vnd.apple.mpegurl" },
    { variant: "javgg_original", sourceUrl: pseudoSource, sourceType: "application/vnd.apple.mpegurl" },
    { variant: "javgg_reducing_mosaic", sourceUrl: pseudoSource, sourceType: "application/vnd.apple.mpegurl" },
  ];
  const lateVariants = [
    { variant: "getav_raw_4k", sourceUrl: "https://static.worldstatic.com/rctd-740/4k/index.txt", sourceType: "application/vnd.apple.mpegurl", quality: 2160 },
    { variant: "getav_raw_1080p", sourceUrl: "https://static.worldstatic.com/rctd-740/1080/index.txt", sourceType: "application/vnd.apple.mpegurl", quality: 1080 },
  ];
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const response = await handleProxy(
    new Request("https://clone.example/api/v/resolve?code=RCTD-740&lang=zh"),
    { JAVSTRM_ORIGIN: UPSTREAM },
    {},
    async (url) => {
      const target = String(url);
      if (target.includes("/api/v/resolve")) {
        fallbackCalls += 1;
        // 回退端点比旧的 4.5 秒合并窗口慢，但在放宽后的窗口内完成。
        await new Promise((resolve) => setTimeout(resolve, 6000));
        return new Response(
          JSON.stringify({ variants: [...earlyVariants, ...lateVariants] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      assert.match(target, /\/api\/resolve\?code=RCTD-740/);
      primaryCalls += 1;
      return new Response(
        JSON.stringify({ variants: earlyVariants }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(payload.variants.length, 6);
  assert.deepEqual(
    payload.variants
      .map((variant) => variant.variant)
      .filter((variant) => variant.startsWith("getav_")),
    ["getav_raw_4k", "getav_raw_1080p"],
  );
});

test("public resolver keeps same-name variants that come from distinct source URLs", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/api/v/resolve?code=RCTD-740&lang=zh"),
    { JAVSTRM_ORIGIN: UPSTREAM },
    {},
    async (url) => {
      const target = String(url);
      if (target.includes("/api/v/resolve")) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "original",
              sourceUrl: "https://cdn-b.example/stream/index.m3u8",
              sourceType: "application/vnd.apple.mpegurl",
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          variants: [{
            variant: "original",
            sourceUrl: "https://cdn-a.example/stream/index.m3u8",
            sourceType: "application/vnd.apple.mpegurl",
          }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.variants.length, 2);
  assert.deepEqual(
    payload.variants.map((variant) => variant.sourceUrl).sort(),
    [
      "https://cdn-a.example/stream/index.m3u8",
      "https://cdn-b.example/stream/index.m3u8",
    ],
  );
});

test("embeds a directly streamable media source in movie details", async () => {
  const response = await handleProxy(
    new Request("https://clone.example/Items/42?api_key=bbjavdb-guest"),
    {},
    {},
    async (url) => {
      if (url.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: {
              movie: {
                id: 42,
                number: "TEST-001",
                title: "Test Movie",
                can_play: true,
                has_cnsub: true,
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "original",
              sourceUrl: "https://fast-stream.jav.si/video/test.mp4",
              sourceType: "video/mp4",
              quality: 1080,
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      assert.match(url, /\/api\/subtitle\?name=TEST-001/);
      return new Response(
        JSON.stringify({
          code: 0,
          data: [{
            cid: "subtitle-1",
            url: "https://subtitle.example/test.srt",
            ext: "srt",
          }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );

  const payload = await response.json();
  assert.equal(payload.PlayAccess, "Full");
  assert.equal(payload.MediaSourceCount, 1);
  assert.match(payload.Path, /\/Videos\/42\/stream\.mp4/);
  assert.equal(payload.MediaSources[0].MediaStreams[1].Type, "Audio");
  assert.equal(payload.MediaSources[0].DefaultSubtitleStreamIndex, 2);
});

test("returns a stable detail ETag and honors conditional detail requests", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/v4/movies/42")) {
      return new Response(
        JSON.stringify({
          success: 1,
          data: {
            movie: {
              id: 42,
              number: "TEST-001",
              title: "Test Movie",
              can_play: true,
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes(`${RESOLVER}/api/v/resolve`)) {
      return new Response(
        JSON.stringify({
          variants: [{
            variant: "original",
            sourceUrl: "https://fast-stream.jav.si/video/test.mp4",
            sourceType: "video/mp4",
          }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    assert.match(url, /\/api\/subtitle\?name=TEST-001/);
    return new Response(
      JSON.stringify({ code: 0, data: [] }),
      { headers: { "content-type": "application/json" } },
    );
  };

  const first = await handleProxy(
    new Request("https://clone.example/Items/42?api_key=bbjavdb-guest"),
    {},
    {},
    fetchImpl,
  );
  const firstPayload = await first.json();
  const etag = first.headers.get("etag");
  assert.ok(etag);
  assert.equal(firstPayload.Id, "42");
  assert.equal(firstPayload.MediaSources[0].Id, firstPayload.MediaSources[0].MediaSourceId);
  assert.equal(firstPayload.UserData.PlaybackPositionTicks, 0);

  const unchanged = await handleProxy(
    new Request("https://clone.example/Items/42?api_key=bbjavdb-guest", {
      headers: { "if-none-match": etag },
    }),
    {},
    {},
    fetchImpl,
  );
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get("etag"), etag);

  resetEmbyCachesForTests();
  const changed = await handleProxy(
    new Request("https://clone.example/Items/42?api_key=bbjavdb-guest", {
      headers: { "if-none-match": etag },
    }),
    {},
    {},
    async (url, init) => {
      if (url.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: {
              movie: {
                id: 42,
                number: "TEST-001",
                title: "Test Movie Changed",
                can_play: true,
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return fetchImpl(url, init);
    },
  );
  assert.equal(changed.status, 200);
  const changedPayload = await changed.json();
  assert.equal(changedPayload.Name, "TEST-001 Test Movie Changed");
  assert.notEqual(changed.headers.get("etag"), etag);
});

test("serves inline HLS variants through a short Emby stream URL", async () => {
  const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://media.example/segment.ts\n#EXT-X-ENDLIST\n";
  const inlineSource = `data:application/vnd.apple.mpegurl,${encodeURIComponent(playlist)}`;
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("/v4/movies/42")) {
      return new Response(
        JSON.stringify({
          success: 1,
          data: { movie: { id: 42, number: "TEST-001", title: "HLS Movie" } },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes(`${RESOLVER}/api/v/resolve`)) {
      return new Response(
        JSON.stringify({
          variants: [{
            variant: "javgg_original",
            sourceUrl: inlineSource,
            sourceType: "application/vnd.apple.mpegurl",
          }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes("/api/subtitle")) {
      return new Response(
        JSON.stringify({ code: 0, data: [] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const playback = await handleProxy(
    new Request("https://clone.example/emby/Items/42/PlaybackInfo?api_key=bbjavdb-guest", {
      method: "POST",
    }),
    {},
    {},
    fetchImpl,
  );
  const mediaSource = (await playback.json()).MediaSources[0];
  assert.equal(mediaSource.Container, "m3u8");
  assert.match(mediaSource.DirectStreamUrl, /\/emby\/Videos\/42\/stream\.m3u8/);
  assert.doesNotMatch(mediaSource.DirectStreamUrl, /source=/);
  assert.ok(mediaSource.DirectStreamUrl.length < 200);

  const stream = await handleProxy(
    new Request(new URL(mediaSource.DirectStreamUrl, "https://clone.example")),
    {},
    {},
    fetchImpl,
  );
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type"), /application\/vnd\.apple\.mpegurl/);
  const rewritten = await stream.text();
  assert.match(
    rewritten,
    /\/emby-media\/\?url=https%3A%2F%2Fmedia\.example%2Fsegment\.ts(?:&|&amp;|$)/,
  );
  assert.doesNotMatch(rewritten, /^https:\/\/media\.example\/segment\.ts/m);
});

test("rewrites master and child HLS manifests through the local media proxy", async () => {
  const masterUrl = "https://fast-stream.jav.si/live/master.m3u8";
  const videoChildUrl = "https://fast-stream.jav.si/live/video/index.m3u8";
  const audioChildUrl = "https://fast-stream.jav.si/live/audio/index.m3u8";
  const keyUrl = "https://fast-stream.jav.si/live/video/keys/key.key";
  const initUrl = "https://fast-stream.jav.si/live/video/init.mp4";
  const segmentUrl = "https://fast-stream.jav.si/live/video/segments/one.m4s";
  const master = [
    "#EXTM3U",
    "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"English\",URI=\"audio/index.m3u8\"",
    "#EXT-X-STREAM-INF:BANDWIDTH=1280000,AUDIO=\"audio\"",
    "video/index.m3u8",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const child = [
    "#EXTM3U",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"keys/key.key\"",
    "#EXT-X-MAP:URI=\"init.mp4\"",
    "#EXTINF:6,",
    "segments/one.m4s",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const calls = [];
  let childRequestHeaders;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push(target);
    if (target === masterUrl) {
      return new Response(master, {
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    if (target === videoChildUrl) {
      childRequestHeaders = init.headers;
      return new Response(child, {
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const masterResponse = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(masterUrl)}`,
    ),
    {},
    {},
    fetchImpl,
  );
  assert.equal(masterResponse.status, 200);
  const rewrittenMaster = await masterResponse.text();
  for (const target of [videoChildUrl, audioChildUrl]) {
    assert.ok(rewrittenMaster.includes(encodeURIComponent(target)), target);
  }

  const childLine = rewrittenMaster
    .split("\n")
    .find((line) => line.includes(encodeURIComponent(videoChildUrl)));
  assert.ok(childLine);
  assert.match(childLine, /[?&]kind=manifest(?:&|$)/);
  const childResponse = await handleProxy(
    new Request(childLine, { headers: { range: "bytes=0-1023" } }),
    {},
    {},
    fetchImpl,
  );
  assert.equal(childResponse.status, 200);
  assert.equal(new Headers(childRequestHeaders).get("range"), null);
  const rewrittenChild = await childResponse.text();
  for (const target of [keyUrl, initUrl, segmentUrl]) {
    assert.ok(rewrittenChild.includes(encodeURIComponent(target)), target);
  }
  assert.deepEqual(calls, [masterUrl, videoChildUrl]);
});

test("rewrites a 206 HLS manifest for an explicit manifest request", async () => {
  const manifestUrl = "https://static.worldstatic.com/rctd-740/4k/index.txt";
  const keyUrl = "https://static.worldstatic.com/rctd-740/4k/glyph.woff?e=1";
  const segmentUrl = "https://static.worldstatic.com/rctd-740/4k/seg-0.woff2?e=1";
  const manifest = [
    "#EXTM3U",
    "#EXT-X-KEY:METHOD=AES-128,URI=\"glyph.woff?e=1\"",
    "#EXTINF:6,",
    "seg-0.woff2?e=1",
    "#EXT-X-ENDLIST",
  ].join("\n");
  let requestHeaders;
  const response = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(manifestUrl)}&hls=1&kind=manifest`,
      { headers: { range: "bytes=0-1023" } },
    ),
    {},
    {},
    async (_url, init = {}) => {
      requestHeaders = init.headers;
      return new Response(manifest, {
        status: 206,
        headers: {
          "content-range": `bytes 0-${manifest.length - 1}/${manifest.length}`,
          "content-type": "application/vnd.apple.mpegurl",
        },
      });
    },
  );

  assert.equal(requestHeaders.get("range"), null);
  assert.equal(requestHeaders.get("if-range"), null);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), null);
  const rewritten = await response.text();
  assert.ok(rewritten.includes(encodeURIComponent(keyUrl)));
  assert.ok(rewritten.includes(encodeURIComponent(segmentUrl)));
});

test("does not forward Range when a direct HLS stream is a manifest", async () => {
  const sourceUrl = "https://static.worldstatic.com/rctd-740/4k/index.txt";
  const segmentUrl = "https://static.worldstatic.com/rctd-740/4k/seg-0.woff2?e=1";
  const manifest = [
    "#EXTM3U",
    "#EXTINF:6,",
    "seg-0.woff2?e=1",
    "#EXT-X-ENDLIST",
  ].join("\n");
  let requestHeaders;
  const response = await handleProxy(
    new Request(
      `https://clone.example/emby/Videos/42/stream.m3u8?api_key=bbjavdb-guest&source=${encodeURIComponent(sourceUrl)}&sourceType=application%2Fvnd.apple.mpegurl`,
      { headers: { range: "bytes=0-1023" } },
    ),
    {},
    {},
    async (_url, init = {}) => {
      requestHeaders = init.headers;
      return new Response(manifest, {
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    },
  );

  assert.equal(requestHeaders.get("range"), null);
  assert.equal(response.status, 200);
  const rewritten = await response.text();
  assert.ok(rewritten.includes(encodeURIComponent(segmentUrl)));
});

test("marks key and encrypted segment proxy URLs and forces safe content types", async () => {
  const manifestUrl = "https://static.worldstatic.com/rctd-740/4k/index.txt";
  const keyUrl = "https://static.worldstatic.com/rctd-740/4k/glyph.woff?e=1";
  const segmentUrl = "https://static.worldstatic.com/rctd-740/4k/seg-0.woff2?e=1";
  const keyBytes = Uint8Array.from({ length: 16 }, (_, index) => 0x10 + index);
  let segmentRequestHeaders;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target === manifestUrl) {
      return new Response([
        "#EXTM3U",
        "#EXT-X-KEY:METHOD=AES-128,URI=\"glyph.woff?e=1\",IV=0x00000000000000000000000000000000",
        "#EXTINF:6,",
        "seg-0.woff2?e=1",
        "#EXT-X-ENDLIST",
      ].join("\n"), {
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    if (target === keyUrl) {
      return new Response(keyBytes, {
        headers: { "content-type": "font/woff2" },
      });
    }
    if (target === segmentUrl) {
      segmentRequestHeaders = init.headers;
      return new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
        status: 206,
        headers: {
          "content-range": "bytes 0-3/4",
          "content-type": "font/woff2",
          etag: "segment-etag",
        },
      });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const manifestResponse = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(manifestUrl)}`,
    ),
    {},
    {},
    fetchImpl,
  );
  const rewritten = await manifestResponse.text();
  const keyLine = rewritten
    .split("\n")
    .find((line) => line.startsWith("#EXT-X-KEY:"));
  const keyProxyUrl = /URI="([^"]+)"/.exec(keyLine)?.[1] || "";
  const segmentProxyUrl = rewritten
    .split("\n")
    .find((line) => line.includes(encodeURIComponent(segmentUrl))) || "";
  assert.match(keyProxyUrl, /[?&]hls=1(?:&|$)/);
  assert.match(keyProxyUrl, /[?&]kind=key(?:&|$)/);
  assert.match(segmentProxyUrl, /[?&]hls=1(?:&|$)/);
  assert.match(segmentProxyUrl, /[?&]kind=segment(?:&|$)/);
  assert.match(segmentProxyUrl, /[?&]encrypted=1(?:&|$)/);

  const keyResponse = await handleProxy(
    new Request(keyProxyUrl),
    {},
    {},
    fetchImpl,
  );
  assert.equal(keyResponse.status, 200);
  assert.equal(keyResponse.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(await keyResponse.arrayBuffer()), keyBytes);

  const segmentResponse = await handleProxy(
    new Request(segmentProxyUrl, {
      headers: { range: "bytes=0-3" },
    }),
    {},
    {},
    fetchImpl,
  );
  assert.equal(segmentResponse.status, 206);
  assert.equal(segmentResponse.headers.get("content-type"), "application/octet-stream");
  assert.equal(segmentResponse.headers.get("content-range"), "bytes 0-3/4");
  assert.equal(segmentResponse.headers.get("etag"), "segment-etag");
  assert.equal(new Headers(segmentRequestHeaders).get("range"), "bytes=0-3");
});

test("forwards Range and conditional headers through the media proxy", async () => {
  const sourceUrl = "https://fast-stream.jav.si/video/test.mp4";
  const bytes = new Uint8Array([0, 1, 2, 3]);
  let requestHeaders;
  const response = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}`,
      {
        headers: {
          "if-modified-since": "Wed, 21 Oct 2015 07:28:00 GMT",
          "if-none-match": "etag-test",
          "if-range": "etag-test",
          range: "bytes=0-3",
        },
      },
    ),
    {},
    {},
    async (_url, init = {}) => {
      requestHeaders = init.headers;
      return new Response(bytes, {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": "4",
          "content-range": "bytes 0-3/4",
          "content-type": "video/mp4",
          etag: "etag-test",
          "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
        },
      });
    },
  );

  assert.equal(requestHeaders.get("range"), "bytes=0-3");
  assert.equal(requestHeaders.get("if-range"), "etag-test");
  assert.equal(requestHeaders.get("if-none-match"), "etag-test");
  assert.equal(
    requestHeaders.get("if-modified-since"),
    "Wed, 21 Oct 2015 07:28:00 GMT",
  );
  assert.equal(requestHeaders.get("origin"), UPSTREAM);
  assert.equal(requestHeaders.get("referer"), `${UPSTREAM}/`);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-3/4");
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("etag"), "etag-test");
  assert.equal(
    response.headers.get("last-modified"),
    "Wed, 21 Oct 2015 07:28:00 GMT",
  );
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("retries a transient 5xx media response once", async () => {
  const sourceUrl = "https://fast-stream.jav.si/video/transient.mp4";
  const bytes = new Uint8Array([4, 3, 2, 1]);
  let attempts = 0;
  const response = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}`,
      { headers: { range: "bytes=0-3" } },
    ),
    {},
    {},
    async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("temporary", {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(bytes, {
        status: 206,
        headers: {
          "content-length": String(bytes.length),
          "content-range": "bytes 0-3/4",
          "content-type": "video/mp4",
        },
      });
    },
  );

  assert.equal(attempts, 2);
  assert.equal(response.status, 206);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("buffers a media Range request once and serves the slice without background warmup", async () => {
  const sourceUrl = "https://fast-stream.jav.si/video/range-first.ts";
  const proxyUrl =
    `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}&kind=segment&hls=1`;
  const requestedRange = "bytes=4-7";
  const fullBytes = Uint8Array.from(
    { length: 20 },
    (_, index) => index,
  );
  const partialBytes = Uint8Array.from([4, 5, 6, 7]);
  let upstreamFetches = 0;
  let waitUntilCalls = 0;
  const context = {
    waitUntil(task) {
      waitUntilCalls += 1;
      return task;
    },
  };

  const response = await handleProxy(
    new Request(proxyUrl, { headers: { range: requestedRange } }),
    {},
    context,
    async (_url, init = {}) => {
      upstreamFetches += 1;
      assert.equal(init.headers.get("range"), null);
      return new Response(fullBytes, {
        status: 200,
        headers: {
          "content-length": String(fullBytes.length),
          "content-type": "video/mp2t",
        },
      });
    },
  );

  assert.equal(upstreamFetches, 1);
  assert.equal(waitUntilCalls, 0);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 4-7/20");
  assert.equal(response.headers.get("content-length"), String(partialBytes.length));
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    partialBytes,
  );
});

test("coalesces concurrent media Range requests into one full segment fetch", async () => {
  const sourceUrl = "https://fast-stream.jav.si/video/concurrent-range.ts";
  const proxyUrl =
    `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}&kind=segment&hls=1`;
  const fullBytes = Uint8Array.from(
    { length: 12 },
    (_, index) => index,
  );
  let upstreamFetches = 0;
  let waitUntilCalls = 0;
  const context = {
    waitUntil(task) {
      waitUntilCalls += 1;
      return task;
    },
  };

  const responses = await Promise.all(
    Array.from({ length: 3 }, (_, index) => {
      const start = index * 4;
      return handleProxy(
        new Request(proxyUrl, {
          headers: { range: `bytes=${start}-${start + 3}` },
        }),
        {},
        context,
        async (_url, init = {}) => {
          upstreamFetches += 1;
          assert.equal(init.headers.get("range"), null);
          return new Response(fullBytes, {
            status: 200,
            headers: {
              "content-length": String(fullBytes.length),
              "content-type": "video/mp2t",
            },
          });
        },
      );
    }),
  );

  assert.equal(upstreamFetches, 1);
  assert.equal(waitUntilCalls, 0);
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    const start = index * 4;
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), `bytes ${start}-${start + 3}/12`);
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      Uint8Array.from([start, start + 1, start + 2, start + 3]),
    );
  }
});

test("proxies resolver CDN Range requests for every current media suffix", async () => {
  const hosts = [
    "s6pb.vendorconnection.shop",
    "smhx.summitdigitalhub.space",
  ];

  for (const host of hosts) {
    const sourceUrl = `https://${host}/hls/movie/segment-1.woff2`;
    const proxyUrl =
      `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}&kind=segment&hls=1`;
    const bytes = new Uint8Array([0x47, 0x40, 0x11, 0x10]);
    let upstreamFetches = 0;

    const response = await handleProxy(
      new Request(proxyUrl, { headers: { range: "bytes=0-3" } }),
      {},
      {},
      async (_url, init = {}) => {
        upstreamFetches += 1;
        assert.equal(init.headers.get("range"), null);
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-length": String(bytes.length),
            "content-type": "application/octet-stream",
          },
        });
      },
    );

    assert.equal(upstreamFetches, 1);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 0-3/4");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
});

test("allows GG HLS media hosts and caches only complete segment GETs", async () => {
  const bytes = new Uint8Array([0x47, 0x40, 0x11, 0x10]);
  const hosts = [
    "https://dd2stliwt0bc.cloudvexario.xyz/hls/01/08392/seg-1-f3-v1-a1.woff2",
    "https://wt4pjiive9agjpl.startupmarketingaid.cfd/hls/01/08392/seg-1-f3-v1-a1.woff2",
  ];

  for (const sourceUrl of hosts) {
    const response = await handleProxy(
      new Request(
        `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}&kind=segment&hls=1`,
      ),
      {},
      {},
      async () => new Response(bytes, {
        status: 200,
        headers: {
          "content-length": String(bytes.length),
          "content-type": "application/octet-stream",
        },
      }),
    );

    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("cache-control"),
      /^public, max-age=90, stale-while-revalidate=30$/,
    );
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }

  const rangeSourceUrl = hosts[0];
  const rangeResponse = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(rangeSourceUrl)}&kind=segment&hls=1`,
      { headers: { range: `bytes=0-${bytes.length - 1}` } },
    ),
    {},
    {},
    async (_url, init = {}) => {
      assert.equal(init.headers.get("range"), `bytes=0-${bytes.length - 1}`);
      return new Response(bytes, {
        status: 206,
        headers: {
          "content-length": String(bytes.length),
          "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
          "content-type": "application/octet-stream",
        },
      });
    },
  );

  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get("cache-control"), "no-store");
  assert.equal(
    rangeResponse.headers.get("content-range"),
    `bytes 0-${bytes.length - 1}/${bytes.length}`,
  );
  assert.deepEqual(new Uint8Array(await rangeResponse.arrayBuffer()), bytes);

  const pseudoPngSourceUrl =
    "https://p16-ad-site-sign-sg.tiktokcdn.com/video/origin.image?token=gg";
  const pseudoPngBytes = new Uint8Array(512);
  pseudoPngBytes.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ], 0);
  pseudoPngBytes[70] = 0x47;
  pseudoPngBytes[258] = 0x47;
  pseudoPngBytes[446] = 0x47;
  const expectedTsBytes = pseudoPngBytes.slice(70);
  let pseudoPngFetches = 0;
  const pseudoPngResponse = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(pseudoPngSourceUrl)}&kind=segment&hls=1`,
    ),
    {},
    {},
    async (_url, init = {}) => {
      pseudoPngFetches += 1;
      assert.equal(init.headers.get("range"), null);
      return new Response(pseudoPngBytes, {
        status: 200,
        headers: {
          "content-length": String(pseudoPngBytes.length),
          "content-type": "image/png",
        },
      });
    },
  );

  assert.equal(pseudoPngResponse.status, 200);
  assert.equal(pseudoPngResponse.headers.get("content-type"), "video/mp2t");
  assert.equal(
    pseudoPngResponse.headers.get("content-length"),
    String(expectedTsBytes.length),
  );
  assert.deepEqual(
    new Uint8Array(await pseudoPngResponse.arrayBuffer()),
    expectedTsBytes,
  );

  const pseudoPngRangeResponse = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(pseudoPngSourceUrl)}&kind=segment&hls=1`,
      { headers: { range: "bytes=188-375" } },
    ),
    {},
    {},
    async () => {
      throw new Error("cached pseudo PNG segment should not be fetched again");
    },
  );

  assert.equal(pseudoPngFetches, 1);
  assert.equal(pseudoPngRangeResponse.status, 206);
  assert.equal(
    pseudoPngRangeResponse.headers.get("content-range"),
    `bytes 188-375/${expectedTsBytes.length}`,
  );
  assert.equal(pseudoPngRangeResponse.headers.get("content-length"), "188");
  assert.deepEqual(
    new Uint8Array(await pseudoPngRangeResponse.arrayBuffer()),
    expectedTsBytes.slice(188, 376),
  );

  const rangeFirstSourceUrl =
    "https://p19-ad-site-sign-sg.tiktokcdn.com/video/origin.image?token=gg";
  const rangeFirstResponse = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(rangeFirstSourceUrl)}&kind=segment&hls=1`,
      { headers: { range: "bytes=0-187" } },
    ),
    {},
    {},
    async (_url, init = {}) => {
      assert.equal(init.headers.get("range"), "bytes=0-511");
      return new Response(pseudoPngBytes, {
        status: 200,
        headers: {
          "content-length": String(pseudoPngBytes.length),
          "content-type": "image/png",
        },
      });
    },
  );

  assert.equal(rangeFirstResponse.status, 206);
  assert.equal(
    rangeFirstResponse.headers.get("content-range"),
    `bytes 0-187/${expectedTsBytes.length}`,
  );
  assert.deepEqual(
    new Uint8Array(await rangeFirstResponse.arrayBuffer()),
    expectedTsBytes.slice(0, 188),
  );

  const upstreamPartialSourceUrl =
    "https://p16-ad-site-sign-sg.tiktokcdn.com/video/origin.image?token=upstream-partial";
  const upstreamPartialResponse = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(upstreamPartialSourceUrl)}&kind=segment&hls=1`,
      { headers: { range: "bytes=0-187" } },
    ),
    {},
    {},
    async (_url, init = {}) => {
      assert.equal(init.headers.get("range"), "bytes=0-511");
      return new Response(pseudoPngBytes, {
        status: 206,
        headers: {
          "content-length": String(pseudoPngBytes.length),
          "content-range": `bytes 0-${pseudoPngBytes.length - 1}/${pseudoPngBytes.length}`,
          "content-type": "image/png",
        },
      });
    },
  );

  assert.equal(upstreamPartialResponse.status, 206);
  assert.equal(
    upstreamPartialResponse.headers.get("content-range"),
    `bytes 0-187/${expectedTsBytes.length}`,
  );
  assert.deepEqual(
    new Uint8Array(await upstreamPartialResponse.arrayBuffer()),
    expectedTsBytes.slice(0, 188),
  );

  const malformedRangeResponse = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(pseudoPngSourceUrl)}&kind=segment&hls=1`,
      { headers: { range: "bytes=not-a-range" } },
    ),
    {},
    {},
    async () => {
      throw new Error("malformed range should fall back to the cached complete segment");
    },
  );

  assert.equal(malformedRangeResponse.status, 200);
  assert.deepEqual(
    new Uint8Array(await malformedRangeResponse.arrayBuffer()),
    expectedTsBytes,
  );
});

test("maps pseudo PNG ranges beyond the prefix probe without a full download", async () => {
  const prefixLength = 70;
  const rawBytes = new Uint8Array(prefixLength + 8 * 188);
  rawBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let offset = prefixLength; offset < rawBytes.byteLength; offset += 188) {
    rawBytes[offset] = 0x47;
  }
  const sourceUrl =
    "https://p19-ad-site-sign-sg.tiktokcdn.com/video/probe-range.image?token=mapped";
  const proxyUrl =
    `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}&kind=segment&hls=1`;
  const upstreamRanges = [];

  const response = await handleProxy(
    new Request(proxyUrl, { headers: { range: "bytes=300-487" } }),
    {},
    {},
    async (_url, init = {}) => {
      const range = init.headers.get("range");
      upstreamRanges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(String(range || ""));
      assert.ok(match, `expected a single upstream Range, got ${range}`);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const bytes = rawBytes.slice(start, end + 1);
      return new Response(bytes, {
        status: 206,
        headers: {
          "content-length": String(bytes.byteLength),
          "content-range": `bytes ${start}-${end}/${rawBytes.byteLength}`,
          "content-type": "image/png",
        },
      });
    },
  );

  assert.deepEqual(upstreamRanges, ["bytes=0-511", "bytes=370-557"]);
  assert.equal(response.status, 206);
  assert.equal(
    response.headers.get("content-range"),
    `bytes 300-487/${rawBytes.byteLength - prefixLength}`,
  );
  assert.equal(response.headers.get("content-length"), "188");
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    rawBytes.slice(370, 558),
  );
});

test("reassembles every pseudo PNG virtual range without dropping TS bytes", async () => {
  const prefixLength = 70;
  const virtualLength = 3 * 188;
  const rawBytes = new Uint8Array(prefixLength + virtualLength);
  rawBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let offset = prefixLength; offset < rawBytes.byteLength; offset += 188) {
    rawBytes[offset] = 0x47;
  }
  const sourceUrl =
    "https://p16-ad-site-sign-sg.tiktokcdn.com/video/multi-range.image?token=mapped";
  const proxyUrl =
    `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}&kind=segment&hls=1`;
  const ranges = [
    [0, 187],
    [188, 375],
    [376, 563],
  ];
  const chunks = [];

  for (const [start, end] of ranges) {
    const response = await handleProxy(
      new Request(proxyUrl, {
        headers: { range: `bytes=${start}-${end}` },
      }),
      {},
      {},
      async (_url, init = {}) => {
        const range = String(init.headers.get("range") || "");
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        assert.ok(match, `expected a single upstream Range, got ${range}`);
        const upstreamStart = Number(match[1]);
        const upstreamEnd = Number(match[2]);
        const bytes = rawBytes.slice(upstreamStart, upstreamEnd + 1);
        return new Response(bytes, {
          status: 206,
          headers: {
            "content-length": String(bytes.byteLength),
            "content-range":
              `bytes ${upstreamStart}-${upstreamEnd}/${rawBytes.byteLength}`,
            "content-type": "image/png",
          },
        });
      },
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-length"), "188");
    assert.equal(
      response.headers.get("content-range"),
      `bytes ${start}-${end}/${virtualLength}`,
    );
    chunks.push(new Uint8Array(await response.arrayBuffer()));
  }

  const reassembled = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    reassembled.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assert.equal(reassembled.byteLength, virtualLength);
  assert.deepEqual(reassembled, rawBytes.slice(prefixLength));
});

test("serves a complete vendorconnection.shop pseudo media object intact", async () => {
  const prefixLength = 70;
  const rawBytes = new Uint8Array(prefixLength + 3 * 188);
  rawBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let offset = prefixLength; offset < rawBytes.byteLength; offset += 188) {
    rawBytes[offset] = 0x47;
  }
  const sourceUrl =
    "https://s6pb.vendorconnection.shop/hls/movie/full.image?token=gg";

  const response = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}&kind=segment&hls=1`,
    ),
    {},
    {},
    async (_url, init = {}) => {
      assert.equal(init.headers.get("range"), null);
      return new Response(rawBytes, {
        status: 200,
        headers: {
          "content-length": String(rawBytes.byteLength),
          "content-type": "image/png",
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp2t");
  assert.equal(
    response.headers.get("content-length"),
    String(rawBytes.byteLength - prefixLength),
  );
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    rawBytes.slice(prefixLength),
  );
});

test("caches complete GetAV HLS segments larger than 8 MiB", async () => {
  const sourceUrl =
    "https://static.worldstatic.com/cdn/assets/deliveries/v2/4k/seg-0.woff2?e=2104450940";
  const proxyUrl =
    `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}&kind=segment&hls=1&encrypted=1`;
  const segmentLength = 13_357_600;
  const segmentBytes = new Uint8Array(segmentLength);
  segmentBytes.fill(0xa5);
  let upstreamFetches = 0;

  const firstFull = await handleProxy(
    new Request(proxyUrl),
    {},
    {},
    async (_url, init = {}) => {
      upstreamFetches += 1;
      assert.equal(init.headers.get("range"), null);
      return new Response(segmentBytes, {
        status: 200,
        headers: {
          "content-length": String(segmentLength),
          "content-type": "application/octet-stream",
        },
      });
    },
  );

  assert.equal(firstFull.status, 200);
  assert.equal(firstFull.headers.get("content-length"), String(segmentLength));
  assert.deepEqual(
    new Uint8Array(await firstFull.arrayBuffer()),
    segmentBytes,
  );

  const secondRange = await handleProxy(
    new Request(proxyUrl, { headers: { range: "bytes=1024-1535" } }),
    {},
    {},
    async () => {
      throw new Error("large cached segment should not be fetched again");
    },
  );

  assert.equal(upstreamFetches, 1);
  assert.equal(secondRange.status, 206);
  assert.equal(
    secondRange.headers.get("content-range"),
    `bytes 1024-1535/${segmentLength}`,
  );
  assert.equal(secondRange.headers.get("content-length"), "512");
  assert.deepEqual(
    new Uint8Array(await secondRange.arrayBuffer()),
    segmentBytes.slice(1024, 1536),
  );
});

test("does not cache a streamed media segment after an early client cancel", async () => {
  const sourceUrl =
    "https://static.worldstatic.com/cdn/assets/deliveries/v2/1080/seg-cancel.woff2?e=2104450940";
  const proxyUrl =
    `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}&kind=segment&hls=1&encrypted=1`;
  const firstChunk = new Uint8Array([1, 2, 3, 4]);
  const completeSegment = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  let upstreamFetches = 0;
  let firstBodyCancelled = false;

  const firstResponse = await handleProxy(
    new Request(proxyUrl),
    {},
    {},
    async () => {
      upstreamFetches += 1;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(firstChunk);
        },
        cancel() {
          firstBodyCancelled = true;
        },
      }), {
        status: 200,
        headers: {
          "content-length": String(completeSegment.byteLength),
          "content-type": "application/octet-stream",
        },
      });
    },
  );

  const reader = firstResponse.body.getReader();
  const firstRead = await reader.read();
  assert.deepEqual(firstRead.value, firstChunk);
  await reader.cancel();
  assert.equal(firstBodyCancelled, true);

  const secondResponse = await handleProxy(
    new Request(proxyUrl),
    {},
    {},
    async () => {
      upstreamFetches += 1;
      return new Response(completeSegment, {
        status: 200,
        headers: {
          "content-length": String(completeSegment.byteLength),
          "content-type": "application/octet-stream",
        },
      });
    },
  );

  assert.equal(upstreamFetches, 2);
  assert.deepEqual(
    new Uint8Array(await secondResponse.arrayBuffer()),
    completeSegment,
  );
});

test("uses the GetAV Referer for static.worldstatic.com media and keeps hotlink headers", async () => {
  const sourceUrl = "https://static.worldstatic.com/signed/rctd-740/index.txt?token=abc";
  const playlistBytes = new TextEncoder().encode(
    "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://static.worldstatic.com/signed/rctd-740/seg0.ts\n#EXT-X-ENDLIST\n",
  );
  let requestHeaders;
  const response = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}`,
      {
        headers: {
          range: "bytes=0-3",
          "if-none-match": "etag-test",
        },
      },
    ),
    {},
    {},
    async (_url, init = {}) => {
      requestHeaders = init.headers;
      return new Response(playlistBytes, {
        status: 200,
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    },
  );

  assert.equal(requestHeaders.get("referer"), "https://getav.net/");
  assert.equal(requestHeaders.get("origin"), UPSTREAM);
  assert.ok(requestHeaders.get("user-agent"));
  assert.equal(requestHeaders.get("range"), "bytes=0-3");
  assert.equal(requestHeaders.get("if-none-match"), "etag-test");
  assert.equal(response.status, 200);
});

test("keeps Referer for non-worldstatic media hosts", async () => {
  const sourceUrl = "https://fast-stream.jav.si/video/test.mp4";
  let requestHeaders;
  const response = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}`,
    ),
    {},
    {},
    async (_url, init = {}) => {
      requestHeaders = init.headers;
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    },
  );

  assert.equal(requestHeaders.get("referer"), `${UPSTREAM}/`);
  assert.equal(response.status, 200);
});

test("allows extensionless Google Drive HLS segments through the media proxy", async () => {
  const sourceUrl =
    "https://lh3.googleusercontent.com/d/segment-one=d";
  let requestHeaders;
  const response = await handleProxy(
    new Request(
      `https://clone.example/emby-media/?url=${encodeURIComponent(sourceUrl)}`,
      { headers: { range: "bytes=0-127" } },
    ),
    {},
    {},
    async (_url, init = {}) => {
      requestHeaders = init.headers;
      return new Response(new Uint8Array([0x47, 0x40, 0x11, 0x10]), {
        status: 206,
        headers: {
          "content-range": "bytes 0-3/4",
          "content-type": "video/mp2t",
        },
      });
    },
  );

  assert.equal(requestHeaders.get("range"), "bytes=0-127");
  assert.equal(requestHeaders.get("referer"), `${UPSTREAM}/`);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-type"), "video/mp2t");
});

test("serves a movie primary image through the Emby endpoint", async () => {
  const imageBytes = new Uint8Array([255, 216, 255, 217]);
  const encryptedImageBytes = new Uint8Array([234, 21, 50, 21, 51]);
  let imageUrl;
  const response = await handleProxy(
    new Request("https://clone.example/Items/42/Images/Primary"),
    {},
    {},
    async (url) => {
      const target = String(url);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, cover_url: "https://jdforrepam.com/covers/test.jpg" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      imageUrl = target;
      return new Response(encryptedImageBytes, {
        headers: { "content-type": "binary/octet-stream" },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(imageUrl, "https://jdforrepam.com/covers/test.jpg");
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), imageBytes);
});

test("exposes upstream preview images as Emby backdrop art", async () => {
  const imageBytes = new Uint8Array([255, 216, 255, 217]);
  const encryptedImageBytes = new Uint8Array([234, 21, 50, 21, 51]);
  const movie = {
    id: "42",
    number: "TEST-042",
    cover_url: "https://jdforrepam.com/covers/test.jpg",
    preview_images: [
      {
        thumb_url: "https://jdforrepam.com/samples/test_s_0.jpg",
        large_url: "https://jdforrepam.com/samples/test_l_0.jpg",
      },
      {
        thumb_url: "https://jdforrepam.com/samples/test_s_1.jpg",
        large_url: "https://jdforrepam.com/samples/test_l_1.jpg",
      },
    ],
  };
  const movieResponse = () => new Response(
    JSON.stringify({ success: 1, data: { movie } }),
    { headers: { "content-type": "application/json" } },
  );

  const detail = await handleProxy(
    new Request("https://clone.example/Items/42"),
    {},
    {},
    async (url) => String(url).includes("/v4/movies/42")
      ? movieResponse()
      : new Response(encryptedImageBytes, { headers: { "content-type": "image/jpeg" } }),
  );
  const payload = await detail.json();
  assert.equal(detail.status, 200);
  // 客户端凭这些 tag 才知道“艺术图”区块有几张图。
  // 第一张固定是资源封面，后面才是预览剧照。
  assert.deepEqual(payload.BackdropImageTags, ["0", "1", "2"]);

  let coverBackdropUrl;
  const coverImage = await handleProxy(
    new Request("https://clone.example/Items/42/Images/Backdrop/0"),
    {},
    {},
    async (url) => {
      const target = String(url);
      if (target.includes("/v4/movies/42")) {
        return movieResponse();
      }
      coverBackdropUrl = target;
      return new Response(encryptedImageBytes, {
        headers: { "content-type": "binary/octet-stream" },
      });
    },
  );
  assert.equal(coverImage.status, 200);
  // 艺术图第一张改成资源封面。
  assert.equal(coverBackdropUrl, "https://jdforrepam.com/covers/test.jpg");

  let backdropUrl;
  const image = await handleProxy(
    new Request("https://clone.example/Items/42/Images/Backdrop/1"),
    {},
    {},
    async (url) => {
      const target = String(url);
      if (target.includes("/v4/movies/42")) {
        return movieResponse();
      }
      backdropUrl = target;
      return new Response(encryptedImageBytes, {
        headers: { "content-type": "binary/octet-stream" },
      });
    },
  );
  assert.equal(image.status, 200);
  // 封面占掉第一位后，下标 1 起才是上游预览剧照的大图。
  assert.equal(backdropUrl, "https://jdforrepam.com/samples/test_l_0.jpg");
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), imageBytes);
});

test("serves the advertised Chinese subtitle stream", async () => {
  const subtitleText = "1\r\n00:00:01,000 --> 00:00:02,000\r\n你好\r\n";
  let subtitleFileUrl;
  const response = await handleProxy(
    new Request("https://clone.example/Videos/42/42/Subtitles/2/Stream.srt?api_key=bbjavdb-guest"),
    {},
    {},
    async (url) => {
      const target = String(url);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "TEST-001" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes("/api/subtitle?name=TEST-001")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: [{
              cid: "subtitle-1",
              url: "https://subtitle.example/test.srt",
              ext: "srt",
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      subtitleFileUrl = target;
      return new Response(subtitleText, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(subtitleFileUrl, "https://subtitle.example/test.srt");
  assert.equal(response.headers.get("content-type"), "application/x-subrip; charset=utf-8");
  assert.equal(await response.text(), subtitleText);
});

test("streams a resolved video and forwards Range headers", async () => {
  const videoBytes = new Uint8Array([0, 1, 2, 3]);
  let sourceRange;
  const response = await handleProxy(
    new Request("https://clone.example/Videos/42/stream.mp4?api_key=javdb-token", {
      headers: { "if-range": "test-etag", range: "bytes=0-3" },
    }),
    {},
    {},
    async (url, init = {}) => {
      const target = String(url);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "TEST-001", title: "Test Movie" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [{ variant: "original", sourceUrl: "https://fast-stream.jav.si/video/test.mp4", sourceType: "video/mp4" }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      sourceRange = init.headers?.get("range");
      return new Response(videoBytes, {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-range": "bytes 0-3/4",
          "content-type": "video/mp4",
        },
      });
    },
  );

  assert.equal(response.status, 206);
  assert.equal(sourceRange, "bytes=0-3");
  assert.match(response.headers.get("access-control-expose-headers"), /Content-Range/);
  assert.equal(response.headers.get("content-range"), "bytes 0-3/4");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), videoBytes);
});

test("reuses the source advertised by PlaybackInfo without resolving it again", async () => {
  const videoBytes = new Uint8Array([0, 0, 0, 32]);
  const calls = [];
  const source = encodeURIComponent("https://fast-stream.jav.si/video/test.mp4");
  const response = await handleProxy(
    new Request(
      `https://clone.example/Videos/42/stream.mp4?api_key=bbjavdb-guest&source=${source}&sourceType=video%2Fmp4`,
      { headers: { range: "bytes=0-3" } },
    ),
    {},
    {},
    async (url, init = {}) => {
      calls.push(String(url));
      assert.equal(String(url), "https://fast-stream.jav.si/video/test.mp4");
      assert.equal(init.headers.get("range"), "bytes=0-3");
      return new Response(videoBytes, {
        status: 206,
        headers: {
          "content-range": "bytes 0-3/4",
          "content-type": "video/mp4",
        },
      });
    },
  );

  assert.equal(response.status, 206);
  assert.equal(calls.length, 1);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), videoBytes);
});

test("serves Emby master/main HLS aliases instead of 404", async () => {
  // 部分客户端拿到 HLS 源后会先请求 master.m3u8 / main.m3u8；
  // 旧代码只认 stream.m3u8，这两个路径直接 404，客户端报
  // "Playback failed: Could not fetch …"。这里断言它们与 stream.m3u8 等价。
  const playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nhttps://fast-stream.jav.si/seg/1.ts\n";
  const source = encodeURIComponent("https://fast-stream.jav.si/live/index.m3u8");
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(playlist, {
      status: 200,
      headers: { "content-type": "application/vnd.apple.mpegurl" },
    });
  };
  for (const alias of ["master.m3u8", "main.m3u8"]) {
    const response = await handleProxy(
      new Request(
        `https://clone.example/emby/Videos/42/${alias}?api_key=bbjavdb-guest&source=${source}&sourceType=application%2Fvnd.apple.mpegurl`,
      ),
      {},
      {},
      fetchImpl,
    );
    assert.equal(response.status, 200, `${alias} should not 404`);
    const body = await response.text();
    assert.match(body, /#EXTM3U/);
    assert.match(body, /emby-media/);
  }
  assert.ok(calls.length >= 2);
});

test("refreshes a stale media URL and accepts SenPlayer stream path variants", async () => {
  const videoBytes = new Uint8Array([0, 0, 0, 32]);
  const calls = [];
  const freshRanges = [];
  const staleSource = encodeURIComponent("https://fast-stream.jav.si/video/stale.mp4");
  const response = await handleProxy(
    new Request(
      `https://clone.example/emby/Videos/42/42/stream.mp4?api_key=bbjavdb-guest&source=${staleSource}&sourceType=video%2Fmp4`,
      { headers: { range: "bytes=0-3" } },
    ),
    {},
    {},
    async (url, init = {}) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith("/video/stale.mp4")) {
        return new Response("expired", { status: 404 });
      }
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "TEST-001" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            variants: [{
              variant: "original",
              sourceUrl: "https://fast-stream.jav.si/video/fresh.mp4",
              sourceType: "video/mp4",
            }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      assert.equal(target, "https://fast-stream.jav.si/video/fresh.mp4");
      freshRanges.push(init.headers.get("range"));
      return new Response(videoBytes, {
        status: 206,
        headers: {
          "content-range": "bytes 0-3/4",
          "content-type": "video/mp4",
        },
      });
    },
  );

  assert.equal(response.status, 206);
  assert.deepEqual(calls, [
    "https://fast-stream.jav.si/video/stale.mp4",
    "https://jdforrepam.com/api/v4/movies/42",
    `${RESOLVER}/api/v/resolve?code=TEST-001&lang=zh`,
    "https://javtiful.com/zh/search?q=TEST-001",
    "https://r.jina.ai/https://getav.net/zh/videos/test-001",
    "https://getav.net/zh/videos/test-001",
    "https://fast-stream.jav.si/video/fresh.mp4",
    "https://fast-stream.jav.si/video/fresh.mp4",
  ]);
  assert.deepEqual(freshRanges, ["bytes=0-511", "bytes=0-3"]);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), videoBytes);
});

test("accepts SenPlayer source aliases and sends media hotlink headers", async () => {
  const videoBytes = new Uint8Array([0, 0, 0, 32]);
  const source = encodeURIComponent("https://fast-stream.jav.si/video/test.mp4");
  const response = await handleProxy(
    new Request(
      `https://clone.example/emby/videos/42/42/streaming-video.mp4?api_key=bbjavdb-guest&sourceUrl=${source}`,
      { headers: { range: "bytes=0-3" } },
    ),
    {},
    {},
    async (url, init = {}) => {
      assert.equal(String(url), "https://fast-stream.jav.si/video/test.mp4");
      assert.equal(init.headers.get("range"), "bytes=0-3");
      assert.equal(init.headers.get("origin"), UPSTREAM);
      assert.equal(init.headers.get("referer"), `${UPSTREAM}/`);
      return new Response(videoBytes, {
        status: 206,
        headers: {
          "content-range": "bytes 0-3/4",
          "content-type": "video/mp4",
        },
      });
    },
  );

  assert.equal(response.status, 206);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), videoBytes);
});

test("streams relative URLs from alternate resolver response fields", async () => {
  const videoBytes = new Uint8Array([0, 0, 0, 32]);
  const calls = [];
  const freshRanges = [];
  const response = await handleProxy(
    new Request(
      "https://clone.example/Videos/42/playback.mp4?api_key=bbjavdb-guest",
      { headers: { range: "bytes=0-3" } },
    ),
    {},
    {},
    async (url, init = {}) => {
      const target = String(url);
      calls.push(target);
      if (target.includes("/v4/movies/42")) {
        return new Response(
          JSON.stringify({
            success: 1,
            data: { movie: { id: 42, number: "TEST-001" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (target.includes(`${RESOLVER}/api/v/resolve`)) {
        return new Response(
          JSON.stringify({
            data: {
              sources: [{
                name: "original",
                source_url: "/video/fresh.mp4",
                mime_type: "video/mp4",
              }],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      assert.equal(target, `${UPSTREAM}/video/fresh.mp4`);
      freshRanges.push(init.headers.get("range"));
      return new Response(videoBytes, {
        status: 206,
        headers: {
          "content-range": "bytes 0-3/4",
          "content-type": "video/mp4",
        },
      });
    },
  );

  assert.equal(response.status, 206);
  assert.deepEqual(calls, [
    "https://jdforrepam.com/api/v4/movies/42",
    `${RESOLVER}/api/v/resolve?code=TEST-001&lang=zh`,
    "https://javtiful.com/zh/search?q=TEST-001",
    "https://r.jina.ai/https://getav.net/zh/videos/test-001",
    "https://getav.net/zh/videos/test-001",
    `${UPSTREAM}/video/fresh.mp4`,
    `${UPSTREAM}/video/fresh.mp4`,
  ]);
  assert.deepEqual(freshRanges, ["bytes=0-511", "bytes=0-3"]);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), videoBytes);
});
