/**
 * 微博适配器 —— m.weibo.cn 移动端 JSON 接口（无需登录的访客模式）。
 *
 * 接入方式（实测 2026-11-13）：
 *   - 匿名直连 API 会吃 432 风控：必须先走「访客流程」换 SUB Cookie ——
 *     POST visitor.passport.weibo.cn/visitor/genvisitor 拿 tid，
 *     GET /visitor/visitor?a=incarnate&t={tid} 从 JSONP 响应里抽 SUB/SUBP。
 *     Cookie 失效（432 / ok:-100）时自动重走一遍。
 *   - 用户媒体流：/api/container/getIndex?type=uid&value={uid}&containerid=107603{uid}
 *   - 关键词搜索：containerid=100103type=1&q={query}；用户搜索：type=3
 *   - 单条详情：/statuses/show?id={bid}（pics 自带宽高 geo，比列表还全）
 *
 * 已知限制（匿名访客模式的取舍，不是 bug）：
 *   - 所有列表接口匿名只能看第 1 页，page>=2 一律要求登录（ok:-100 跳登录）→
 *     在「设置 → 微博图源 → 登录 Cookie」粘贴浏览器 Cookie 即可解锁翻页
 *     （Cookie 失效会明确提示更新，不会静默降级）；
 *   - 关注名单是本地静态配置（UID 列表，设置页「微博图源」手填）；
 *   - 视频微博不收（本应用按静态图渲染）；转发微博收被转发者的图。
 *
 * 图床防盗链：*.sinaimg.cn 校验 Referer 必须是微博域（空 Referer 也 403）→
 *   - 统一把图片 host 归一到 tva1.sinaimg.cn（wx/ww/tva 各组域名同路径通用）；
 *   - dev 走 /weibo-img 同源代理（booru-proxy 注入 Referer）；
 *   - 真机 WebView 直链由原生层拦截补 Referer（MainActivity 的 WeiboWebViewClient）；
 *   - 下载链路由 nativeDownload 的 refererFor 补 Referer。
 */
import { CapacitorHttp } from '@capacitor/core';
import { createTransport, httpError } from '../utils/transport.js';
import { createLogger } from '../utils/logger.js';
import { isDev, isDesktopShell, getDesktopProxyPort } from '../utils/platform.js';
import { getSettings, qualifyId, rawIdOf, sourceOfId } from '../pixiv-assistant/index.js';
import { classifyError, extractPostId } from './shared.js';

const log = createLogger('weibo');

/** m.weibo.cn 按移动浏览器 UA 响应（访客流程也只认这个形态） */
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

/** 图床归一域名：wx1-4 / ww1-4 / tva1-4 同路径通用，归一后代理与原生拦截都只认一个域 */
const IMG_HOST = 'tva1.sinaimg.cn';

/** dev 下图床改走同源代理（与 pixiv 的 /pixiv-img 同模式）；桌面壳/真机走直链+原生补 Referer */
const USE_PROXY = typeof window !== 'undefined' && typeof import.meta !== 'undefined' && import.meta.env?.DEV;

/** 单账号媒体流缓存时长（匿名只有第 1 页，缓存住的「最新 10 条」短期内不会变） */
const USER_TTL = 15 * 60 * 1000;
/** 并发拉取上限：微博对访客有频控，实测并发 3~4 稳定 */
const FETCH_CONCURRENCY = 3;
/** feed 追加页时每个账号最多回源的深度（防页码深了以后请求量爆炸，缓存兜底） */
const MAX_FEED_PAGES = 5;

// ── 模块级状态：访客 Cookie / 单账号缓存 / illustId 索引 ──────────────────
let visitorCookie = '';
let visitorFetching = null;
const userCache = new Map();      // `uid:p` → { ts, items }（按账号+页码缓存）
const itemIndex = new Map();      // illustId → 条目

/** 读用户配置的登录 Cookie（设置 → 微博图源；浏览器登录 m.weibo.cn 后复制整段 Cookie 头） */
async function configuredCookie() {
  try {
    const raw = (await getSettings())?.weiboCookie || '';
    return raw.trim();
  } catch { return ''; }
}

// ── 访客流程 ────────────────────────────────────────────────────────────

