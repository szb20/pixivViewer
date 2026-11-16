/**
 * Instagram 适配器 —— www.instagram.com GraphQL 接口（登录 Cookie 模式）。
 *
 * 接入方式（实测 2026-11-13）：
 *   - 老路径 /api/v1/feed/user/ 已 404 下线，现行通道是
 *     POST https://www.instagram.com/graphql/query（form 编码），两个 doc_id：
 *     29114630661562380（首屏，after=null）/ 29290744380560118（翻页，带 after）。
 *   - 必需参数：av=（cookie 里的 ds_user_id）、fb_dtsg=（任意页面 HTML 里
 *     "DTSGInitialData" 的 token，缓存约 1h）、variables={"after","before","data",
 *     "username"} + 5 个 __relay_internal__pv__* providedVariables（缺了报
 *     missing_required_variable_value）。
 *   - 必需 headers（逐头二分实测）：X-FB-Friendly-Name（首屏/翻页不同名！）、
 *     X-Csrf-Token（=cookie 的 csrftoken）、X-IG-App-ID、X-ASBD-ID；
 *     缺 X-FB-Friendly-Name 会返回 403 + "Page Not Found" HTML（不是 JSON 错误，
 *     极易误判成限流/doc_id 失效）。Sec-Fetch-* / Origin / Referer / 桌面 Chrome UA
 *     也一并发送求稳（dev 下由 booru-proxy 注入 Sec-Fetch 与 Origin）。
 *   - 响应：data.xdt_api__v1__feed__user_timeline_graphql_connection →
 *     edges[].node（v1 media 对象）+ page_info.{has_next_page,end_cursor}。
 *
 * 主页时间线（2026-11-13 实测，推荐页数据源）：
 *   - POST /api/v1/feed/timeline/（form 编码），登录账号的真实首页 feed；
 *   - 与 graphql 不同，_csrftoken 必须放 form body 里（只放 X-Csrf-Token 头
 *     会报 "CSRF token missing or incorrect"），另需 X-FB-LSD 头（首页 HTML
 *     的 LSD token，与 fb_dtsg 一起提取缓存）+ X-FB-Friendly-Name:
 *     PolarisWebHomeFeed；翻页传 max_id=上页 next_max_id（首屏 reason=25、
 *     翻页 reason=30）；
 *   - 每页只有 4-6 条 feed_items，还混着 ad / explore_story 填充项（没有
 *     media_or_ad 字段，自然被 mapNode 跳过）→ feed 需要逐层深挖；
 *   - feed_items[].media_or_ad 与用户时间线的 node 同构（v1 media），mapNode
 *     直接复用。
 *
 * 已知限制（MVP 的取舍，不是 bug）：
 *   - 必须配置登录 Cookie（设置 → Instagram 图源），没有匿名访客通道；
 *   - 搜索只支持用户名 / 主页链接（无标签搜索接口可用）；
 *   - 视频帖（media_type 2）跳过不收；轮播（media_type 8）收全部页；
 *   - 图片 URL 带 oe= 签名时效参数，缓存条目放几小时会过期 → 列表缓存 TTL
 *     压到 10min，过期后下拉刷新拉新列表即可。
 *
 * 风控：连续请求约 4-6 次触发临时 403（约 10min 冷却）→ 全局限速串行队列
 *   （请求间隔 ≥2.2s），403 时明确提示「稍后再试」而不是静默重试火上浇油。
 *
 * 图床：instagram.f*.fna.fbcdn.net / scontent.cdninstagram.com 直链无防盗链，
 * 但被墙 —— 手机必须开 Clash VPN 模式；dev 下改走 /ig-img/<host>/... 同源代理
 * （booru-proxy 的动态 host 路由，host 白名单只放行 fbcdn.net / cdninstagram.com）。
 */
import { createTransport } from '../utils/transport.js';
import { createLogger } from '../utils/logger.js';
import { getSettings, qualifyId, rawIdOf, sourceOfId } from '../pixiv-assistant/index.js';
import { classifyError, extractPostId, CHROME_DESKTOP_UA } from './shared.js';

