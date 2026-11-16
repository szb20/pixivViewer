/**
 * X (Twitter) 第一方 GraphQL 直连客户端 —— cookie 登录态优先，Nitter 只作兜底。
 *
 * 为什么直连：
 *   - Nitter 实例 2026 年大面积限流（403/429），RSS 只覆盖每账号最近约 50 条；
 *   - 用户自己有 X 账号：auth_token + ct0 两个 cookie 就能以 x-web 的身份调
 *     第一方 GraphQL，拿到完整的登录态时间线（For You / 搜索都可用）。
 *
 * 请求格式（2026-11-13 CDP 实测抓包，与 x-web 自身调用逐字节一致）：
 *   GET https://x.com/i/api/graphql/{queryId}/{OperationName}
 *       ?variables=…&features=…&fieldToggles=…
 *   headers: Authorization: Bearer {公开 web bearer}、Cookie、X-Csrf-Token: {ct0}、桌面 UA
 *
 * queryId / features 会随 x-web 发版漂移：内置一份已知值；401/404 时自动重提取
 * （从 x.com 首页 HTML → loader chunk → 业务 chunk 里 grep），再失败就抛错，
 * 由 nitter.js 回落到 Nitter 老路 —— 直连永远只是「锦上添花」，不是单点依赖。
 *
 * 安全注意：cookie 只存本机 settings（localStorage），绝不进 git / 代码仓库。
 */
import { CapacitorHttp } from '@capacitor/core';
import { createLogger } from '../utils/logger.js';
import { isNative } from '../utils/platform.js';
import { getSettings, qualifyId } from '../pixiv-assistant/index.js';

const log = createLogger('x-direct');

/** x-web 的公开 Bearer（匿名常量，非机密；失配时 401 code 89，触发自动重提取） */
const DEFAULT_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/** GraphQL queryId（2026-11-13 抓包；漂移时 404，触发自动重提取） */
const DEFAULT_QIDS = {
  HomeTimeline: 'KmJCeZ__ef1fNos7tKN_fg',
  HomeLatestTimeline: 'IVA5BUbeYPTrpYekQH7jiA', // 关注时间线（x-web 实测走 POST，参数在 body）
  SearchTimeline: 'vLHjqbDv7TPFMBkIIO1nOA',
};

/**
 * features 开关表 —— 与 x-web 自身请求逐字段一致（2026-11-13 抓包）。
 * 这张表缺失关键字段时 API 直接 400，所以整表原样携带，不做删减。
 */
const FEATURES = '{"rweb_video_screen_enabled":false,"rweb_cashtags_enabled":true,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_profile_redirect_enabled":true,"rweb_tipjar_consumption_enabled":false,"verified_phone_label_enabled":false,"creator_subscriptions_tweet_preview_api_enabled":true,"responsive_web_graphql_timeline_navigation_enabled":true,"premium_content_api_read_enabled":false,"communities_web_enable_tweet_community_results_fetch":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":true,"rweb_cashtags_composer_attachment_enabled":true,"responsive_web_jetfuel_frame":true,"rweb_sports_post_context_enabled":true,"x_elections_post_context_enabled":true,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_annotations_enabled":true,"articles_preview_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"rweb_conversational_replies_downvote_enabled":false,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"view_counts_everywhere_api_enabled":true,"longform_notetweets_consumption_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"content_disclosure_indicator_enabled":true,"content_disclosure_ai_generated_indicator_enabled":true,"responsive_web_grok_show_grok_translated_post":true,"responsive_web_grok_analysis_button_from_backend":true,"post_ctas_fetch_enabled":false,"freedom_of_speech_not_reach_fetch_enabled":true,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"longform_notetweets_rich_text_read_enabled":true,"longform_notetweets_inline_media_enabled":false,"responsive_web_nested_quote_preview_enabled":true,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_grok_imagine_annotation_enabled":true,"responsive_web_made_on_x_label_enabled":false,"responsive_web_grok_community_note_auto_translation_is_enabled":true,"responsive_web_enhance_cards_enabled":false}';

