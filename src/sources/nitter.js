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
import { directReady, homeFeed, followingFeed, searchFeed, authorsFromItems } from './xDirect.js';

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

/** 冷启动快出：feed page1 不等全量拉完，前 FAST_FIRST_USERS 个账号 settle 即先出一屏；
 *  其余账号在同一个 inflight 里继续后台并入，追加页等全量后按「未服务条目」推进 */
const FAST_FIRST_USERS = 3;
let releaseFastBatch = null;      // 当前 inflight 的「首批就绪」回调
const servedInFeed = new Set();   // 本次 feed 会话已返回给页面的条目 id（快出页与全量页间去重）
let feedCursor = 0;               // 全量列表游标：追加页从这里继续收集未服务条目

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
  return (await fetchFollowingEntries(handle, 20)).map(e => e.user);
}

/**
 * 拉某账号关注列表（带档案），页数上限可选。
 * maxPages 控制成本：博主推荐图谱的种子只拉前 2 页（聚合共现信号足够），
 * 设置页导入走默认 20 页拉全。
 * @param {string} handle
 * @param {number} [maxPages=20]
 * @returns {Promise<Array<{user: string, fullname: string, avatar: string}>>}
 */
async function fetchFollowingEntries(handle, maxPages = 20) {
  const name = String(handle || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(name)) return [];
  const custom = await customInstance();
  const found = new Map();
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
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
    for (const item of doc.querySelectorAll('.timeline-item')) {
      const a = item.querySelector('a.username');
      const user = String(a?.getAttribute('href') || '').replace(/^\//, '');
      if (!/^[A-Za-z0-9_]{1,15}$/.test(user) || user === name || found.has(user)) continue;
      const fullname = item.querySelector('.fullname')?.textContent?.trim() || user;
      // 实例代理头像多是相对路径（来源实例拉取后才知道），直接置空走 UI 的首字母占位
      const avatar = item.querySelector('img.avatar')?.getAttribute('src') || '';
      found.set(user, { user, fullname, avatar: avatar.startsWith('https://') ? avatar : '' });
      added += 1;
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
  return [...found.values()];
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
 * avatar：RSS 频道的 <image> 就是作者头像（直连 pbs.twimg.com），随列表免费带上。
 * @returns {object|null}
 */
function mapItem(item, userName, avatar = '') {
  const link = item.querySelector('link')?.textContent || '';
  const guid = item.querySelector('guid')?.textContent || '';
  const rawId = link.match(/\/status\/(\d+)/)?.[1] || (/^\d+$/.test(guid) ? guid : '');
  if (!rawId) return null;

  const description = item.querySelector('description')?.textContent || '';
  const mediaUrls = extractMediaUrls(description);
  if (!mediaUrls.length) return null; // 纯文字推文不进图流

  const pages = mediaUrls.map(toPage);
  // 标题去掉 #话题：tag 已由 extractTags 提取展示在标签区，标题里留着只是重复
  const titleText = decodeEntities(item.querySelector('title')?.textContent || '')
    .replace(/#[\p{L}\p{N}_]{1,30}/gu, '')
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
    authorAccount: userName,
    authorId: '',
    authorAvatar: avatar,
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

/** RSS 文本 → 条目数组（顺带取频道 <image> 的作者头像） */
function parseRss(xmlText, userName) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('RSS 解析失败');
  const avatar = doc.querySelector('channel > image > url')?.textContent?.trim() || '';
  return [...doc.querySelectorAll('item')]
    .map(el => mapItem(el, userName, avatar))
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
  // 404 之外的网络类错误（超时/SSL/5xx/403）：有它们在就不能断定账号不存在，
  // 否则实例抖动期（一个实例 404、其余超时）会把账号投毒成空缓存 15 分钟，
  // 期间所有重试秒失败且不发请求 —— 表现为「点击重试」假死。
  let sawOtherError = false;
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
        else sawOtherError = true;
        lastError = e;
        log.debug(`[fetchUser] ${instance} 失败:`, e?.message || e);
        markInstanceFailure(instance);
      }
    }
    // 把所有实例都试完才退避：单次 403 往往几百毫秒后就恢复
    if (attempt === 0) await new Promise(r => setTimeout(r, 700));
  }
  // 「所有失败都是 404」= 账号已注销 / 没有媒体 RSS：缓存空结果，别再每轮重试它
  // （128 个关注里实测有 23 个这种账号，重试它们纯属浪费）。
  // 混有网络错误时不下结论，走下面的旧缓存兜底。
  if (saw404 && !sawOtherError) {
    userCache.set(user, { ts: Date.now(), items: [] });
    return { items: [], ok: true };
  }
  log.debug(`[fetchUser] ${user} 全部实例失败:`, lastError?.message || lastError);
  // 失败但仍返回旧缓存：宁可显示上一次的内容，也别让卡片凭空消失
  return { items: hit?.items || [], ok: false };
}

/**
 * 解析 nitter 网页搜索结果页（?f=tweets&q=…），只抽博主推荐需要的作者信息。
 * HTML 结构稳定：每个 timeline-item 自带 data-username，首个 tweet-avatar img
 * 是作者头像，fullname 链接的 title 是昵称（实测见 2026-11 会话）。
 */
function parseSearchAuthors(html) {
  const out = [];
  const chunks = String(html || '').split('<div class="timeline-item');
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i].slice(0, 4000);
    const username = c.match(/data-username="([^"]+)"/)?.[1];
    if (!username) continue;
    const fullname = c.match(/class="fullname"[^>]*title="([^"]*)"/)?.[1] || username;
    const avatar = c.match(/class="tweet-avatar[^"]*"[^>]*>\s*<img[^>]+src="([^"]+)"/)?.[1] || '';
    out.push({ username, fullname, avatar });
  }
  return out;
}

