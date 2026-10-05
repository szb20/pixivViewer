/**
 * Gelbooru 系适配器 — safebooru.org 一类跑 Gelbooru 代码的图站共用同一套 DAPI。
 *
 * 与 Moebooru 的关键差异：
 *   - 一个端点走天下：/index.php?page=dapi&s=post&q=index&json=1
 *   - 分页参数 pid 是 **0 基**（页 1 → pid=0）
 *   - 排序不是独立参数，而是拼进 tags 的元标签：sort:score:desc / sort:updated:desc
 *   - score 可能为 null（新投稿还没投票）
 *
 * 关于「推荐」：DAPI 没有时间窗热度接口，可用的排序只有两个，都不能直接用：
 *   - sort:score:desc —— 按分数排，老图攒了几年票，返回的全是十几年前的高分图（用户一眼就看出来「都是老图」）
 *   - sort:updated:desc（＝不传 sort）—— 新 → 旧，但没有任何质量筛选，前面全是刚上传的零票图
 * 所以推荐流用「默认序（新→旧）+ score:>=N」取**近期上传里已经攒够票的那批**，见 FEED_MIN_SCORE。
 *
 * 已登记 safebooru.org（免 API key、实测大陆直连可达）。
 * gelbooru.com / rule34.xxx 的同构站点将来补一条 registry + 一条代理路由即可，
 * 但前者现已强制 api_key + user_id，接入前要先加凭据存储。
 *
 * 文档：https://gelbooru.com/index.php?page=wiki&s=view&id=18780
 */
import { createTransport } from '../api/transport.js';
import { qualifyId, rawIdOf, sourceOfId } from '../pixiv-assistant/core/utils.js';
import { createLogger } from '../utils/logger.js';
import { classifyError, extractPostId, toIllust } from './shared.js';

const log = createLogger('gelbooru');

/** DAPI 单页上限（超出会被上游截断，这里先夹住免得白传） */
const MAX_LIMIT = 100;

/**
 * 推荐流的分数下限 —— 配合默认序（新→旧）取「近期高分」。
 * 实测（safebooru.org，2026-10）：全站最新 id 约 720 万，
 *   score:>=3  起始 id 约 719.8 万
 *   score:>=5  起始 id 约 718.4 万
 *   score:>=10 起始 id 约 715.6 万（约 4.8 万条之前）
 *   score:>=30 起始 id 直接掉到 641 万（十几年前）
 * 阈值越高越精也越旧，取 10 是「还看得出是近期」与「不是零票图」的折中。
 */
const FEED_MIN_SCORE = 10;

/** 各站的网页地址模板 */
const POST_URL = {
  safebooru: (id) => `https://safebooru.org/index.php?page=post&s=view&id=${id}`,
};

/** 站点 tags 语法用 `+` 连接多个 tag（AND 语义） */
function encodeTags(tags) {
  return encodeURIComponent(tags).replace(/%20/g, '+');
}

/**
 * 一条 Gelbooru post → 应用统一条目。
 * @param {object} post
 * @param {string} sourceId
 */
function mapPost(post, sourceId) {
  const rawId = String(post?.id ?? '');
  const original = post?.file_url || '';
  if (!rawId || !original) return null;
  const tags = String(post.tags || '').split(/\s+/).filter(Boolean);
  // 无标题字段（与 Moebooru 一样）：首个 tag 通常是 1girl 之类，聊胜于无
  const title = tags[0] || '';
  // DAPI 的 post 结构里没有作者字段，作者名只能留空
  const author = '';
  return {
    illustId: qualifyId(sourceId, rawId),
    source: sourceId,
    title,
    author,
    authorName: author,
    authorAccount: '',
    authorId: '',          // 无作者 id：关注按钮与作者页点击自然隐藏（均以 authorId 为守卫）
    authorAvatar: '',
    thumbnailUrl: post.preview_url || '',
    // sample_url 偶尔指向不存在的样本图，回退到原图
    mediumUrl: post.sample_url || original,
    originalUrl: original,
    tags,
    pixivUrl: '',          // 非 Pixiv 来源不伪造 pixiv 链接，外链一律走 webUrl
    webUrl: POST_URL[sourceId]?.(rawId) || '',
    pageCount: 1,
    type: 'image',
    illustType: 0,
    width: post.width || 0,
    height: post.height || 0,
    rating: post.rating || '',
    score: post.score || 0,
    _pageIndex: 0,
  };
}

/**
 * 创建一个 Gelbooru 系来源。
 * @param {{id:string, net:object}} def — registry 里的来源定义
 */