/** HomeLatestTimeline 走 POST，features 需要成对象放 body —— 预解析一次 */
const FEATURES_OBJ = JSON.parse(FEATURES);

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 首页时间线 / 搜索的首拉缓存（秒出 + 防高频）：登录态接口经不起刷 */
const FIRST_PAGE_TTL = 15 * 60 * 1000;
/** 直连故障冷却：cookie 失效（401/403）后先别硬闯，期间直接走 Nitter */
const DIRECT_COOLDOWN = 60 * 60 * 1000;

// ── 模块级状态 ──────────────────────────────────────────────────────────
/** cookie 解析缓存（settings 是本地读取，但避免每条请求都过一遍正则） */
let cookieCache = { ts: 0, cred: null };
/** Bearer / queryId 的运行期覆盖值（重提取成功后生效） */
let bearer = DEFAULT_BEARER;
const qids = { ...DEFAULT_QIDS };
/** 直连冷却截止时间：401/403（多半 cookie 过期）后一段时间内不再尝试 */
let directDownUntil = 0;

/**
 * 从设置页粘贴的原始 cookie 文本中解析出登录凭据。
 * 接受整段 document.cookie（`k=v; k2=v2`）或只贴两个值，大小写不敏感。
 * @returns {{auth:string, ct0:string}|null}
 */
function parseCookie(raw) {
  const s = String(raw || '');
  const auth = s.match(/auth_token=([A-Za-z0-9_-]{20,80})/i)?.[1];
  const ct0 = s.match(/ct0=([A-Za-z0-9%_-]{20,200})/i)?.[1];
  return auth && ct0 ? { auth, ct0 } : null;
}

/** 读 settings.twitterCookie → 登录凭据（30s 缓存）；没有/不完整返回 null */
export async function getXCredential() {
  if (Date.now() - cookieCache.ts < 30 * 1000) return cookieCache.cred;
  let raw = '';
  try {
    raw = (await getSettings())?.twitterCookie || '';
  } catch { /* 读不到按未配置处理 */ }
  const cred = parseCookie(raw);
  cookieCache = { ts: Date.now(), cred };
  return cred;
}

/** 直连是否可用：原生环境（CapacitorHttp）+ cookie 就绪 + 不在冷却期 */
export async function directReady() {
  if (!isNative()) return false;
  if (Date.now() < directDownUntil) return false;
  return !!(await getXCredential());
}

// ── HTTP 底座 ──────────────────────────────────────────────────────────

/** 原生请求（CapacitorHttp 绕开 WebView 的 CORS，还能自带 cookie 头） */
async function httpRequest(method, url, headers = {}, data, timeout = 20000) {
  const resp = await CapacitorHttp.request({
    method,
    url,
    headers: { 'User-Agent': BROWSER_UA, ...headers },
    ...(data ? { data } : {}),
    connectTimeout: timeout,
    readTimeout: timeout,
  });
  if (resp.status < 200 || resp.status >= 300) {
    const e = new Error(`HTTP ${resp.status}`);
    e.status = resp.status;
    throw e;
  }
  return resp.data; // JSON 响应已被原生层解析为对象，其余为字符串
}

const httpGet = (url, headers, timeout) => httpRequest('GET', url, headers, undefined, timeout);
const httpPost = (url, headers, data, timeout) => httpRequest('POST', url, headers, data, timeout);

/**
 * 登录态 GraphQL 调用：401 → 换 Bearer 重试一次；404 → 重提取 queryId 重试一次。
 * GET 端点参数全在 querystring；HomeLatestTimeline 是 POST，参数在 JSON body
 * （x-web 抓包原样：{variables, features, fieldToggles, queryId}）。
 */