/** 按话题标签搜索推文（nitter 网页搜索），返回发帖作者列表。 */
async function searchTagAuthors(tag, customInstance) {
  for (const instance of instanceOrder(customInstance)) {
    try {
      const html = await fetchText(instance, `/search?f=tweets&q=${encodeURIComponent('#' + tag)}`);
      const authors = parseSearchAuthors(html);
      markInstanceSuccess(instance);
      return authors;
    } catch (e) {
      log.debug('[searchTagAuthors] ' + instance + ' 失败:', e?.message || e);
      markInstanceFailure(instance);
    }
  }
  return [];
}

// 博主推荐会话级缓存：重新搜 tag 聚合要走数轮网络请求，TTL 1 小时；
// 关注名单变化由返回路径上的 exclude 过滤兜住，不必失效缓存。
const suggestCache = { ts: 0, users: [] };
const SUGGEST_TTL = 60 * 60 * 1000;

/**
 * tabCache 水合时重建内存索引。缓存条目自带 tags，灌回 itemIndex 即可恢复
 * tag 频次信号 —— 之前索引只在真实网络拉取时建立，冷启动水合态下推荐博主
 * 一直拿不到信号（ready=false 干等首拉/下拉刷新）。同 id 覆盖，幂等可重入。
 * @param {Array<{illustId: string, tags?: string[]}>} items — tabCache 里的 feed 条目
 */
export function hydrateIndex(items) {
  if (!Array.isArray(items)) return;
  for (const it of items) {
    if (it?.illustId) itemIndex.set(it.illustId, it);
  }
}

/**
 * 推荐博主：两路信号聚合，按「证据数」排序。
 *   1. 高频 tag → 逐 tag 搜推文（实例搜索可用时；2026-11 大面积 403/空结果，哪天恢复自动生效）
 *   2. 关注图谱（协同过滤）：你关注的种子博主的 following 里，几个种子共同关注的人
 *      —— 走 /following HTML 页，与搜索后端独立，是当前的主力信号
 * exclude = 当前关注名单（裸 handle）。
 * 返回 { users, ready }：ready=false 表示两路信号都还没产出（索引空 / 聚合空），
 * 结果不可信也不写缓存，调用方应稍后重试而不是当作「没有推荐」。
 */
