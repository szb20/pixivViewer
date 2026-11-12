/**
 * X (Twitter) 适配器 —— 通过公开 Nitter 实例的「媒体时间线 RSS」取图。
 *
 * 为什么是 Nitter 而不是官方 API：
 *   - 官方 X API 2026 年起按量计费（读帖 $0.005/条），个人查看关注流纯亏；
 *   - 本应用只需要「我关注的人最近发了哪些图」，RSS 的最近 ~50 条媒体正好够用。
 *
 * 已知限制（都是刻意的取舍，不是待修 bug）：
 *   - RSS 没有翻页游标：每个账号只拿得到最近约 50 条带媒体的推文；
 *   - 实例会抽查风（403/429）：做实例轮换 + 单账号 10 分钟缓存 + 并发上限 3；
 *   - 关注名单是本地静态配置（Nitter 无法读取你的 following），见设置页「X 图源」；
 *   - 只保留 pbs.twimg.com/media/ 下的静态图；视频/动图的封面（amplify_video_thumb）丢弃，
 *     本应用按静态图渲染，收进来只会得到一张不能播的卡片。
 *
 * 一条推文 → 一个 illust（与 Pixiv 多页插画同构）：pageCount = 图片数，
 * 多图推文因此直接复用现有的详情堆叠 / 灯箱翻页 / 下载全部页。
 */
import { CapacitorHttp } from '@capacitor/core';
import { createLogger } from '../utils/logger.js';
import { isDev, isDesktopShell, getDesktopProxyPort } from '../utils/platform.js';
import { getSettings, qualifyId, rawIdOf, sourceOfId } from '../pixiv-assistant/index.js';
import { classifyError } from './shared.js';

const log = createLogger('nitter');

/**
 * 默认实例池：2026-11-13 实测 `/media/rss` 能返回条目的三个，外加一个备用。
 * 实测结论（同一出口 IP）：
 *   nitter.ip6arpa.uk   200 / 34 条
 *   nitter.jaydenha.uk  200 / 34 条
 *   nitter.mie.foundation 200 / 34 条
 *   nitter.netbub.com   RSS 可用，但会触发 Gandalf 反爬（403），连续请求后整站对我们冷却
 *   nitter.mizuki.st    301 → ruf.st（代理不跟随跨域跳转，浏览器拿不到，直接排除）
 *   nitter.kareem.one   404（无 RSS 或该路由未开）
 */
const INSTANCES = [
  'nitter.ip6arpa.uk',
  'nitter.jaydenha.uk',
  'nitter.mie.foundation',
  'nitter.netbub.com',
];

/** Nitter 对非浏览器 UA 直接 403，所有请求都要装成浏览器 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 单账号缓存时长：下拉刷新会再次走到 feed()，这个值决定「多久才真的回源」 */
const USER_TTL = 15 * 60 * 1000;
/** 实例失败后的冷却时间 */
const INSTANCE_COOLDOWN = 10 * 60 * 1000;
/** 同时在拉的账号数上限 —— 实测 128 个账号：并发 4 要 133s，并发 8 只要 45s 且没触发 429 */
const FETCH_CONCURRENCY = 8;

/** 只认同站图床的静态图（视频封面是 amplify_video_thumb/，故意不收） */
const MEDIA_RE = /^https:\/\/pbs\.twimg\.com\/media\/[^/?#]+$/;

// ── 模块级状态：实例偏好 / 单账号缓存 / illustId → 条目索引 ──────────────
let preferred = 0;
const badUntil = new Map();
/** 实例连续失败次数：单次失败可能只是某个账号被限流，不该让整池实例一起冷却 */
const instanceFails = new Map();
const userCache = new Map();      // user → { ts, items }
const itemIndex = new Map();      // illustId → 条目
let inflightFeed = null;          // 同一时刻的并发 feed 合并成一次

/** 记一次实例失败：连续 2 次才冷却（21 个账号一批拉时，一次 403 很常见） */
function markInstanceFailure(host) {
  const n = (instanceFails.get(host) || 0) + 1;
  instanceFails.set(host, n);
  if (n >= 2) badUntil.set(host, Date.now() + INSTANCE_COOLDOWN);
}

/** 实例成功一次即清掉失败计数 */
function markInstanceSuccess(host) {
  instanceFails.delete(host);
  badUntil.delete(host);
}

/**
 * 设置页里的关注名单 → 去重后的用户名数组。
 * 接受 `@name` / `name` / `https://x.com/name` / `x.com/name`，按空白、逗号、分号切分。
 * @param {string} raw
 * @returns {string[]}
 */
export function parseUserList(raw) {
  const names = new Set();
  for (const token of String(raw || '').split(/[\s,;，；]+/)) {
    const t = token.trim();
    if (!t) continue;
    const fromUrl = t.match(/(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})/i);
    const bare = t.match(/^@?([A-Za-z0-9_]{1,15})$/);
    const name = fromUrl?.[1] || bare?.[1];
    // 纯数字当作无效（避免把推文 ID 当用户名发请求）
    if (name && !/^\d+$/.test(name)) names.add(name);
  }
  return [...names];
}