async function gql(op, variables, { fieldToggles = '', post = false, retried = false, retried404 = false } = {}) {
  const cred = await getXCredential();
  if (!cred) { const e = new Error('无 X cookie'); e.kind = 'auth'; throw e; }
  const authHeaders = {
    Authorization: `Bearer ${bearer}`,
    Cookie: `auth_token=${cred.auth}; ct0=${cred.ct0}`,
    'X-Csrf-Token': cred.ct0,
    Accept: '*/*',
    Referer: 'https://x.com/',
    Origin: 'https://x.com',
    ...(post ? { 'Content-Type': 'application/json' } : {}),
  };
  const call = () => post
    ? httpPost(`https://x.com/i/api/graphql/${qids[op]}/${op}`, authHeaders, {
      variables,
      features: FEATURES_OBJ,
      ...(fieldToggles ? { fieldToggles: JSON.parse(fieldToggles) } : {}),
      queryId: qids[op],
    })
    : httpGet(`https://x.com/i/api/graphql/${qids[op]}/${op}`
      + `?variables=${encodeURIComponent(JSON.stringify(variables))}`
      + `&features=${encodeURIComponent(FEATURES)}`
      + (fieldToggles ? `&fieldToggles=${encodeURIComponent(fieldToggles)}` : ''), authHeaders);
  let data;
  try {
    data = await call();
  } catch (e) {
    if (e?.status === 401 && !retried) {
      // Bearer 轮换（code 89）：从线上重新提取，再试一次
      const next = await extractBearer();
      if (next && next !== bearer) {
        bearer = next;
        return gql(op, variables, { fieldToggles, post, retried: true, retried404 });
      }
      e.kind = 'auth';
      directDownUntil = Date.now() + DIRECT_COOLDOWN;
      throw e;
    }
    if (e?.status === 403) {
      // cookie 过期 / 账号风控：冷却直连整条链，回落 Nitter
      e.kind = 'auth';
      directDownUntil = Date.now() + DIRECT_COOLDOWN;
      throw e;
    }
    if (e?.status === 404 && !retried404) {
      // queryId 漂移：重新提取全部 qid 再试一次
      const next = await extractQids();
      if (next?.[op] && next[op] !== qids[op]) {
        Object.assign(qids, next);
        return gql(op, variables, { fieldToggles, post, retried, retried404: true });
      }
      throw e;
    }
    throw e;
  }
  if (!data || typeof data !== 'object') {
    const e = new Error('GraphQL 响应异常'); e.kind = 'parse'; throw e;
  }
  return data;
}

// ── Bearer / queryId 自动重提取 ────────────────────────────────────────
// 提取链（2026-11-13 验证）：x.com 首页 HTML → loader chunk（entry-client-*.js，
// 内含 assets 清单）→ 业务 chunk 里 grep Bearer（/AAAA…/）与
// queryId/operationName 相邻对。chunk 文件名带 hash，所以每轮都要现找。

let extracting = null; // 重提取并发合并：同一时刻只跑一轮

/** 从一段 JS 文本里抠 Bearer */
function grepBearer(text) {
  return String(text || '').match(/AAAAAAAAA[A-Za-z0-9%]{20,}/)?.[0] || '';
}

/** 从一段 JS 文本里抠 {operationName: queryId}（queryId 与 operationName 相邻出现） */
function grepQids(text) {
  const found = {};
  const src = String(text || '');
  for (const m of src.matchAll(/queryId:"([^"]{5,40})"[^{}]{0,120}operationName:"([^"]{2,60})"/g)) {
    found[m[2]] = m[1];
  }
  for (const m of src.matchAll(/operationName:"([^"]{2,60})"[^{}]{0,120}queryId:"([^"]{5,40})"/g)) {
    if (!found[m[1]]) found[m[1]] = m[2];
  }
  return found;
}

async function extractBearer() {
  const done = await extractAssets();
  return done?.bearer || '';
}

async function extractQids() {
  const done = await extractAssets();
  return done?.qids || null;
}