async function suggestUsers(customInstance, exclude = []) {
  const excluded = new Set(exclude);
  if (Date.now() - suggestCache.ts >= SUGGEST_TTL) {
    // username → 聚合条目：count = 证据数（几个 tag 搜到 / 几个种子关注），tagCount = 命中 tag 的总热度
    const score = new Map();
    const bump = (entry) => {
      const cur = score.get(entry.username) || { ...entry, count: 0, tagCount: 0 };
      cur.count += 1;
      cur.tagCount += entry.tagCount || 0;
      if (!cur.avatar && entry.avatar) cur.avatar = entry.avatar;
      score.set(entry.username, cur);
    };

    // ── 信号 1：高频 tag 搜索 ──
    // 出现 ≥2 次的 tag 才值得搜，按频次取前 4 个
    const tagCount = new Map();
    for (const it of itemIndex.values()) {
      for (const t of (it.tags || [])) {
        if (t) tagCount.set(t, (tagCount.get(t) || 0) + 1);
      }
    }
    const topTags = [...tagCount.entries()]
      .filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
    await mapLimit(topTags, 2, async (tag) => {
      // 直连优先：SearchTimeline `#tag filter:images`（2026-11 实例搜索大面积 403，
      // 有 cookie 时这里是主力信号）；无 cookie / 直连失败回落实例搜索
      let authors = [];
      if (await directReady()) {
        try {
          const r = await searchFeed(`#${tag} filter:images`, 1);
          authors = authorsFromItems(r.items);
        } catch (e) {
          log.debug('[suggest] tag 直连失败，回落实例搜索:', e?.message || e);
        }
      }
      if (!authors.length) authors = await searchTagAuthors(tag, customInstance);
      for (const a of authors) {
        if (excluded.has(a.username)) continue;
        bump({ ...a, tagCount: tagCount.get(tag) || 0 });
      }
    });

    // ── 信号 2：关注图谱 ──
    // 种子 = 关注名单前 3 个、每个最多 2 页（~100 人）——控制请求量，
    // 「多个种子共同关注」的共现本身就是排序信号。
    if (exclude.length) {
      const seeds = exclude.slice(0, 3);
      await mapLimit(seeds, 2, async (seed) => {
        try {
          for (const f of await fetchFollowingEntries(seed, 2)) {
            if (excluded.has(f.user)) continue;
            bump({ ...f, username: f.user });
          }
        } catch { /* 单个种子拉失败不影响其他种子 */ }
      });
    }

    const ranked = [...score.values()]
      .sort((a, b) => b.count - a.count || b.tagCount - a.tagCount)
      // 保留 24 个候选：推荐行每批展示 8 个、「换一批」轮换浏览（见 DiscoverPage）。
      // 全量保留会掺进只有单一证据的低质账号，24 是「够翻三批」的量
      .slice(0, 24)
      .map(({ username, fullname, avatar }) => ({ username, fullname, avatar }));
    if (!ranked.length) {
      // 聚合无产出（实例瞬时抽风 / 种子都拉不到）：不写 1h 缓存，让调用方重试自愈
      return { users: [], ready: false };
    }
    suggestCache.users = ranked;
    suggestCache.ts = Date.now();
  }
  return { users: suggestCache.users.filter(u => !excluded.has(u.username)), ready: true };
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
     * 冷启动快出：page 1 只等名单前 FAST_FIRST_USERS 个账号，到位即先出一屏；
     * 其余账号在同一 inflight 里后台继续拉，追加页等全量后按未服务条目补齐（不重不漏）。
     * @returns {Promise<{illusts: object[], message?: string}>}
     */
    async feed({ page = 1, limit = 20, mode = 'foryou' } = {}) {
      // ── 直连模式（设置页配了 cookie）：登录态时间线，失败回落 Nitter ──
      // mode='foryou' → For You（算法推荐）；mode='following' → 关注（按时间序）。
      // 直连拿的是账号真实时间线（覆盖全部关注），不再依赖本地关注名单；
      // 401/403 时 xDirect 内部已置冷却，这里的 catch 之后整点内直接走 Nitter。
      if (await directReady()) {
        try {
          const { items, hasMore } = mode === 'following'
            ? await followingFeed(page)
            : await homeFeed(page);
          if (items.length || !hasMore) {
            for (const it of items) itemIndex.set(it.illustId, it);
            // hasMore 透传给面板：直连时间线「本页 0 新图」≠ 没有更多（空页已在 xDirect 内续拉），
            // 面板据此判断断流，而不是用 list.length 瞎猜。条目不 slice ——
            // xDirect 续拉聚合的一批新图可能超过 limit，截断会把已去重登记的图永久丢掉
            return { illusts: items, hasMore };
          }
        } catch (e) {
          log.debug('[feed] 直连失败，回落 nitter:', e?.message || e);
        }
      }

      const users = await configuredUsers();
      const isFirstPage = Math.max(1, page) === 1;
      // page 1 = 一次全新的浏览会话（首拉 / 下拉刷新）：清空去重表、游标归零
      if (isFirstPage) {
        servedInFeed.clear();
        feedCursor = 0;
      }
      if (!users.length) {
        return { illusts: [], message: '还没有配置关注名单：设置 → X 图源' };
      }

      // 同一时刻只允许一次全量拉取（页面切 tab 会重复触发）。
      // 快出批次与全量在同一个 inflight 里：并发不变、不重复请求，首批 settle 即放行。
      if (!inflightFeed) {
        inflightFeed = (async () => {
          // 首批就绪的 resolver 挂到模块级 releaseFastBatch（feed 侧再包装一层用于赛跑）
          new Promise((r) => { releaseFastBatch = r; });
          const [ulist, instance] = await Promise.all([configuredUsers(), customInstance()]);
          const headSet = new Set(ulist.slice(0, FAST_FIRST_USERS));
          const settled = new Set();
          const results = await mapLimit(ulist, FETCH_CONCURRENCY, async (u) => {
            const r = await fetchUser(u, instance);
            settled.add(u);
            if (headSet.delete(u) && !headSet.size) releaseFastBatch?.([...settled]);
            return r;
          });
          const lists = results.map(r => r.items);
          // 第二轮补拉：首轮失败的账号串行再来一次（实例对它们通常只是短暂限流）。
          // 这一步把「每次冷启动随机少几个号」压到基本不出现。
          const failed = ulist.filter((_, i) => !results[i].ok);
          if (failed.length) {
            log.debug(`[feed] ${ulist.length} 个账号，首轮失败 ${failed.length} 个，串行补拉`);
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
        })().finally(() => { inflightFeed = null; releaseFastBatch = null; });
      }

      // 快出与全量赛跑：首批 settle 就先用「已到位账号」的缓存合并出一屏；
      // 全量先完成（如全部命中 15min 缓存）则 fastReady 落空，自然走全量路径。
      const fastReady = releaseFastBatch
        ? new Promise((resolve) => {
          const prev = releaseFastBatch;
          releaseFastBatch = (settledUsers) => { prev?.(settledUsers); resolve(settledUsers); };
        })
        : Promise.resolve(null);
      try {
        const fastUsers = await Promise.race([
          fastReady,
          inflightFeed.then(() => null).catch(() => null),
        ]);
        if (isFirstPage && fastUsers?.length) {
          const merged = new Map();
          for (const u of fastUsers) {
            for (const item of userCache.get(u)?.items || []) {
              if (!merged.has(item.illustId)) merged.set(item.illustId, item);
            }
          }
          const sorted = [...merged.values()].sort((a, b) => b.publishedAt - a.publishedAt);
          const slice = sorted.slice(0, limit);
          if (slice.length) {
            for (const it of slice) servedInFeed.add(it.illustId);
            // 游标保持 0：全量列表从头按「未服务」推进，快出页的条目靠 servedInFeed 去重
            return { illusts: slice };
          }
          // 首批全空（实例抽风）→ 落回等全量
        }
        const all = await inflightFeed;
        if (all.length === 0) {
          return {
            illusts: [],
            message: '关注名单里没有拿到图片（实例暂时不可用，稍后下拉刷新重试）',
          };
        }
        if (isFirstPage) {
          const slice = all.slice(0, limit);
          for (const it of slice) servedInFeed.add(it.illustId);
          feedCursor = limit;
          return { illusts: slice };
        }
        // 追加页：从游标起收集未服务条目。快出会话里全量 top 与快出页部分重叠，
        // 按条目 id 去重后正好补齐快出页没覆盖的头部内容，不跳条也不重复。
        const out = [];
        while (out.length < limit && feedCursor < all.length) {
          for (const it of all.slice(feedCursor, feedCursor + limit)) {
            if (!servedInFeed.has(it.illustId)) {
              out.push(it);
              servedInFeed.add(it.illustId);
              if (out.length >= limit) break;
            }
          }
          feedCursor += limit;
        }
        return { illusts: out };
      } catch (e) {
        log.error('[feed] 失败:', e?.message || e);
        return { illusts: [], message: classifyError(e, '关注流') };
      }
    },

    /**
     * 搜索 —— 只支持按 @用户名 查看（Nitter 的关键词搜索质量太差，先不做）。
     * @returns {Promise<{images: object[], query: string, error?: string}>}
     */
    async search(query, { limit = 20, page = 1 } = {}) {
      const trimmed = String(query || '').trim();
      if (!trimmed) return { images: [], query: '' };
      const name = trimmed.match(/(?:x\.com|twitter\.com)\/@?([A-Za-z0-9_]{1,15})/i)?.[1]
        || trimmed.match(/^@?([A-Za-z0-9_]{1,15})$/)?.[1];
      const looksLikeName = name && !/^\d+$/.test(name);
      if (!looksLikeName) {
        return { images: [], query: trimmed, error: 'X 源目前只支持按 @用户名 查看，关键词搜索暂不支持' };
      }
      // ── 直连模式：SearchTimeline `from:name filter:images`（覆盖该账号全部媒体推文，
      // 不受 Nitter「最近 50 条」限制）；失败回落 Nitter RSS ──
      if (await directReady()) {
        try {
          const r = await searchFeed(`from:${name} filter:images`, page);
          if (r.items.length || !r.hasMore) {
            for (const it of r.items) itemIndex.set(it.illustId, it);
            if (r.items.length) return { images: r.items.slice(0, limit), query: trimmed };
          }
        } catch (e) {
          log.debug('[search] 直连失败，回落 nitter:', e?.message || e);
        }
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
     * 推荐博主 —— 以关注流高频 tag 为线索搜推文，聚合结果里未关注的发帖作者。
     * 会话级缓存 1 小时；失败静默返回空列表（推荐行不显示即可）。
     * @param {string[]} exclude 当前关注名单（裸 handle）
     * @returns {Promise<{users: object[], ready: boolean}>} ready=false = 内存 tag 索引
     *   还没建起来（冷启动水合态），调用方应稍后重试而不是当作「没有推荐」
     */
    async suggest(exclude = []) {
      try {
        return await suggestUsers(await customInstance(), exclude);
      } catch (e) {
        log.debug('[suggest] 失败:', e?.message || e);
        return { users: [], ready: false };
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
          authorAvatar: item.authorAvatar,
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
