/**
 * Pixiv API 共享工厂 — 所有 API 函数只写一次，平台只提供 HTTP 传输层。
 *
 * Transport 接口：
 *   fetch(pathname, opts?) → Promise<parsedJSON>  发 GET 请求，返回解析后的 JSON，失败 throw
 *   getCookie() → string | Promise<string>        当前 PHPSESSID 值（空串表示无）
 *
 * 用法：
 *   const api = createPixivApi(transport);
 *   const { images } = await api.searchPixiv('keyword');
 */

import { pixivReUrl, pixivPageUrl, pixivOriginalUrl, proxyThumb, extractUserIdFromCookie } from './utils.js';

// ── 常量 ──

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_HEADERS = {
  'Accept': 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7',
  'Referer': 'https://www.pixiv.net/',
};

// ── 数据映射 ──

/** 统一映射插画条目（API 返回 → 输出格式），兼容 camelCase 和 snake_case */
function mapIllustItem(item) {
  const illustId = String(item.illustId || item.id || item.illust_id || '');
  return {
    illustId,
    title: item.title || item.illustTitle || '',
    author: item.userName || item.user_name || item.userAccount || item.user_account || '',
    authorName: item.userName || item.user_name || '',
    authorAccount: item.userAccount || item.user_account || '',
    authorId: String(item.userId || item.user_id || ''),
    thumbnailUrl: proxyThumb(item.url || item.thumbnailUrl || item.profileImageUrl || ''),
    mediumUrl: pixivReUrl(illustId),
    originalUrl: item.originalUrl || pixivReUrl(illustId),
    tags: (item.tags || []).slice(0, 5).map(t => typeof t === 'string' ? t : (t.tag || t)),
    pixivUrl: `https://www.pixiv.net/artworks/${illustId}`,
    pageCount: parseInt(item.pageCount || item.illust_page_count) || 1,
    illustType: parseInt(item.illustType || item.illust_type) || 0,
    width: item.width || 0,
    height: item.height || 0,
  };
}

/** 映射排行榜条目（在 mapIllustItem 基础上追加排行/热度字段） */
function mapRankingItem(item) {
  return {
    ...mapIllustItem(item),
    rank: item.rank,
    viewCount: item.viewCount || item.view_count || 0,
    ratingCount: item.ratingCount || item.rating_count || 0,
  };
}

/** 映射图片页面（从 API 详情响应提取），带 original 原图档 */
function mapImagePages(basePage0Url, basePage0ThumbUrl, pageCount, baseOriginalUrl = '') {
  const images = [];
  for (let p = 0; p < pageCount; p++) {
    images.push({
      index: p,
      url: pixivPageUrl(basePage0Url, p),
      thumbnailUrl: p === 0 ? proxyThumb(basePage0ThumbUrl) : pixivPageUrl(basePage0Url, p),
      mediumUrl: pixivPageUrl(basePage0Url, p),
      originalUrl: baseOriginalUrl ? pixivOriginalUrl(baseOriginalUrl, p) : pixivPageUrl(basePage0Url, p),
    });
  }
  return images;
}

// ── 工厂 ──