/** 访客系统接口（genvisitor POST / incarnate GET），三通道与主 API 一致 */
async function passportFetch(path, { method = 'GET', headers = {}, body } = {}) {
  if (isDev() || isDesktopShell()) {
    const port = isDesktopShell() ? await getDesktopProxyPort() : 0;
    if (isDesktopShell() && !port) throw new Error('桌面代理端口不可用');
    const base = isDesktopShell() ? `http://127.0.0.1:${port}` : '';
    const res = await fetch(`${base}/weibo-passport${path}`, { method, headers, body });
    if (!res.ok) throw httpError(res.status, path);
    return await res.text();
  }
  const resp = await CapacitorHttp.request({
    method,
    url: `https://visitor.passport.weibo.cn${path}`,
    headers: { 'User-Agent': MOBILE_UA, ...headers },
    data: method === 'GET' ? undefined : body,
    connectTimeout: 15000,
    readTimeout: 15000,
  });
  if (resp.status < 200 || resp.status >= 300) throw httpError(resp.status, path);
  return typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
}

/**
 * 确保访客 Cookie 可用（并发合并；force=true 强制重走流程）。
 * 响应是 JSONP 文本（window.gen_callback && ...），正则抽字段即可。
 */
async function ensureVisitor(force = false) {
  if (visitorCookie && !force) return visitorCookie;
  if (visitorFetching) return visitorFetching;
  visitorFetching = (async () => {
    const fp = JSON.stringify({ os: '1', browser: 'Safari605', fonts: 'usafge', screenInfo: '375*667*32', plugins: '' });
    const gen = await passportFetch('/visitor/genvisitor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `cb=gen_callback&fp=${encodeURIComponent(fp)}`,
    });
    const tid = gen.match(/"tid":"([^"]+)"/)?.[1];
    if (!tid) throw new Error('微博访客 tid 获取失败');
    const inc = await passportFetch(
      `/visitor/visitor?a=incarnate&t=${encodeURIComponent(tid)}&w=2&c=095&gc=&cb=cross_domain&from=weibo&_rand=${Math.random()}`,
    );
    const sub = inc.match(/"sub":"([^"]+)"/)?.[1];
    const subp = inc.match(/"subp":"([^"]+)"/)?.[1];
    if (!sub) throw new Error('微博访客 Cookie 获取失败');
    visitorCookie = `SUB=${sub}${subp ? `; SUBP=${subp}` : ''}`;
    log.info('[ensureVisitor] 访客 Cookie 已刷新');
    return visitorCookie;
  })();
  try {
    return await visitorFetching;
  } finally {
    visitorFetching = null;
  }
}

// ── 主 API ──────────────────────────────────────────────────────────────

/**
 * 设置页关注名单 → UID 数组。
 * 接受纯数字 UID / weibo.com/u/123 / m.weibo.cn/profile/123，按空白、逗号、分号切分。
 * @param {string} raw
 * @returns {string[]}
 */
export function parseWeiboUserList(raw) {
  const uids = new Set();
  for (const token of String(raw || '').split(/[\s,;，；]+/)) {
    const t = token.trim();
    if (!t) continue;
    const fromUrl = t.match(/(?:^|\.)?(?:weibo\.cn|weibo\.com)\/(?:u|profile)\/(\d+)/i)?.[1]
      || t.match(/^https?:\/\/(?:www\.|m\.)?weibo\.(?:cn|com)\/(?:u|profile)\/(\d+)/i)?.[1];
    const bare = /^\d{5,}$/.test(t) ? t : ''; // 微博 UID 至少 5 位，避免把推文 ID 当 UID
    const uid = fromUrl || bare;
    if (uid) uids.add(uid);
  }
  return [...uids];
}

/** 读当前配置的关注名单 */
async function configuredUsers() {
  let raw = '';
  try {
    raw = (await getSettings())?.weiboUsers || '';
  } catch { /* 设置读不到就按「没配置」处理 */ }
  return parseWeiboUserList(raw);
}

// ── 数据映射 ────────────────────────────────────────────────────────────

/** HTML 片段 → 纯文本（mblog.text 是带 <a>/<br> 的富文本） */
function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * sinaimg URL 换尺寸档 + host 归一 + dev 代理改写。
 * 档位是路径第一段：thumb180 / mw690 / large / mw2000（实测同路径各档均 200）。
 * @param {string} url — API 返回的任意档位完整 URL
 * @param {string} size — 目标档位
 */