const log = createLogger('instagram');

/** dev 下图床改走同源代理（fbcdn 被墙且 host 动态，见 booru-proxy 的 /ig-img 路由） */
const USE_PROXY = typeof window !== 'undefined' && typeof import.meta !== 'undefined' && import.meta.env?.DEV;

/** fb_dtsg 缓存时长（约 1h 有效，提前 5min 过期） */
const DTSG_TTL = 55 * 60 * 1000;
/** 单账号列表缓存：URL 带 oe= 签名时效，压短到 10min */
const USER_TTL = 10 * 60 * 1000;
/** 上游请求最小间隔（风控：连续 4-6 次快请求会触发 ~10min 的 403 冷却） */
const MIN_INTERVAL = 2200;
/** feed 每个账号最多回源的深度（2.2s 限速下 5 次请求 ≈ 11s，再深风控风险高） */
const MAX_FEED_PAGES = 5;
/** 主页时间线单次调用最多回源的深度（每页只有 4-6 条且混填充项，视频过滤后约 2-3 张图/页） */
const MAX_HOME_PAGES = 12;
/** feed 拉取并发（串行队列 + 间隔限速下，并发只是流水线深度） */
const FETCH_CONCURRENCY = 2;
/** 每页条数（IG 接口固定 count:12，这里只做应用层切片） */
const IG_PAGE_COUNT = 12;

// ── 模块级状态：fb_dtsg + LSD / 限速队列 / 单账号缓存 / illustId 索引 ──────
let dtsg = { token: '', lsd: '', ts: 0 };
let dtsgFetching = null;
const userCache = new Map();      // `username:p` → { ts, items, endCursor, hasMore }
const itemIndex = new Map();      // illustId → 条目

// ── 限速：全局串行队列，保证任意两次上游请求间隔 ≥ MIN_INTERVAL ──────────
let gateChain = Promise.resolve();
let lastRequestAt = 0;
function igGate() {
  const step = () => new Promise((resolve) => {
    const delay = Math.max(0, lastRequestAt + MIN_INTERVAL - Date.now());
    setTimeout(() => { lastRequestAt = Date.now(); resolve(); }, delay);
  });
  gateChain = gateChain.then(step, step);
  return gateChain;
}

// ── 用户配置 ────────────────────────────────────────────────────────────

/** 读用户配置的登录 Cookie（设置 → Instagram 图源；浏览器登录后复制整段 Cookie 头） */
async function configuredCookie() {
  try {
    const raw = (await getSettings())?.instagramCookie || '';
    return raw.trim();
  } catch { return ''; }
}

/**
 * 设置页关注名单 → 用户名数组。
 * 接受纯用户名 / @用户名 / instagram.com/<用户名> 链接，按空白、逗号、分号切分。
 * @param {string} raw
 * @returns {string[]}
 */
export function parseInstagramUserList(raw) {
  const names = new Set();
  for (const token of String(raw || '').split(/[\s,;，；]+/)) {
    const t = token.trim();
    if (!t) continue;
    // 主页链接：instagram.com/<username>（排除 p/reel/explore 等功能路径）
    const fromUrl = t.match(/^https?:\/\/(?:www\.)?(?:instagram|instagr)\.am\/([A-Za-z0-9._]{1,30})\/?$/i)?.[1]
      || t.match(/^(?:www\.)?(?:instagram\.com|instagr\.am)\/([A-Za-z0-9._]{1,30})\/?$/i)?.[1];
    // @handle 或裸用户名
    const handle = t.match(/^@([A-Za-z0-9._]{1,30})$/)?.[1];
    const bare = /^[A-Za-z0-9._]{1,30}$/.test(t) ? t : '';
    const name = (fromUrl && !['p', 'reel', 'explore', 'stories', 'accounts', 'direct', 'tv'].includes(fromUrl.toLowerCase())
      ? fromUrl : '') || handle || bare;
    if (name) names.add(name.toLowerCase());
  }
  return [...names];
}