export function createPixivApi(transport) {

  // ── 内部请求 ──

  /**
   * 统一 HTTP 请求。
   * @param {string} pathname — API 路径，如 '/ajax/search/artworks/...'
   * @param {Object} [opts]
   * @param {Object} [opts.headers] — 额外请求头
   * @param {number} [opts.timeout] — 超时（ms）
   * @param {boolean} [opts.skipCookie] — 跳过自动注入 Cookie
   * @returns {Promise<Object>} 解析后的 JSON
   */
  async function apiFetch(pathname, opts = {}) {
    const { headers: extraHeaders = {}, timeout, skipCookie } = opts;
    const headers = { ...DEFAULT_HEADERS, 'User-Agent': DESKTOP_UA };

    // 自动注入 Cookie（除非显式跳过）
    if (!skipCookie) {
      const cookie = await transport.getCookie();
      if (cookie) headers['Cookie'] = `PHPSESSID=${cookie}`;
    }

    Object.assign(headers, extraHeaders);

    return transport.fetch(pathname, { headers, timeout });
  }

  /** 分类错误信息，返回中文友好提示 */
  function classifyError(err, context = '') {
    if (!err) return '未知错误';
    const msg = err.message || String(err);
    // 网络错误
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('ERR_NETWORK') || msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('网络错误') || msg.includes('timeout') || msg.includes('Timeout') || msg.includes('TIMEOUT') || msg.includes('abort') || msg.includes('Abort')) {
      return `网络连接失败${context ? `（${context}）` : ''}，请检查网络或代理设置`;
    }
    // HTTP 状态码错误
    const httpMatch = msg.match(/HTTP\s+(\d+)/);
    if (httpMatch) {
      const code = parseInt(httpMatch[1]);
      if (code === 403) return 'Pixiv 拒绝访问，Cookie 可能已过期或需要更新';
      if (code === 404) return `作品未找到${context ? `（${context}）` : ''}，可能已被删除或下架`;
      if (code === 429) return '请求过于频繁，请稍后再试';
      if (code >= 500) return 'Pixiv 服务器暂时不可用，请稍后重试';
      return `请求失败（HTTP ${code}）${context ? `（${context}）` : ''}`;
    }
    // 应用层错误
    if (msg.includes('no_cookie') || msg.includes('Cookie')) return '请先在设置中填写 Pixiv Cookie (PHPSESSID)';
    if (msg.includes('auth_failed')) return 'Cookie 格式无效，请重新设置';
    if (msg.includes('not_ugoira')) return '该作品不是动图';
    if (msg.includes('no_zip_url')) return '无法获取动图数据';
    return msg;
  }

  /** 确保有 Cookie，否则返回错误对象 */
  async function ensureCookie() {
    const cookie = await transport.getCookie();
    if (!cookie) {
      return { error: 'no_cookie', message: '请先在设置中填写 Pixiv Cookie (PHPSESSID)' };
    }
    return { cookie };
  }

  // ── API 函数 ──

  // Illust 详情 LRU 缓存（避免重复调 API）
  const illustCache = new Map();
  const ILLUST_CACHE_MAX = 50;
  const ILLUST_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

  function getCachedIllust(illustId) {
    const entry = illustCache.get(illustId);
    if (!entry) return null;
    if (Date.now() - entry.time > ILLUST_CACHE_TTL) {
      illustCache.delete(illustId);
      return null;
    }
    // LRU: 删除后重新插入（移到末尾）
    illustCache.delete(illustId);
    illustCache.set(illustId, entry);
    return entry.data;
  }

  function setCachedIllust(illustId, data) {
    if (illustCache.size >= ILLUST_CACHE_MAX) {
      const firstKey = illustCache.keys().next().value;
      if (firstKey) illustCache.delete(firstKey);
    }
    illustCache.set(illustId, { data, time: Date.now() });
  }

  /** 图片搜索 */
  async function searchPixiv(query, opts = {}) {
    const { page = 1, count = 10 } = opts;
    if (!query?.trim()) return { images: [], query: '' };
    try {
      const encoded = encodeURIComponent(query.trim());
      const data = await apiFetch(
        `/ajax/search/artworks/${encoded}?word=${encoded}&order=date_d&mode=safe&p=${page}&s_mode=s_tag&type=illust_and_ugoira&lang=zh`,
        { skipCookie: true }
      );
      const illusts = data?.body?.illust?.data || data?.body?.illustManga?.data || [];
      const images = illusts.slice(0, count).map(mapIllustItem);
      return { images, query: query.trim(), total: data?.body?.illust?.total || illusts.length };
    } catch (e) {
      console.error('[searchPixiv] 失败:', e.message);
      return { images: [], query: query.trim(), error: classifyError(e, '搜索') };
    }
  }

  /** 搜索用户 */
  async function searchPixivUser(keyword) {
    if (!keyword?.trim()) return { users: [] };
    try {
      const encoded = encodeURIComponent(keyword.trim());
      const data = await apiFetch(
        `/ajax/search/user/${encoded}?word=${encoded}&order=date&mode=safe&p=1&s_mode=s_tag&lang=zh`,
        { skipCookie: true }
      );
      const users = (data?.body?.userData?.users || data?.body?.users || []).slice(0, 5).map(u => ({
        userId: String(u.userId || u.id || ''),
        name: u.userName || u.name || '',
        account: u.userAccount || u.account || '',
        avatar: u.profileImageUrl || u.userImage || '',
        worksCount: u.illustCount || u.worksCount || 0,
      }));
      return { users };
    } catch (e) {
      console.error('[searchPixivUser] 失败:', e.message);
      return { users: [], error: classifyError(e, '搜索用户') };
    }
  }

  /** 插画详情（带 LRU 缓存，5 分钟 TTL） */
  async function fetchIllust(illustId) {
    if (!illustId) return { error: '缺少 illustId' };
    // 缓存命中
    const cached = getCachedIllust(illustId);
    if (cached) return cached;
    try {
      const data = await apiFetch(`/ajax/illust/${illustId}`, { skipCookie: true });
      const body = data?.body;
      if (!body) return { illust: null, error: '未找到' };

      const pageCount = body.pageCount || 1;
      const userIllustUrl = body.userIllusts?.[String(illustId)]?.url
        || body.userIllusts?.[Object.keys(body.userIllusts || {})[0]]?.url;
      const page0Url = body.urls?.regular || body.urls?.small || body.urls?.thumb
        || body.url || userIllustUrl || '';
      const page0ThumbUrl = body.urls?.thumb || body.urls?.small || userIllustUrl || page0Url;
      const page0OriginalUrl = body.urls?.original || page0Url;

      const result = {
        illust: {
          illustId: String(body.illustId || body.id || illustId),
          title: body.title || body.illustTitle || '',
          author: body.userName || body.userAccount || '',
          authorName: body.userName || '',
          authorAccount: body.userAccount || '',
          authorId: String(body.userId || ''),
          pageCount,
          illustType: body.illustType ?? 0,
          images: mapImagePages(page0Url, page0ThumbUrl, pageCount, page0OriginalUrl),
          tags: (body.tags?.tags || []).map(t => t.tag || t).slice(0, 10),
          pixivUrl: `https://www.pixiv.net/artworks/${illustId}`,
          width: body.width || 0,
          height: body.height || 0,
          urls: body.urls || {}, // 原始分辨率 URL 供外部使用
        },
      };
      // 写入缓存
      setCachedIllust(illustId, result);
      return result;
    } catch (e) {
      console.error('[fetchIllust] 失败:', e.message);
      return { illust: null, error: classifyError(e, '作品详情') };
    }
  }

  /** 随机插画（搜索 10000users入り 然后随机选一个） */
  async function randomIllust() {
    try {
      const q = encodeURIComponent('10000users入り');
      const data = await apiFetch(
        `/ajax/search/artworks/${q}?word=${q}&order=date_d&mode=safe&p=1&s_mode=s_tag&type=illust_and_ugoira&lang=zh`,
        { skipCookie: true }
      );
      const illusts = data?.body?.illust?.data || data?.body?.illustManga?.data || [];
      if (!illusts.length) return { illust: null, error: 'no results' };

      const r = illusts[Math.floor(Math.random() * Math.min(illusts.length, 30))];
      const id = String(r.illustId || r.id);
      const pageCount = r.pageCount || 1;
      const page0Url = r.url || '';

      return {
        illust: {
          illustId: id,
          title: r.title || r.illustTitle || '',
          author: r.userName || r.userAccount || '',
          authorName: r.userName || '',
          authorAccount: r.userAccount || '',
          authorId: String(r.userId || ''),
          pageCount,
          illustType: r.illustType ?? 0,
          images: Array.from({ length: Math.min(pageCount, 6) }, (_, p) => ({
            index: p,
            url: pixivPageUrl(page0Url, p),
            thumbnailUrl: p === 0 ? proxyThumb(page0Url) : pixivPageUrl(page0Url, p),
          })),
          tags: (r.tags || []).slice(0, 5),
          pixivUrl: `https://www.pixiv.net/artworks/${id}`,
        },
      };
    } catch (e) {
      console.error('[randomIllust] 失败:', e.message);
      return { illust: null, error: classifyError(e, '随机作品') };
    }
  }

  /** 每日推荐 */
  async function fetchDiscovery(opts = {}) {
    const { limit = 10, start = 0 } = opts;
    const cookieCheck = await ensureCookie();
    if (cookieCheck.error) return { illusts: [], error: cookieCheck.error, message: cookieCheck.message };

    try {
      const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
      const data = await apiFetch(
        `/ajax/discovery/artworks?mode=all&limit=${limit}&start=${start}&lang=zh`,
        { headers }
      );

      const rawIllusts = data?.body?.illusts || data?.body?.thumbnails?.illust || [];
      const illusts = rawIllusts.map(mapIllustItem);
      return { illusts, recommendMethods: data?.body?.recommendMethods || [], hasCookie: true };
    } catch (e) {
      console.error('[fetchDiscovery] 失败:', e.message);
      return { illusts: [], error: classifyError(e, '每日推荐') };
    }
  }

  /** 作者作品列表 */
  async function fetchUserIllusts(userId, opts = {}) {
    const { limit = 30 } = opts;
    if (!userId) return { illusts: [], error: '缺少 userId' };

    const cookieCheck = await ensureCookie();
    if (cookieCheck.error) return { illusts: [], error: cookieCheck.error, message: cookieCheck.message };

    try {
      const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
      const allData = await apiFetch(
        `/ajax/user/${userId}/profile/all?lang=zh`,
        { headers }
      );

      const illustIds = Object.keys(allData?.body?.illusts || {})
        .sort((a, b) => Number(b) - Number(a))
        .slice(0, limit);

      const illusts = illustIds.map(id => ({
        illustId: id,
        title: '',
        author: '',
        authorName: '',
        authorAccount: '',
        authorId: String(userId),
        thumbnailUrl: pixivReUrl(id, 0, 'thumb'),
        mediumUrl: pixivReUrl(id),
        tags: [],
        pixivUrl: `https://www.pixiv.net/artworks/${id}`,
        pageCount: 1,
        illustType: 0,
      }));
      return { illusts, hasCookie: true };
    } catch (e) {
      console.error('[fetchUserIllusts] 失败:', e.message);
      return { illusts: [], error: classifyError(e, '作者作品') };
    }
  }

  /** 排行榜 */
  async function fetchRanking(opts = {}) {
    const { mode = 'daily', page = 1 } = opts;
    const validModes = ['daily', 'weekly', 'monthly', 'rookie', 'original', 'male', 'female',
      'daily_r18', 'weekly_r18', 'male_r18', 'female_r18', 'r18g'];
    const safeMode = validModes.includes(mode) ? mode : 'daily';
    const cookie = await transport.getCookie();

    try {
      const headers = {};
      // R-18 模式需要登录
      if (cookie) headers['Cookie'] = `PHPSESSID=${cookie}`;

      const data = await apiFetch(
        `/ranking.php?format=json&mode=${safeMode}&content=all&p=${page}`,
        { headers }
      );

      const rawIllusts = data?.contents || [];
      const illusts = rawIllusts.map(mapRankingItem);
      return { illusts, mode: safeMode, page, rankTotal: illusts.length };
    } catch (e) {
      console.error('[fetchRanking] 失败:', e.message);
      return { illusts: [], error: classifyError(e, '排行榜') };
    }
  }

  /** 收藏夹 */
  async function fetchBookmarks(opts = {}) {
    const cookieCheck = await ensureCookie();
    if (cookieCheck.error) return { error: cookieCheck.error, message: cookieCheck.message };

    const { tag = '', offset = 0, limit = 48 } = opts;

    try {
      const userId = extractUserIdFromCookie(cookieCheck.cookie);
      if (!userId) return { error: 'auth_failed', message: 'Cookie 格式无效，应为 {userId}_{token}' };

      const params = new URLSearchParams({ tag, offset: String(offset), limit: String(limit), rest: 'show' });
      const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
      const data = await apiFetch(
        `/ajax/user/${userId}/illusts/bookmarks?${params}`,
        { headers, timeout: 15000 }
      );

      const works = (data?.body?.works || []).map(item => ({
        illustId: String(item.id || item.illustId || ''),
        title: item.title || item.illustTitle || '',
        author: item.userName || item.userAccount || '',
        authorName: item.userName || '',
        authorAccount: item.userAccount || '',
        authorId: String(item.userId || ''),
        thumbnailUrl: proxyThumb(item.url || ''),
        mediumUrl: pixivReUrl(String(item.id || item.illustId)),
        originalUrl: item.originalUrl || pixivReUrl(String(item.id || item.illustId)),
        tags: (item.tags || []).slice(0, 5),
        pixivUrl: `https://www.pixiv.net/artworks/${item.id || item.illustId}`,
        pageCount: item.pageCount || 1,
        illustType: item.illustType ?? 0,
      }));

      return {
        userId: String(userId),
        total: data?.body?.total || 0,
        offset,
        works,
      };
    } catch (e) {
      console.error('[fetchBookmarks] 失败:', e.message);
      return { error: 'fetch_failed', message: classifyError(e, '收藏夹') };
    }
  }

  /** 关注画师最新作品 */
  async function fetchFollowing(opts = {}) {
    const cookieCheck = await ensureCookie();
    if (cookieCheck.error) return { error: cookieCheck.error, message: cookieCheck.message };

    const { page = 1, limit = 48 } = opts;
    try {
      const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
      const data = await apiFetch(
        `/ajax/follow_latest/illust?mode=all&p=${page}&lang=zh`,
        { headers, timeout: 15000 }
      );

      const rawIllusts = data?.body?.illusts || data?.body?.thumbnails?.illust || [];
      return {
        page,
        illusts: rawIllusts.map(mapIllustItem),
      };
    } catch (e) {
      console.error('[fetchFollowing] 失败:', e.message);
      return { illusts: [], error: classifyError(e, '关注列表') };
    }
  }

  /** 相似推荐 — 根据 illustId 获取相关作品 */
  async function fetchRelated(illustId, opts = {}) {
    const { limit = 30, start = 0 } = opts;
    if (!illustId) return { illusts: [], error: '缺少 illustId' };

    const cookieCheck = await ensureCookie();
    if (cookieCheck.error) return { illusts: [], error: cookieCheck.error, message: cookieCheck.message };

    try {
      const headers = { 'Cookie': `PHPSESSID=${cookieCheck.cookie}` };
      const data = await apiFetch(
        `/ajax/illust/${illustId}/recommend/init?limit=${limit}&start=${start}&lang=zh`,
        { headers, timeout: 15000 }
      );

      const rawIllusts = data?.body?.illusts || [];
      const illusts = rawIllusts.map(mapIllustItem);
      return { illusts, start, limit };
    } catch (e) {
      console.error('[fetchRelated] 失败:', e.message);
      return { illusts: [], error: classifyError(e, '相似推荐') };
    }
  }

  return {
    searchPixiv,
    searchPixivUser,
    fetchIllust,
    randomIllust,
    fetchDiscovery,
    fetchUserIllusts,
    fetchRanking,
    fetchBookmarks,
    fetchFollowing,
    fetchRelated,
  };
}