export function createGelbooruSource(def) {
  const sourceId = def.id;
  const transport = createTransport({
    apiPrefix: def.net.apiPrefix,
    origin: def.net.apiOrigin,
    logName: `booru:${sourceId}`,
    userAgent: def.net.userAgent,
  });

  /**
   * 取一页 post。
   * @param {string} tags — 已编码的 tags（含 sort: 元标签）
   * @param {{page?:number, limit?:number}} opts — page 为 1 基，内部转 0 基 pid
   */
  async function listPosts(tags, { page = 1, limit = 20 } = {}) {
    const size = Math.min(Math.max(1, limit), MAX_LIMIT);
    const pid = Math.max(0, page - 1);
    const qs = `?page=dapi&s=post&q=index&json=1&limit=${size}&pid=${pid}&tags=${encodeTags(tags)}`;
    const data = await transport(`/index.php${qs}`);
    // 裸数组是常态；个别 Gelbooru 实例会包一层 { post: [...] }
    if (Array.isArray(data)) return data;
    return Array.isArray(data?.post) ? data.post : [];
  }

  /** 拼一个「搜索 + 排序 + 分级」的完整 tags 串 */
  function buildTags(query, { sort, safeOnly } = {}) {
    const parts = [String(query || '').trim(), sort, safeOnly ? 'rating:safe' : ''];
    return parts.filter(Boolean).join(' ');
  }

  return {
    id: sourceId,
    def,
    rankingModes: [
      { key: 'score', label: '高分' },   // 全站历史高分（sort:score:desc），与推荐流的「近期高分」不同
      { key: 'updated', label: '最新' },
    ],

    /**
     * 标签 / ID 搜索。默认按投稿时间倒序（不传 sort: 时上游就是这个行为）。
     * @returns {Promise<{images: object[], query: string, total?: number, error?: string}>}
     */
    async search(query, { page = 1, limit = 20, safeOnly = false } = {}) {
      const trimmed = String(query || '').trim();
      if (!trimmed) return { images: [], query: '' };
      const postId = extractPostId(trimmed, /[?&]id=(\d+)/i);
      try {
        if (postId) {
          const posts = await listPosts(`id:${postId}`, { page: 1, limit: 1 });
          return { images: posts.map(p => mapPost(p, sourceId)).filter(Boolean), query: trimmed, total: 1 };
        }
        const posts = await listPosts(buildTags(trimmed, { safeOnly }), { page, limit });
        return { images: posts.map(p => mapPost(p, sourceId)).filter(Boolean), query: trimmed };
      } catch (e) {
        log.error('[search] 失败:', e?.message || e);
        return { images: [], query: trimmed, error: classifyError(e, '搜索') };
      }
    },

    /**
     * 推荐流 —— 近期高分：默认序（新→旧）+ score:>=N，**不传 sort:**。
     * @returns {Promise<{illusts: object[], message?: string}>}
     */
    async feed({ page = 1, limit = 20, safeOnly = false } = {}) {
      try {
        const posts = await listPosts(buildTags(`score:>=${FEED_MIN_SCORE}`, { safeOnly }), { page, limit });
        return { illusts: posts.map(p => mapPost(p, sourceId)).filter(Boolean) };
      } catch (e) {
        log.error('[feed] 失败:', e?.message || e);
        return { illusts: [], message: classifyError(e, '推荐') };
      }
    },

    /**
     * 榜单 —— 高分 / 最新两档。
     * @param {{period?: 'score'|'updated', limit?: number}} opts
     * @returns {Promise<{illusts: object[], error?: string}>}
     */
    async popular({ period = 'score', limit = 20 } = {}) {
      const sort = period === 'updated' ? 'sort:updated:desc' : 'sort:score:desc';
      try {
        const posts = await listPosts(buildTags('', { sort }), { page: 1, limit });
        return { illusts: posts.map(p => mapPost(p, sourceId)).filter(Boolean) };
      } catch (e) {
        log.error('[popular] 失败:', e?.message || e);
        return { illusts: [], error: classifyError(e, '排行榜') };
      }
    },

    /**
     * 按 ID 取单条详情（详情页 / 保存时补全 URL）。
     * 接受带来源前缀的 illustId，也接受裸站点 id。
     * @param {string} illustId
     * @returns {Promise<{illust: object|null, error?: string}>}
     */
    async fetchIllust(illustId) {
      const id = sourceOfId(illustId) === sourceId ? rawIdOf(illustId) : String(illustId);
      if (!id) return { illust: null, error: '作品 ID 为空' };
      try {
        const posts = await listPosts(`id:${id}`, { page: 1, limit: 1 });
        const item = posts.length ? mapPost(posts[0], sourceId) : null;
        if (!item) return { illust: null, error: '作品未找到，可能已被删除' };
        return { illust: toIllust(item) };
      } catch (e) {
        log.error('[fetchIllust] 失败:', e?.message || e);
        return { illust: null, error: classifyError(e, '作品详情') };
      }
    },
  };
}