/** 读当前配置的关注名单 */
async function configuredUsers() {
  let raw = '';
  try {
    raw = (await getSettings())?.instagramUsers || '';
  } catch { /* 设置读不到就按「没配置」处理 */ }
  return parseInstagramUserList(raw);
}

// ── 数据映射 ────────────────────────────────────────────────────────────

/**
 * fbcdn 直链 → 当前环境可用地址。dev 下改写为 /ig-img/<host>/<path> 同源代理
 * （host 动态：instagram.f*.fna.fbcdn.net 有几十个分区域，枚举不完）。
 */
function igImg(url) {
  if (!url) return '';
  if (!USE_PROXY) return url;
  try {
    const u = new URL(url);
    return `/ig-img/${u.hostname}${u.pathname}${u.search}`;
  } catch { return url; }
}

/**
 * 从 image_versions2.candidates 里挑目标宽度最近的档。
 * candidates 里混着「原比例多档」和「方形填充档」（1080x1080/750x750…），
 * 先按最大档的宽高比过滤掉方形的，再按宽度就近取。
 */
function pickCandidate(candidates, targetWidth) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => (b.width || 0) - (a.width || 0));
  const main = sorted[0];
  const ratio = main.width / Math.max(1, main.height);
  const sameShape = sorted.filter((c) => Math.abs(c.width / Math.max(1, c.height) - ratio) / ratio < 0.03);
  const pool = sameShape.length ? sameShape : sorted;
  let best = pool[0];
  let bestDiff = Math.abs((pool[0].width || 0) - targetWidth);
  for (const c of pool) {
    const diff = Math.abs((c.width || 0) - targetWidth);
    if (diff < bestDiff) { best = c; bestDiff = diff; }
  }
  return best;
}

/** 一页媒体（单图或轮播里的一页）→ 详情页页结构 */
function toPage(media, index) {
  const candidates = media?.image_versions2?.candidates || [];
  const large = pickCandidate(candidates, 9999) || {};
  const medium = pickCandidate(candidates, 720) || large;
  const small = pickCandidate(candidates, 480) || medium;
  return {
    index,
    url: igImg(medium.url),
    previewUrl: igImg(small.url),
    thumbnailUrl: igImg(small.url),
    mediumUrl: igImg(medium.url),
    originalUrl: igImg(large.url),
    width: Number(large.width || 0),
    height: Number(large.height || 0),
  };
}

/**
 * 一条 v1 media 对象 → 应用统一条目（与 booru 的 mapPost / weibo 的 mapMblog 同形）。
 * @param {object} node — edges[].node
 * @returns {object|null} 视频帖（media_type 2）与无图节点返回 null
 */