/** 走完整个提取链，返回 { bearer, qids }；并发调用合并为一次 */
function extractAssets() {
  if (!extracting) {
    extracting = (async () => {
      try {
        const html = await httpGet('https://x.com/');
        // 首页 HTML 里直接内联的 chunk；loader（entry-client-*）在资产清单里
        const scripts = [...String(html).matchAll(/(?:src="|href="|")((?:\/?assets\/)?[A-Za-z0-9_./-]+\.js)"/g)]
          .map(m => m[1]).filter(s => s.includes('entry-client'));
        const loaderName = scripts[0] || String(html).match(/assets\/[A-Za-z0-9_.-]+\.js/)?.[0];
        if (!loaderName) return null;
        // loader chunk → 全量 assets 清单
        const loader = await httpGet(`https://x.com/${loaderName.startsWith('assets/') ? '' : 'assets/'}${loaderName.replace(/^\/?assets\//, '')}`);
        const assets = [...new Set([...String(loader).matchAll(/assets\/[A-Za-z0-9_.-]+\.js/g)].map(m => m[0]))];
        const all = [...new Set([...assets, loaderName.replace(/^\/?assets\//, 'assets/')])];
        let bearerFound = '';
        const qidsFound = {};
        // 逐块找：Bearer 与 queryId 不一定在同一块，全部找齐或翻完为止
        for (const a of all) {
          if (bearerFound && qidsFound.HomeTimeline && qidsFound.SearchTimeline) break;
          let chunk;
          try {
            chunk = await httpGet(`https://x.com/${a}`);
          } catch { continue; }
          if (!bearerFound) bearerFound = grepBearer(chunk);
          Object.assign(qidsFound, grepQids(chunk));
        }
        return { bearer: bearerFound, qids: qidsFound };
      } catch (e) {
        log.debug('[extract] 失败:', e?.message || e);
        return null;
      } finally {
        extracting = null;
      }
    })();
  }
  return extracting;
}

// ── 时间线解析（结构 2026-11-13 抓包确认）───────────────────────────────
// data.home.home_timeline_urt.instructions / data.search_by_raw_query.search_timeline.timeline.instructions
// entry.content.itemContent.tweet_results.result —— 注意 2026 版字段名是
// tweet_results（旧社区资料里的 tweetResult 已改名）；用户信息也从
// result.legacy 挪到了 result.core.{screen_name,name} + result.avatar.image_url。

/** 兼容 TweetWithVisibilityResults 包装：拿到真正的 tweet 对象 */
function unwrapTweet(result) {
  if (!result?.__typename) return null;
  if (result.__typename === 'TweetWithVisibilityResults') return result.tweet || null;
  return result.__typename === 'Tweet' ? result : null;
}

/** 一张 pbs.twimg.com 静态图 → 页结构（与 nitter 的 toPage 同形，URL 四档） */
function mediaToPage(m, index) {
  const url = String(m?.media_url_https || '').split('?')[0];
  if (!/^https:\/\/pbs\.twimg\.com\/media\//.test(url)) return null;
  const size = m?.sizes?.medium || m?.sizes?.large || {};
  return {
    index,
    url: `${url}?name=small`,
    previewUrl: `${url}?name=medium`,
    thumbnailUrl: `${url}?name=small`,
    mediumUrl: `${url}?name=large`,
    originalUrl: `${url}?name=orig`,
    width: size.w || 0,
    height: size.h || 0,
  };
}

/** "Fri Nov 13 08:08:57 +0000 2026" → 毫秒；JSC 对无冒号时区解析不稳，双保险 */
function parseTwitterDate(s) {
  const t = Date.parse(String(s || ''));
  if (!Number.isNaN(t)) return t;
  return Date.parse(String(s || '').replace(/ ([+-]\d{4}) /, (m, tz) => {
    const sign = tz[0] === '-' ? '-' : '+';
    return ` ${sign}${tz.slice(1, 3)}:${tz.slice(3, 5)} `;
  })) || 0;
}

/** 推文文本 → 展示标题：去 t.co 链接、去 #话题、折叠空白 */
function titleFrom(fullText) {
  const t = String(fullText || '')
    .replace(/https:\/\/t\.co\/\w+/g, '')
    .replace(/#[\p{L}\p{N}_]{1,30}/gu, '')
    .replace(/@[\p{L}\p{N}_]{1,15}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

/**
 * tweet 对象 → 应用统一条目（与 nitter mapItem 同形，上层零改动）。
 * 只收静态图（type==='photo'）：视频/动图封面与现有渲染不兼容，和 nitter 侧取舍一致。
 */
function tweetToItem(tweet) {
  const tw = unwrapTweet(tweet);
  if (!tw) return null;
  const media = (tw.legacy?.extended_entities?.media || []).filter(m => m?.type === 'photo');
  const pages = media.map(mediaToPage).filter(Boolean);
  if (!pages.length) return null;

  const user = tw.core?.user_results?.result;
  const screenName = user?.core?.screen_name || '';
  const restId = String(tw.rest_id || '');
  if (!restId) return null;
  const avatar = String(user?.avatar?.image_url || '').replace('_normal.', '_400x400.');
  const tags = [...(tw.legacy?.entities?.hashtags || [])].map(h => h.text).slice(0, 12);
  const publishedAt = parseTwitterDate(tw.legacy?.created_at);

  return {
    illustId: qualifyId('twitter', restId),
    source: 'twitter',
    _pageIndex: 0,
    pageCount: pages.length,
    _totalPages: pages.length,
    _pages: pages,
    type: 'image',
    illustType: 0,
    title: titleFrom(tw.legacy?.full_text) || (screenName ? `@${screenName} 的推文` : '推文'),
    author: screenName,
    authorName: user?.core?.name || screenName,
    authorAccount: screenName,
    authorId: String(user?.rest_id || ''),
    authorAvatar: /^https:\/\//.test(avatar) ? avatar : '',
    tags,
    width: pages[0].width,
    height: pages[0].height,
    webUrl: `https://x.com/${screenName}/status/${restId}`,
    pixivUrl: '',
    thumbnailUrl: pages[0].thumbnailUrl,
    mediumUrl: pages[0].mediumUrl,
    originalUrl: pages[0].originalUrl,
    publishedAt,
  };
}

/**
 * 解析一批 timeline instructions → { items, cursor }。
 * 两个端点的 instructions 结构同构，这里一并处理：
 *   - tweet-{id} / promoted-*：推文条目（promoted 是广告，跳过）
 *   - cursor-bottom-*：下一页游标（content.value）
 *   - 其余（module/rule 等）忽略
 */
function parseInstructions(instructions) {
  const items = [];
  let cursor = '';
  for (const ins of instructions || []) {
    for (const entry of ins?.entries || []) {
      const id = String(entry?.entryId || '');
      if (id.startsWith('cursor-bottom')) {
        cursor = String(entry?.content?.value || '');
        continue;
      }
      if (!id.startsWith('tweet-')) continue; // promoted-* / user-* / 无媒体条目都不进图流
      const result = entry?.content?.itemContent?.tweet_results?.result;
      const item = tweetToItem(result);
      if (item) items.push(item);
    }
  }
  return { items, cursor };
}

// ── 分页会话：登录态接口经不起高频，首拉 15min 缓存 + 游标链翻页 ────────

function createPager(fetchFirst, fetchNext) {
  const state = { ts: 0, first: null, cursors: [], seen: new Set() };
  return {
    /** @returns {Promise<{items: object[], hasMore: boolean}>} */
    async page(n) {
      if (n <= 1) {
        if (state.first && Date.now() - state.ts < FIRST_PAGE_TTL) {
          return { items: state.first, hasMore: !!state.cursors[0] };
        }
        const { items, cursor } = await fetchFirst();
        state.ts = Date.now();
        state.first = items;
        state.cursors = [cursor];
        state.seen = new Set(items.map(i => i.illustId));
        return { items, hasMore: !!cursor };
      }
      const cursor = state.cursors[n - 2];
      if (!cursor) return { items: [], hasMore: false };
      // X 时间线翻页与上一页内容大量重叠（新的一页可能全是已见过的推文），
      // 去重后为空≠尽头：沿着游标续拉，直到凑够一个像样的批次（PAGE_MIN_NEW）
      // 或游标耗尽/次数上限，否则面板会把「本页 0 新图」误判成「没有更多了」。
      // 注意不能拿到 1 条就停 —— 一页 20 条推文带图的仅数条、重叠率高，
      // 去重后常剩 1-2 条，触底一次只长 1-2 张图的体验很差
      const fresh = [];
      let cur = cursor;
      let guard = 0;
      while (guard++ < 5) {
        const { items, cursor: next } = await fetchNext(cur);
        const batch = items.filter(i => !state.seen.has(i.illustId));
        for (const it of batch) state.seen.add(it.illustId);
        fresh.push(...batch);
        state.cursors[n - 1] = next;
        if (!next || fresh.length >= 10) break;
        cur = next;
      }
      return { items: fresh, hasMore: !!state.cursors[n - 1] };
    },
  };
}

/** 关注时间线（Following tab，按时间序）分页会话 —— x-web 走 POST，参数在 body */
const followingPager = createPager(
  () => gql('HomeLatestTimeline',
    { count: 20, enableRanking: true, includePromotedContent: true, requestContext: 'launch' },
    { fieldToggles: '{"withPayments":false}', post: true })
    .then(d => parseInstructions(d?.data?.home?.home_timeline_urt?.instructions)),
  (cursor) => gql('HomeLatestTimeline',
    { count: 20, enableRanking: true, includePromotedContent: true, requestContext: 'launch', cursor },
    { fieldToggles: '{"withPayments":false}', post: true })
    .then(d => parseInstructions(d?.data?.home?.home_timeline_urt?.instructions)),
);

/** 关注时间线（首页 For You）分页会话 */
const homePager = createPager(
  () => gql('HomeTimeline',
    { count: 20, includePromotedContent: true, requestContext: 'launch', withCommunity: true },
    { fieldToggles: '{"withPayments":false}' })
    .then(d => parseInstructions(d?.data?.home?.home_timeline_urt?.instructions)),
  (cursor) => gql('HomeTimeline',
    { count: 20, includePromotedContent: true, requestContext: 'launch', withCommunity: true, cursor },
    { fieldToggles: '{"withPayments":false}' })
    .then(d => parseInstructions(d?.data?.home?.home_timeline_urt?.instructions)),
);

/** 搜索分页会话池：rawQuery → pager（tag 搜索 / @用户媒体都走这里） */
const searchPagers = new Map();

function searchPager(rawQuery) {
  if (!searchPagers.has(rawQuery)) {
    const vars = c => ({
      rawQuery, count: 20, querySource: '', product: 'Latest',
      withGrokTranslatedBio: true, withQuickPromoteEligibilityTweetFields: false, ...(c ? { cursor: c } : {}),
    });
    const parse = d => parseInstructions(d?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions);
    searchPagers.set(rawQuery, createPager(
      () => gql('SearchTimeline', vars()).then(parse),
      (cursor) => gql('SearchTimeline', vars(cursor)).then(parse),
    ));
  }
  return searchPagers.get(rawQuery);
}

// ── 对外 API（nitter.js 调用）──────────────────────────────────────────

/**
 * 登录态关注流（第 n 页，1 起）。
 * @returns {Promise<{items: object[], hasMore: boolean}>}
 */
export async function homeFeed(page) {
  return homePager.page(Math.max(1, page | 0));
}

/**
 * 关注时间线（Following，按时间序，第 n 页）。
 * @returns {Promise<{items: object[], hasMore: boolean}>}
 */
export async function followingFeed(page) {
  return followingPager.page(Math.max(1, page | 0));
}

/**
 * 搜索推文（rawQuery 支持 x 搜索语法：`#tag filter:images`、`from:name filter:images`）。
 * @returns {Promise<{items: object[], hasMore: boolean}>}
 */
export async function searchFeed(rawQuery, page) {
  return searchPager(String(rawQuery || '').trim()).page(Math.max(1, page | 0));
}

/** 从搜索条目里聚合发帖作者（推荐博主的直连信号） */
export function authorsFromItems(items) {
  const map = new Map();
  for (const it of items || []) {
    if (!it.authorAccount || map.has(it.authorAccount)) continue;
    map.set(it.authorAccount, {
      username: it.authorAccount,
      fullname: it.authorName || it.authorAccount,
      avatar: it.authorAvatar || '',
    });
  }
  return [...map.values()];
}

/** 供设置页校验用：cookie 串是否包含必需的两个值 */
export function isValidCookieText(raw) {
  return !!parseCookie(raw);
}