function weiboImg(url, size) {
  if (!url) return '';
  const path = String(url).replace(/^https?:\/\/[^/]+\//, '');
  const parts = path.split('/');
  if (parts.length < 2) return url;
  parts[0] = size;
  const joined = parts.join('/');
  return USE_PROXY ? `/weibo-img/${joined}` : `https://${IMG_HOST}/${joined}`;
}

/** 一张 pic → 详情页页结构（三档 URL 由路径档位派生，geo 自带宽高） */
function toPage(pic, index) {
  const large = pic?.large?.url || pic?.url || '';
  const w = Number(pic?.large?.geo?.width || pic?.geo?.width || 0);
  const h = Number(pic?.large?.geo?.height || pic?.geo?.height || 0);
  return {
    index,
    url: weiboImg(large, 'mw690'),
    previewUrl: weiboImg(large, 'thumb180'),
    thumbnailUrl: weiboImg(large, 'thumb180'),
    mediumUrl: weiboImg(large, 'mw690'),
    originalUrl: weiboImg(large, 'mw2000'),
    width: w,
    height: h,
  };
}

/**
 * 一条 mblog → 应用统一条目（与 booru 的 mapPost / nitter 的 mapItem 同形）。
 * 转发微博：pics 为空时收被转发者（retweeted_status）的图，作者也标被转发者 ——
 * 图是他发的，点作者名看他的流才符合预期。
 * @param {object} mblog
 * @returns {object|null} 无图的（纯文字/视频微博）返回 null
 */
function mapMblog(mblog) {
  const rawId = String(mblog?.id ?? '');
  if (!rawId) return null;
  const rt = mblog?.retweeted_status;
  const source = rt?.pics?.length ? rt : mblog;
  const pics = source?.pics || [];
  if (!pics.length) return null; // 视频微博（page_info）与纯文字不进图流

  const user = source?.user || mblog?.user || {};
  const pages = pics.map(toPage);
  const title = stripHtml(mblog?.text || source?.text || '').slice(0, 60);
  const tags = Array.isArray(mblog?.topic_struct)
    ? mblog.topic_struct.map(t => String(t?.title || '')).filter(Boolean)
    : [...String(mblog?.text || '').matchAll(/#([^#]{1,30})#/g)].map(m => m[1]);

  return {
    illustId: qualifyId('weibo', rawId),
    source: 'weibo',
    _pageIndex: 0,
    pageCount: pages.length,
    _totalPages: pages.length,
    // 列表项自带全部页的地址与宽高：详情页冷启动（缓存恢复后不在内存里）也能逐页渲染
    _pages: pages,
    type: 'image',
    illustType: 0,
    title,
    author: user.screen_name || '',
    authorName: user.screen_name || '',
    authorAccount: String(user.id || ''),
    authorId: String(user.id || ''),
    authorAvatar: user.avatar_hd || user.profile_image_url || '',
    tags: [...new Set(tags)].slice(0, 12),
    width: pages[0].width,
    height: pages[0].height,
    webUrl: `https://m.weibo.cn/detail/${rawId}`,
    pixivUrl: '',
    thumbnailUrl: pages[0].thumbnailUrl,
    mediumUrl: pages[0].mediumUrl,
    originalUrl: pages[0].originalUrl,
    publishedAt: Date.parse(mblog?.created_at || '') || 0,
  };
}

/** container/getIndex 响应 → 条目数组（cards 里只认带 mblog 的卡） */
function mapCards(data) {
  const cards = data?.data?.cards;
  if (!Array.isArray(cards)) return [];
  const out = [];
  for (const c of cards) {
    const item = c?.mblog ? mapMblog(c.mblog) : null;
    if (item) {
      out.push(item);
      itemIndex.set(item.illustId, item);
    }
  }
  return out;
}

/** 并发受限的 map（访客频控，别一把梭） */
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
 * 创建一个微博来源。
 * @param {{id:string, net:object}} def — registry 里的来源定义
 */
export function createWeiboSource(def) {
  const sourceId = def.id;
  const transport = createTransport({
    apiPrefix: def.net.apiPrefix,
    origin: def.net.apiOrigin,
    referer: 'https://m.weibo.cn/',
    cookieAs: 'x-weibo-cookie',
    userAgent: MOBILE_UA,
    logName: 'weibo',
  });

  /**
   * 带失效自愈的 GET。
   * Cookie 来源两级：用户配置的登录 Cookie（设置 → 微博图源）优先，否则走访客流程。
   * 失效处理按来源区分：登录 Cookie 失效不静默降级（用户应知道自己该换 Cookie 了），
   * 访客 Cookie 失效自动重走流程再试一次。
   */
  async function weiboGet(path, { retried = false } = {}) {
    const own = await configuredCookie();
    const cookie = own || await ensureVisitor();
    let data = null;
    try {
      data = await transport(path, { headers: { Cookie: cookie } });
    } catch (e) {
      if (e?.status === 432 && !retried && !own) {
        await ensureVisitor(true);
        return weiboGet(path, { retried: true });
      }
      if (e?.status === 432 && own) {
        throw new Error('登录 Cookie 已失效：到设置 → 微博图源 更新 Cookie');
      }
      throw e;
    }
    if (data?.ok !== 1) {
      if (own) {
        // 登录态下 ok:-100 只有一种解释：Cookie 过期（翻页越界是 ok:1 + 空 cards）
        throw new Error('登录 Cookie 已失效：到设置 → 微博图源 更新 Cookie');
      }
      if (!retried) {
        // ok:-100（要求登录）多半也是访客态过期：刷新一次再判定
        await ensureVisitor(true);
        return weiboGet(path, { retried: true });
      }
    }
    return data;
  }

  /**
   * 拉单个账号的媒体流指定页（匿名只有第 1 页；登录 Cookie 解锁 page>=2），带 15min 缓存。
   * 匿名态请求 page>=2 会拿到 ok:-100：返回空且不缓存（防止毒缓存挡住补 Cookie 后的翻页）。
   */
  async function fetchUserItems(uid, { page = 1 } = {}) {
    const key = `${uid}:${page}`;
    const hit = userCache.get(key);
    if (hit && Date.now() - hit.ts < USER_TTL) return hit.items;
    let path = `/api/container/getIndex?type=uid&value=${uid}&containerid=107603${uid}`;
    if (page > 1) path += `&page=${page}`;
    const data = await weiboGet(path);
    const items = data?.ok === 1 ? mapCards(data) : [];
    if (data?.ok === 1) userCache.set(key, { ts: Date.now(), items });
    return items;
  }

  /** 按关键词搜微博（登录 Cookie 下 page>=2 可用；匿名只有第 1 页） */
  async function searchPosts(query, page = 1) {
    const containerid = `100103type=1&q=${query}`;
    let path = `/api/container/getIndex?containerid=${encodeURIComponent(containerid)}&page_type=searchall`;
    if (page > 1) path += `&page=${page}`;
    const data = await weiboGet(path);
    return data?.ok === 1 ? mapCards(data) : [];
  }

  /** 按昵称搜用户（type=3），返回第一个匹配的 {uid, name, avatar} 或 null */
  async function searchUser(name) {
    const containerid = `100103type=3&q=${name}`;
    const data = await weiboGet(
      `/api/container/getIndex?containerid=${encodeURIComponent(containerid)}&page_type=searchall`,
    );
    const cards = data?.ok === 1 ? data?.data?.cards : null;
    if (!Array.isArray(cards)) return null;
    for (const c of cards) {
      for (const g of c?.card_group || []) {
        const u = g?.user;
        if (u?.id && u?.screen_name) {
          return { uid: String(u.id), name: u.screen_name, avatar: u.avatar_hd || u.profile_image_url || '' };
        }
      }
    }
    return null;
  }

  return {
    id: sourceId,
    def,
    rankingModes: [],  // 微博没有榜单概念：popular 恒返回友好错误

    /**
     * 关注流 —— 名单里所有 UID 的最新媒体，按时间倒序合并。
     * 匿名每个账号只有第 1 页（约 10 条）；配置登录 Cookie 后按需深挖到 MAX_FEED_PAGES 页
     * （缓存按「账号:页」命中，翻页不会重复回源已拉过的页）。
     * @returns {Promise<{illusts: object[], message?: string}>}
     */
    async feed({ page = 1, limit = 20 } = {}) {
      try {
        const users = await configuredUsers();
        if (!users.length) {
          return { illusts: [], message: '还没有配置关注名单：设置 → 微博图源' };
        }
        const own = await configuredCookie();
        // 匿名态翻页必拿 ok:-100：别发注定失败的请求，合并池直接耗尽（显示「没有更多」）
        const depth = own ? Math.min(Math.max(1, page), MAX_FEED_PAGES) : 1;
        const jobs = [];
        for (const uid of users) {
          for (let p = 1; p <= depth; p++) jobs.push([uid, p]);
        }
        const results = await mapLimit(jobs, FETCH_CONCURRENCY, ([uid, p]) =>
          fetchUserItems(uid, { page: p }).catch((e) => {
            log.debug(`[feed] uid=${uid} page=${p} 拉取失败:`, e?.message || e);
            return [];
          }),
        );
        // 转发/互转会让同一条微博出现在多个账号的流里：按 illustId 去重防重复卡片
        const merged = new Map();
        for (const item of results.flat()) {
          if (!merged.has(item.illustId)) merged.set(item.illustId, item);
        }
        const sorted = [...merged.values()].sort((a, b) => b.publishedAt - a.publishedAt);
        if (!sorted.length) {
          return { illusts: [], message: '关注名单里没有拿到图片（网络不稳或被限流，稍后下拉刷新重试）' };
        }
        const start = (Math.max(1, page) - 1) * limit;
        const slice = sorted.slice(start, start + limit);
        if (!slice.length && page > 1) return { illusts: [] }; // 追加页耗尽：让页面收尾显示「没有更多」
        return { illusts: slice };
      } catch (e) {
        log.error('[feed] 失败:', e?.message || e);
        return { illusts: [], message: classifyError(e, '关注流') };
      }
    },

    /**
     * 搜索 —— 三种形态（SearchPage 的 booru 翻页协议：page 从 1 递增）：
     *   纯数字 / weibo.com/u/123 链接 → 该 UID 的媒体流（详情页作者行点击走这里）；
     *   @昵称 → 用户搜索取第一个匹配，展示其媒体流；
     *   其他 → 关键词搜索。
     * 翻页在匿名态拿空（第 2 页起要求登录），配置 Cookie 后解锁。
     * @returns {Promise<{images: object[], query: string, error?: string}>}
     */
    async search(query, { page = 1, limit = 20 } = {}) {
      const trimmed = String(query || '').trim();
      if (!trimmed) return { images: [], query: '' };
      try {
        const uid = extractPostId(
          trimmed,
          /weibo\.(?:cn|com)\/(?:u|profile)\/(\d+)/i,
        );
        if (uid) {
          const items = await fetchUserItems(uid, { page });
          if (!items.length) {
            if (page > 1) return { images: [], query: trimmed }; // 翻页到底，不是错误
            return { images: [], query: trimmed, error: `UID ${uid} 没有拿到图片（账号不存在 / 无图文微博）` };
          }
          return { images: items.slice(0, limit), query: trimmed };
        }
        const handle = trimmed.match(/^@(.{1,30})$/)?.[1];
        if (handle) {
          const user = page > 1 ? null : await searchUser(handle);
          if (page > 1) {
            // @昵称流翻页：searchUser 结果没有跨请求记忆，只能第 1 页解析昵称。
            // 让页面自然停在第 1 页（返回空）——昵称流建议直接用 UID 查以获得翻页。
            return { images: [], query: trimmed };
          }
          if (!user) {
            return { images: [], query: trimmed, error: `没有找到昵称为「${handle}」的用户` };
          }
          const items = await fetchUserItems(user.uid, { page: 1 });
          if (!items.length) {
            return { images: [], query: trimmed, error: `@${user.name} 最近没有带图微博` };
          }
          return { images: items.slice(0, limit), query: trimmed };
        }
        const items = await searchPosts(trimmed, page);
        if (!items.length) {
          if (page > 1) return { images: [], query: trimmed };
          return { images: [], query: trimmed, error: `「${trimmed}」没有搜到带图微博` };
        }
        return { images: items.slice(0, limit), query: trimmed };
      } catch (e) {
        log.error('[search] 失败:', e?.message || e);
        return { images: [], query: trimmed, error: classifyError(e, '搜索') };
      }
    },

    /**
     * 微博没有排行榜 —— 诚实报错，不伪造榜单（空列表会被页面当成加载失败要求重试）。
     */
    async popular() {
      return { illusts: [], error: '微博图源没有排行榜，看「推荐」里的关注流即可' };
    },

    /**
     * 按 ID 取单条详情：先查内存索引（列表里带全量页），
     * 未命中（缓存恢复的冷条目）走 statuses/show（pics 自带宽高）。
     */
    async fetchIllust(illustId) {
      const id = sourceOfId(illustId) === sourceId ? rawIdOf(illustId) : String(illustId);
      if (!id) return { illust: null, error: '作品 ID 为空' };
      let item = itemIndex.get(qualifyId(sourceId, id));
      if (!item) {
        try {
          const data = await weiboGet(`/statuses/show?id=${id}`);
          item = data?.ok === 1 ? mapMblog(data?.data) : null;
        } catch (e) {
          log.error('[fetchIllust] 失败:', e?.message || e);
          return { illust: null, error: classifyError(e, '作品详情') };
        }
      }
      if (!item) return { illust: null, error: '作品未找到，可能已被删除' };
      return {
        illust: {
          illustId: item.illustId,
          title: item.title,
          authorName: item.authorName,
          authorAccount: item.authorAccount,
          authorId: item.authorId,
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