/** 设置里的自定义实例（去协议、去尾斜杠），非法返回 '' */
function normalizeInstance(raw) {
  const s = String(raw || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(s) ? s : '';
}

/** 实例优先级顺序：用户指定的实例排第一，冷却中的实例沉底 */
function instanceOrder(custom) {
  const pool = [...new Set([custom, ...INSTANCES].filter(Boolean))];
  const now = Date.now();
  const alive = pool.filter(h => (badUntil.get(h) || 0) <= now);
  const cooled = pool.filter(h => (badUntil.get(h) || 0) > now);
  // 以 preferred 为起点轮转已冷却的实例，避免每次都从同一个开始撞
  const startHost = INSTANCES[preferred];
  const i = alive.indexOf(startHost);
  const rotated = i > 0 ? [...alive.slice(i), ...alive.slice(0, i)] : alive;
  return [...rotated, ...cooled];
}

/** 取当前配置的关注名单（设置页 → X 图源；空则由 config.js 回落到 .env 的构建期默认值） */
async function configuredUsers() {
  let raw = '';
  try {
    raw = (await getSettings())?.twitterUsers || '';
  } catch { /* 设置读不到就按「没配置」处理 */ }
  return parseUserList(raw);
}

/** 依次试实例拉一段文本，全部失败返回 ''（不抛错） */
async function fetchFirstOk(path, custom) {
  for (const instance of instanceOrder(custom)) {
    try {
      const text = await fetchText(instance, path);
      markInstanceSuccess(instance);
      preferred = Math.max(0, INSTANCES.indexOf(instance));
      return text;
    } catch (e) {
      log.debug(`[fetchFirstOk] ${instance}${path} 失败:`, e?.message || e);
      markInstanceFailure(instance);
    }
  }
  return '';
}

/**
 * 读取某个账号的公开 following 列表 —— Nitter 的 `/username/following` 是公开页面，
 * 不需要登录（实测 2026-11-13：@mikunikuni1 共 128 个关注，4 页拉完）。
 *
 * 设置页「从账号导入」用它：贴一个用户名，就把那份关注列表填进关注名单。
 * 私密账号（protected）读不到，只能手动贴。
 *
 * @param {string} handle — 不带 @ 也可
 * @returns {Promise<string[]>} 用户名数组（失败时为空数组）
 */
export async function fetchFollowing(handle) {
  const name = String(handle || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) return [];
  const custom = await customInstance();
  const found = new Set();
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    // 光标在页面里已经是百分号编码过的，原样回传（再编码一次会翻页失败）
    const path = `/${encodeURIComponent(name)}/following${cursor ? `?cursor=${cursor}` : ''}`;
    // 翻页时实例偶尔抽一次 403/429：重试一次再放弃，否则导入会在半路截断（实测少 28 个）
    let html = await fetchFirstOk(path, custom);
    if (!html) {
      await new Promise(r => setTimeout(r, 800));
      html = await fetchFirstOk(path, custom);
    }
    if (!html) break;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let added = 0;
    for (const a of doc.querySelectorAll('a.username')) {
      const user = String(a.getAttribute('href') || '').replace(/^\//, '');
      if (/^[A-Za-z0-9_]{1,15}$/.test(user) && !found.has(user)) {
        found.add(user);
        added += 1;
      }
    }
    if (!added) break;
    // 页面上可能有两个 .show-more（其中一个不属于分页），认带 cursor 的那个
    const more = [...doc.querySelectorAll('.show-more a')]
      .map(a => a.getAttribute('href') || '')
      .find(h => h.includes('cursor=')) || '';
    const next = more.match(/cursor=([^&]+)/)?.[1] || '';
    if (!next || next === cursor) break;
    cursor = next;
    await new Promise(r => setTimeout(r, 500)); // 别把实例打急
  }
  return [...found];
}

/**
 * 拉一段文本（RSS）。
 *
 * dev / 桌面壳走同源代理（浏览器不给你跨域读 nitter，也不允许改写 UA）；
 * prod 走 CapacitorHttp 直连，UA 由我们自己设。
 */
async function fetchText(instance, path) {
  if (isDev() || isDesktopShell()) {
    const port = isDesktopShell() ? await getDesktopProxyPort() : 0;
    if (isDesktopShell() && !port) throw new Error('桌面代理端口不可用');
    const base = isDesktopShell() ? `http://127.0.0.1:${port}` : '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(`${base}/nitter-api${path}`, {
        headers: {
          // 目标实例作为自定义头交给代理：/nitter-api 是动态路由（见 scripts/booru-proxy.mjs）
          'x-nitter-host': instance,
          'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
        },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  const resp = await CapacitorHttp.request({
    method: 'GET',
    url: `https://${instance}${path}`,
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
    },
    connectTimeout: 20000,
    readTimeout: 20000,
  });
  if (resp.status < 200 || resp.status >= 300) {
    const e = new Error(`HTTP ${resp.status}`);
    e.status = resp.status;
    throw e;
  }
  return typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
}

/** XML 实体 → 文本（RSS 的 title 是实体转义过的） */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 描述里的 <img> 地址（Nitter 的媒体 RSS 把图片塞在 description 的 CDATA 里） */
function extractMediaUrls(description) {
  const urls = [];
  for (const m of String(description || '').matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const url = decodeEntities(m[1]).split('?')[0];
    if (MEDIA_RE.test(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

/** 描述里的 hashtag（详情页 tag 展示用，拿不到就算了） */
function extractTags(text) {
  return [...String(text || '').matchAll(/#([\p{L}\p{N}_]{1,30})/gu)]
    .map(m => m[1])
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 12);
}

/** 一张推文图 → 详情页需要的页结构（四档 URL 都由 pbs.twimg.com 的 name 参数派生） */
function toPage(url, index) {
  return {
    index,
    url: `${url}?name=small`,
    previewUrl: `${url}?name=medium`,
    thumbnailUrl: `${url}?name=small`,
    mediumUrl: `${url}?name=large`,
    originalUrl: `${url}?name=orig`,
    width: 0,
    height: 0,
  };
}

/**
 * 一条 RSS item → 应用统一条目（与 booru 的 mapPost 同形，上层零改动）。
 * @returns {object|null}
 */
function mapItem(item, userName) {
  const link = item.querySelector('link')?.textContent || '';
  const guid = item.querySelector('guid')?.textContent || '';
  const rawId = link.match(/\/status\/(\d+)/)?.[1] || (/^\d+$/.test(guid) ? guid : '');
  if (!rawId) return null;

  const description = item.querySelector('description')?.textContent || '';
  const mediaUrls = extractMediaUrls(description);
  if (!mediaUrls.length) return null; // 纯文字推文不进图流

  const pages = mediaUrls.map(toPage);
  const titleText = decodeEntities(item.querySelector('title')?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  const pubDate = Date.parse(item.querySelector('pubDate')?.textContent || '') || 0;

  return {
    illustId: qualifyId('twitter', rawId),
    source: 'twitter',
    _pageIndex: 0,
    pageCount: pages.length,
    _totalPages: pages.length,
    // 列表项自带全部页的地址：详情页冷启动（缓存恢复后不在适配器内存里）也能逐页渲染
    _pages: pages,
    type: 'image',
    illustType: 0,
    title: titleText,
    author: userName,
    authorName: userName,
    authorAccount: `@${userName}`,
    authorId: '',
    authorAvatar: '',
    tags: extractTags(description),
    width: 0,
    height: 0,
    webUrl: `https://x.com/${userName}/status/${rawId}`,
    pixivUrl: '',
    thumbnailUrl: pages[0].thumbnailUrl,
    mediumUrl: pages[0].mediumUrl,
    originalUrl: pages[0].originalUrl,
    publishedAt: pubDate,
  };
}

/** RSS 文本 → 条目数组 */
function parseRss(xmlText, userName) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('RSS 解析失败');
  return [...doc.querySelectorAll('item')]
    .map(el => mapItem(el, userName))
    .filter(Boolean);
}

/** 并发受限的 map（实例限速，别一把梭） */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

/**
 * 拉单个账号的媒体流（带缓存、实例轮换与重试）。
 *
 * 返回 `{ items, ok }`：ok=false 表示这次没拿到（可能是实例抽风，也可能是账号被限流），
 * 交给 feed() 在低并发下补拉一轮 —— 批量拉 20+ 账号时实例会零星抽 403/429，
 * 同一账号单独拉又正常；没有这一层的话每次冷启动都会随机少几个账号，
 * 而且看起来像「这个号没图片」。
 *
 * @returns {Promise<{items: object[], ok: boolean}>}
 */
async function fetchUser(user, customInstance, { force = false } = {}) {
  const hit = userCache.get(user);
  if (!force && hit && Date.now() - hit.ts < USER_TTL) return { items: hit.items, ok: true };

  let lastError = null;
  let saw404 = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const instance of instanceOrder(customInstance)) {
      try {
        const xml = await fetchText(instance, `/${encodeURIComponent(user)}/media/rss`);
        const items = parseRss(xml, user);
        userCache.set(user, { ts: Date.now(), items });
        for (const it of items) itemIndex.set(it.illustId, it);
        markInstanceSuccess(instance);
        preferred = Math.max(0, INSTANCES.indexOf(instance));
        return { items, ok: true };
      } catch (e) {
        if (e?.status === 404) saw404 = true;
        lastError = e;
        log.debug(`[fetchUser] ${instance} 失败:`, e?.message || e);
        markInstanceFailure(instance);
      }
    }
    // 把所有实例都试完才退避：单次 403 往往几百毫秒后就恢复
    if (attempt === 0) await new Promise(r => setTimeout(r, 700));
  }
  // 全部实例都 404 = 账号已注销 / 没有媒体 RSS：缓存空结果，别再每轮重试它
  // （128 个关注里实测有 23 个这种账号，重试它们纯属浪费）。
  if (saw404) {
    userCache.set(user, { ts: Date.now(), items: [] });
    return { items: [], ok: true };
  }
  log.debug(`[fetchUser] ${user} 全部实例失败:`, lastError?.message || lastError);
  // 失败但仍返回旧缓存：宁可显示上一次的内容，也别让卡片凭空消失
  return { items: hit?.items || [], ok: false };
}

/** 读设置里的自定义实例 */
async function customInstance() {
  try {
    return normalizeInstance((await getSettings())?.nitterInstance || '');
  } catch {
    return '';
  }
}

/**
 * 创建一个 X (Twitter) 来源。
 * @param {{id:string}} def — registry 里的来源定义
 */
export function createNitterSource(def) {
  const sourceId = def.id;

  return {
    id: sourceId,
    def,
    // 只留一档，避免侧边栏出现三个都点不出内容的档位（popular 恒返回友好错误）
    rankingModes: [{ key: 'recent', label: '最近' }],

    /**
     * 关注流 —— 名单里所有人最近发出的图片，按时间倒序合并成一页。
     * @returns {Promise<{illusts: object[], message?: string}>}
     */
    async feed({ page = 1, limit = 20 } = {}) {
      // 同一时刻只允许一次全量拉取（页面切 tab 会重复触发）
      if (!inflightFeed) {
        inflightFeed = (async () => {
          const [users, instance] = await Promise.all([configuredUsers(), customInstance()]);
          const results = await mapLimit(users, FETCH_CONCURRENCY, (u) => fetchUser(u, instance));
          const lists = results.map(r => r.items);
          // 第二轮补拉：首轮失败的账号串行再来一次（实例对它们通常只是短暂限流）。
          // 这一步把「每次冷启动随机少几个号」压到基本不出现。
          const failed = users.filter((_, i) => !results[i].ok);
          if (failed.length) {
            log.debug(`[feed] ${users.length} 个账号，首轮失败 ${failed.length} 个，串行补拉`);
            for (const u of failed) {
              await new Promise(r => setTimeout(r, 350));
              const r = await fetchUser(u, instance, { force: true });
              lists.push(r.items);
            }
          }
          // 同一条推文可能出现在多个账号的媒体 RSS 里（转发/引用）：按 illustId 去重，
          // 否则列表里会出现重复卡片，React 还会报 duplicate key。
          const merged = new Map();
          for (const item of lists.flat()) {
            if (!merged.has(item.illustId)) merged.set(item.illustId, item);
          }
          return [...merged.values()].sort((a, b) => b.publishedAt - a.publishedAt);
        })().finally(() => { inflightFeed = null; });
      }
      try {
        const all = await inflightFeed;
        const start = (Math.max(1, page) - 1) * limit;
        const slice = all.slice(start, start + limit);
        if (all.length === 0) {
          const users = await configuredUsers();
          return {
            illusts: [],
            message: users.length
              ? '关注名单里没有拿到图片（实例暂时不可用，稍后下拉刷新重试）'
              : '还没有配置关注名单：设置 → X 图源',
          };
        }
        return { illusts: slice };
      } catch (e) {
        log.error('[feed] 失败:', e?.message || e);
        return { illusts: [], message: classifyError(e, '关注流') };
      }
    },

    /**
     * 搜索 —— 只支持按 @用户名 查看（Nitter 的关键词搜索质量太差，先不做）。
     * @returns {Promise<{images: object[], query: string, error?: string}>}
     */
    async search(query, { limit = 20 } = {}) {
      const trimmed = String(query || '').trim();
      if (!trimmed) return { images: [], query: '' };
      const name = trimmed.match(/(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})/i)?.[1]
        || trimmed.match(/^@?([A-Za-z0-9_]{1,15})$/)?.[1];
      const looksLikeName = name && !/^\d+$/.test(name);
      if (!looksLikeName) {
        return { images: [], query: trimmed, error: 'X 源目前只支持按 @用户名 查看，关键词搜索暂不支持' };
      }
      try {
        const result = await fetchUser(name, await customInstance());
        if (!result.items.length) {
          return { images: [], query: trimmed, error: `没有找到 @${name} 的图片（账号不存在 / 不在实例覆盖范围）` };
        }
        return { images: result.items.slice(0, limit), query: trimmed };
      } catch (e) {
        log.error('[search] 失败:', e?.message || e);
        return { images: [], query: trimmed, error: classifyError(e, '搜索') };
      }
    },

    /**
     * 排行榜 —— X 源没有对应概念，返回友好错误而不是空列表
     * （空列表会被页面当成「加载失败」并要求重试）。
     */
    async popular() {
      return { illusts: [], error: 'X 图源没有排行榜，看「推荐」里的关注流即可' };
    },

    /**
     * 按 ID 取详情 —— 列表在内存里就命中索引；冷启动（缓存恢复的列表项）则重拉一遍关注流再查。
     */
    async fetchIllust(illustId) {
      const id = sourceOfId(illustId) === sourceId ? rawIdOf(illustId) : String(illustId);
      if (!id) return { illust: null, error: '作品 ID 为空' };

      let item = itemIndex.get(qualifyId(sourceId, id));
      if (!item) {
        try {
          const [users, instance] = await Promise.all([configuredUsers(), customInstance()]);
          await mapLimit(users, FETCH_CONCURRENCY, (u) => fetchUser(u, instance));
        } catch { /* 拿不到就按未找到处理 */ }
        item = itemIndex.get(qualifyId(sourceId, id));
      }
      if (!item) return { illust: null, error: '作品未找到，可能已删除或超出实例缓存范围' };

      return {
        illust: {
          illustId: item.illustId,
          title: item.title,
          authorName: item.authorName,
          authorAccount: item.authorAccount,
          authorId: '',
          tags: item.tags,
          pageCount: item.pageCount,
          illustType: 0,
          width: item.width,
          height: item.height,
          webUrl: item.webUrl,
          images: item._pages,
        },
      };
    },
  };
}