function mapNode(node) {
  const rawId = String(node?.pk ?? '');
  if (!rawId) return null;
  if (Number(node?.media_type) === 2) return null; // 视频帖不进图流
  const carousel = Array.isArray(node?.carousel_media) ? node.carousel_media : null;
  const pages = carousel?.length
    ? carousel.map((m, i) => toPage(m, i))
    : [toPage(node, 0)];
  if (!pages[0]?.url) return null;

  const user = node?.user || {};
  const username = String(user.username || '');
  const caption = String(node?.caption?.text || '');
  const tags = [...caption.matchAll(/#([^\s#]{1,30})/g)].map((m) => m[1]);

  return {
    illustId: qualifyId('instagram', rawId),
    source: 'instagram',
    _pageIndex: 0,
    pageCount: pages.length,
    _totalPages: pages.length,
    // 列表项自带全部页的地址与宽高：详情页冷启动（缓存恢复后不在内存里）也能逐页渲染
    _pages: pages,
    type: 'image',
    illustType: 0,
    title: caption.replace(/\s+/g, ' ').trim().slice(0, 60),
    author: user.full_name || username,
    authorName: user.full_name || username,
    authorAccount: username,
    authorId: String(user.pk || ''),
    authorAvatar: igImg(user.profile_pic_url || ''),
    tags: [...new Set(tags)].slice(0, 12),
    width: pages[0].width,
    height: pages[0].height,
    webUrl: `https://www.instagram.com/p/${node?.code || ''}/`,
    pixivUrl: '',
    thumbnailUrl: pages[0].thumbnailUrl,
    mediumUrl: pages[0].mediumUrl,
    originalUrl: pages[0].originalUrl,
    publishedAt: Number(node?.taken_at || 0) * 1000,
  };
}

/** connection 响应 → { items, endCursor, hasMore } */
function mapConnection(conn) {
  const edges = Array.isArray(conn?.edges) ? conn.edges : [];
  const items = [];
  for (const e of edges) {
    const item = e?.node ? mapNode(e.node) : null;
    if (item) {
      items.push(item);
      itemIndex.set(item.illustId, item);
    }
  }
  return {
    items,
    endCursor: conn?.page_info?.end_cursor || '',
    hasMore: conn?.page_info?.has_next_page === true,
  };
}

/** 并发受限的 map（配合全局限速队列使用） */
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
 * 创建一个 Instagram 来源。
 * @param {{id:string, net:object}} def — registry 里的来源定义
 */
export function createInstagramSource(def) {
  const sourceId = def.id;
  const transport = createTransport({
    apiPrefix: def.net.apiPrefix,
    origin: def.net.apiOrigin,
    referer: 'https://www.instagram.com/',
    cookieAs: 'x-ig-cookie',
    userAgent: CHROME_DESKTOP_UA,
    logName: 'instagram',
  });

  /** 抓首页 HTML 提取 fb_dtsg 与 LSD token（任意页面都有，缓存 ~1h，并发合并）。
   *  必须带登录 Cookie 请求：匿名首页的 DTSGInitialData 是空对象，取不到 token。
   *  LSD 供主页时间线接口的 X-FB-LSD 头使用。 */
  async function ensureDtsg(force = false) {
    if (!force && dtsg.token && Date.now() - dtsg.ts < DTSG_TTL) return dtsg;
    if (dtsgFetching) return dtsgFetching;
    dtsgFetching = (async () => {
      const cookie = await configuredCookie();
      await igGate();
      const html = await transport('/', {
        raw: true,
        timeout: 20000,
        headers: cookie ? { Cookie: cookie } : {},
      });
      const token = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/)?.[1];
      if (!token) throw new Error('Instagram fb_dtsg 获取失败（Cookie 可能已失效，到设置 → Instagram 图源更新）');
      const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1] || '';
      dtsg = { token, lsd, ts: Date.now() };
      log.info('[ensureDtsg] fb_dtsg 已刷新');
      return dtsg;
    })();
    try {
      return await dtsgFetching;
    } finally {
      dtsgFetching = null;
    }
  }

  /**
   * 拉某账号时间线的指定页（1 起数；page>1 需要前一页的 end_cursor，
   * 前一页不在缓存时会自动先拉前面的页），带 10min 缓存。
   * @returns {Promise<{items:object[], endCursor:string, hasMore:boolean}>}
   */
  async function fetchUserTimeline(username, page = 1) {
    const key = `${username}:${page}`;
    const hit = userCache.get(key);
    if (hit && Date.now() - hit.ts < USER_TTL) return hit;
    let after = null;
    if (page > 1) {
      const prev = await fetchUserTimeline(username, page - 1);
      if (!prev.endCursor || !prev.hasMore) {
        return { items: [], endCursor: '', hasMore: false }; // 前一页已到底
      }
      after = prev.endCursor;
    }
    const result = await igQuery(username, after);
    userCache.set(key, { ts: Date.now(), ...result });
    return result;
  }

  /**
   * 发一次 GraphQL 查询（form 编码 POST，raw 文本返回自行解析）。
   * 请求形状是逐头二分验证出来的（2026-11-13 实测，缺一即 403 "Page Not Found"）：
   *   - X-FB-Friendly-Name 必需，且首屏/翻页不同名（见 friendlyName）；
   *   - variables 必须带 5 个 __relay_internal__pv__* providedVariables
   *     （缺了是 GraphQL 层 missing_required_variable_value）；
   *   - X-Csrf-Token 必须等于 cookie 里的 csrftoken。
   * 响应形态三分：正常 JSON / for (;;); 包裹的错误 JSON / HTML 页，分别给出可操作信息。
   */
  async function igQuery(username, after) {
    const cookie = await configuredCookie();
    if (!cookie) throw new Error('还没有配置 Instagram 登录 Cookie：设置 → Instagram 图源');
    const av = cookie.match(/ds_user_id=(\d+)/)?.[1] || '0';
    const csrf = cookie.match(/csrftoken=([^;\s]+)/)?.[1] || '';
    const { token } = await ensureDtsg();
    const variables = JSON.stringify({
      after,
      before: null,
      data: {
        count: IG_PAGE_COUNT,
        include_reel_media_seen_timestamp: true,
        include_relationship_info: true,
        latest_besties_reel_media: false,
        latest_reel_media: true,
      },
      // 翻页查询的 variables 还要求这三个字段（浏览器原样如此）
      ...(after ? { first: IG_PAGE_COUNT, include_multi_captions: true, last: null } : {}),
      username,
      // Relay providedVariables：查询声明了就必须给值，缺了报 missing_required_variable_value
      '__relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider': true,
      '__relay_internal__pv__PolarisShortDramaEnabledrelayprovider': true,
      '__relay_internal__pv__PolarisSEOIsCrawlerrelayprovider': false,
      '__relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider': false,
      '__relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider': false,
    });
    // 首屏与翻页是两个不同的持久化查询（doc_id 与 friendly name 配对使用）
    const isPage2 = Boolean(after);
    const docId = isPage2 ? '29290744380560118' : '29114630661562380';
    const friendlyName = isPage2 ? 'PolarisProfilePostsTabContentQuery_connection' : 'PolarisProfilePostsQuery';
    const body = `av=${encodeURIComponent(av)}&doc_id=${docId}`
      + `&variables=${encodeURIComponent(variables)}&fb_dtsg=${encodeURIComponent(token)}`
      + `&__d=www&__user=0&__a=1&dpr=2`;

    await igGate();
    let text;
    try {
      text = await transport('/graphql/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
          // dev 下 Origin 是浏览器禁设头（fetch 静默丢弃），由 booru-proxy 的
          // /ig-api extraHeaders 注入；prod（CapacitorHttp）这里直发
          Origin: 'https://www.instagram.com',
          'X-ASBD-ID': '359341',
          'X-IG-App-ID': '936619743392459',
          'X-Csrf-Token': csrf,
          'X-FB-Friendly-Name': friendlyName,
          'X-Requested-With': 'XMLHttpRequest',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
        body,
        raw: true,
        timeout: 20000,
      });
    } catch (e) {
      if (e?.status === 403 || e?.status === 429) {
        throw new Error('Instagram 限流了（连续请求过多）：等约 10 分钟再下拉刷新');
      }
      if (e?.status === 401) {
        throw new Error('Instagram Cookie 已失效：到设置 → Instagram 图源更新 Cookie');
      }
      throw e;
    }

    let data;
    try {
      const jsonText = String(text).replace(/^for\s*\(;;\);/, '');
      data = JSON.parse(jsonText);
    } catch {
      throw new Error('Instagram 返回了登录页：Cookie 已失效，到设置 → Instagram 图源更新');
    }
    if (data?.error) {
      // 1357054 = 缺 Sec-Fetch 头的挑战；其余 error 形态一并按风控处理
      log.warn('[igQuery] error:', JSON.stringify(data.error).slice(0, 200));
      throw new Error(`Instagram 拒绝了请求（${data.error?.code || data.error?.type || 'unknown'}）：稍后再试`);
    }
    const conn = data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    if (!conn) {
      throw new Error(`用户 @${username} 没有拿到时间线（账号不存在 / 私密 / Cookie 失效）`);
    }
    return mapConnection(conn);
  }

  /**
   * 发一次主页时间线请求（登录账号的真实首页 feed）。
   * 请求形状 2026-11-13 实测：POST /api/v1/feed/timeline/，form 编码，
   * _csrftoken 必须在 body 里（只放 X-Csrf-Token 头报 CSRF missing），
   * X-FB-LSD 必填（首页 HTML 的 LSD token），X-FB-Friendly-Name 固定
   * PolarisWebHomeFeed；翻页带 max_id（=上页 next_max_id），reason 首屏 25 /
   * 翻页 30。feed_items 里的 ad / explore_story 填充项没有 media_or_ad，
   * mapNode 返回 null 自然跳过。
   * @param {string} maxId — 翻页游标（首屏传空）
   * @returns {Promise<{items:object[], endCursor:string, hasMore:boolean}>}
   */
  async function homeQuery(maxId = '') {
    const cookie = await configuredCookie();
    if (!cookie) throw new Error('还没有配置 Instagram 登录 Cookie：设置 → Instagram 图源');
    const csrf = cookie.match(/csrftoken=([^;\s]+)/)?.[1] || '';
    const { lsd } = await ensureDtsg();
    const body = `_csrftoken=${encodeURIComponent(csrf)}`
      + `&reason=${maxId ? 30 : 25}&is_pull_to_refresh=0`
      + (maxId ? `&max_id=${encodeURIComponent(maxId)}` : '');

    await igGate();
    let data;
    try {
      const text = await transport('/api/v1/feed/timeline/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookie,
          Origin: 'https://www.instagram.com',
          'X-ASBD-ID': '359341',
          'X-IG-App-ID': '936619743392459',
          'X-Csrf-Token': csrf,
          'X-FB-Friendly-Name': 'PolarisWebHomeFeed',
          'X-FB-LSD': lsd,
          'X-Requested-With': 'XMLHttpRequest',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
        body,
        raw: true,
        timeout: 25000,
      });
      data = JSON.parse(text);
    } catch (e) {
      if (e?.status === 403 || e?.status === 429) {
        throw new Error('Instagram 限流了（连续请求过多）：等约 10 分钟再下拉刷新');
      }
      if (e?.status === 401) {
        throw new Error('Instagram Cookie 已失效：到设置 → Instagram 图源更新 Cookie');
      }
      throw e;
    }
    if (data?.status === 'fail' || data?.error) {
      // 实测 CSRF 失配 / 登录态失效走这个形态（{"message":...,"status":"fail"}）
      const msg = data?.message || data?.error?.message || JSON.stringify(data).slice(0, 120);
      log.warn('[homeQuery] fail:', msg);
      throw new Error(`Instagram 主页时间线被拒绝（${msg}）：Cookie 可能已失效，到设置 → Instagram 图源更新`);
    }
    const feedItems = Array.isArray(data?.feed_items) ? data.feed_items : null;
    if (!feedItems) {
      throw new Error('Instagram 主页时间线返回异常（Cookie 可能已失效，到设置 → Instagram 图源更新）');
    }
    const items = [];
    for (const it of feedItems) {
      const item = it?.media_or_ad ? mapNode(it.media_or_ad) : null;
      if (item) {
        items.push(item);
        itemIndex.set(item.illustId, item);
      }
    }
    return {
      items,
      endCursor: data?.next_max_id || '',
      hasMore: data?.more_available === true,
    };
  }

  /**
   * 主页时间线分页拉取（1 起数；page>1 需要前一页的 next_max_id，
   * 前一页不在缓存时会自动先拉前面的页），带 10min 缓存。
   * 缓存键 '@home:页' —— '@' 不会出现在用户名里，与账号时间线的键不冲突。
   */
  async function fetchHomeTimeline(page = 1) {
    const key = `@home:${page}`;
    const hit = userCache.get(key);
    if (hit && Date.now() - hit.ts < USER_TTL) return hit;
    let maxId = '';
    if (page > 1) {
      const prev = await fetchHomeTimeline(page - 1);
      if (!prev.endCursor || !prev.hasMore) {
        return { items: [], endCursor: '', hasMore: false }; // 前一页已到底
      }
      maxId = prev.endCursor;
    }
    const result = await homeQuery(maxId);
    userCache.set(key, { ts: Date.now(), ...result });
    return result;
  }

  return {
    id: sourceId,
    def,
    rankingModes: [],  // IG 没有榜单概念：popular 恒返回友好错误

    /**
     * 推荐流 —— 配了登录 Cookie 就用账号的真实主页时间线（首页刷到的内容），
     * 主页流失败/为空时回退到本地关注名单的合并流。IG 风控严格（全局限速
     * 2.2s/次），两种模式都受同一限速队列保护。
     *
     * 分页语义是「合并池的 limit 窗口切片」，而 IG 的页产出条数不定（主页流
     * 每页 4-6 条还混填充项，账号流一页 12 条里视频占比不定），所以不能按
     * 「page = 回源深度」对应 —— 改为逐层深挖：合并条目不足 page×limit 就
     * 继续拉下一页，直到攒够 / 到底 / 触到深度上限。缓存按页命中，深挖不
     * 重复回源已拉过的页。
     * @returns {Promise<{illusts: object[], message?: string}>}
     */
    async feed({ page = 1, limit = 20 } = {}) {
      try {
        const cookie = await configuredCookie();

        // ── 主页时间线（真实 feed）──
        if (cookie) {
          try {
            // 首屏只攒 12 条（≈5-6 页 ≈ 13s）就先出图，剩下的靠滚动追加页深挖
            // ——主页流每页产出少，一次挖满 20 条要 30s+，首屏等不起
            const want = page === 1 ? Math.min(limit, 12) : Math.max(1, page) * limit;
            const merged = new Map();
            let exhausted = false;
            for (let depth = 1; depth <= MAX_HOME_PAGES; depth++) {
              const r = await fetchHomeTimeline(depth).catch((e) => {
                log.debug(`[feed] home page=${depth} 拉取失败:`, e?.message || e);
                return null;
              });
              if (!r) break; // 主页流是单链翻页：这一页断了后面也接不上
              for (const item of r.items) {
                if (!merged.has(item.illustId)) merged.set(item.illustId, item);
              }
              if (!r.hasMore) { exhausted = true; break; }
              if (merged.size >= want) break;
            }
            const sorted = [...merged.values()].sort((a, b) => b.publishedAt - a.publishedAt);
            if (sorted.length) {
              const start = (Math.max(1, page) - 1) * limit;
              const slice = sorted.slice(start, start + limit);
              if (slice.length) return { illusts: slice };
              if (page > 1) return { illusts: [] }; // 追加页耗尽：让页面收尾显示「没有更多」
              // page=1 切空但池子非空不可能发生（start=0），防御性落空走下面的兜底
            } else if (!exhausted) {
              // 拿到了响应但全是视频/填充 → 空池：落到关注名单模式再试一把
              log.info('[feed] 主页时间线没有图片帖，回退关注名单模式');
            }
          } catch (e) {
            log.warn('[feed] 主页时间线失败，回退关注名单模式:', e?.message || e);
          }
        }

        // ── 关注名单合并流（兜底 / 未配 Cookie 时的主模式）──
        const users = await configuredUsers();
        if (!users.length) {
          return {
            illusts: [],
            message: cookie
              ? '主页时间线与关注名单都没有拿到图片（可能被限流，等约 10 分钟再试）'
              : '还没有配置 Instagram 登录 Cookie：设置 → Instagram 图源',
          };
        }
        const want = Math.max(1, page) * limit;
        const merged = new Map();
        for (let depth = 1; depth <= MAX_FEED_PAGES; depth++) {
          // 第 2 层起只深挖「上一页还有更多」的账号；上一页拉失败的账号没进缓存，也跳过
          const names = depth === 1
            ? users
            : users.filter((n) => userCache.get(`${n}:${depth - 1}`)?.hasMore);
          if (!names.length) break;
          const results = await mapLimit(names.map((n) => [n, depth]), FETCH_CONCURRENCY, ([name, p]) =>
            fetchUserTimeline(name, p).then((r) => r.items).catch((e) => {
              log.debug(`[feed] @${name} page=${p} 拉取失败:`, e?.message || e);
              return null;
            }),
          );
          for (const items of results) {
            if (!items) continue;
            for (const item of items) {
              if (!merged.has(item.illustId)) merged.set(item.illustId, item);
            }
          }
          if (merged.size >= want) break;
        }
        const sorted = [...merged.values()].sort((a, b) => b.publishedAt - a.publishedAt);
        if (!sorted.length) {
          return {
            illusts: [],
            message: cookie
              ? '主页时间线与关注名单都没有拿到图片（可能被限流，等约 10 分钟再试）'
              : '还没有配置 Instagram 登录 Cookie：设置 → Instagram 图源',
          };
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
     * 搜索 —— 两种形态（SearchPage 的 booru 翻页协议：page 从 1 递增）：
     *   instagram.com/<用户名> 链接 / @用户名 / 裸用户名 → 该用户的时间线。
     * IG 没有可用的标签搜索接口，其他输入直接提示不支持。
     * @returns {Promise<{images: object[], query: string, error?: string}>}
     */
    async search(query, { page = 1, limit = 20 } = {}) {
      const trimmed = String(query || '').trim();
      if (!trimmed) return { images: [], query: '' };
      try {
        const fromUrl = extractPostId(
          trimmed,
          /(?:instagram\.com|instagr\.am)\/([A-Za-z0-9._]{1,30})/i,
        );
        const handle = trimmed.match(/^@?([A-Za-z0-9._]{1,30})$/)?.[1];
        const name = (fromUrl && !['p', 'reel', 'explore', 'stories', 'accounts', 'direct', 'tv'].includes(fromUrl.toLowerCase())
          ? fromUrl : handle)?.toLowerCase();
        if (!name) {
          return { images: [], query: trimmed, error: 'Instagram 图源搜索只支持用户名（或主页链接）' };
        }
        const result = await fetchUserTimeline(name, page);
        if (!result.items.length) {
          if (page > 1) return { images: [], query: trimmed }; // 翻页到底，不是错误
          return { images: [], query: trimmed, error: `@${name} 没有拿到图片（账号不存在 / 私密 / 最近没发图帖）` };
        }
        return { images: result.items.slice(0, limit), query: trimmed };
      } catch (e) {
        log.error('[search] 失败:', e?.message || e);
        return { images: [], query: trimmed, error: classifyError(e, '搜索') };
      }
    },

    /**
     * IG 没有排行榜 —— 诚实报错，不伪造榜单（空列表会被页面当成加载失败要求重试）。
     */
    async popular() {
      return { illusts: [], error: 'Instagram 图源没有排行榜，看「推荐」里的关注流即可' };
    },

    /**
     * 按 ID 取单条详情：只查内存索引（列表项自带全部页的地址与宽高）。
     * 未命中（缓存恢复的冷条目）时诚实报错 —— IG 没有稳定的单帖接口可回源。
     */
    async fetchIllust(illustId) {
      const id = sourceOfId(illustId) === sourceId ? rawIdOf(illustId) : String(illustId);
      if (!id) return { illust: null, error: '作品 ID 为空' };
      const item = itemIndex.get(qualifyId(sourceId, id));
      if (!item) {
        return { illust: null, error: '作品详情不在缓存里（列表刷新后重进即可）' };
      }
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
