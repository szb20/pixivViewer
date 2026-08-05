import { pixivApi } from './pixiv.js';
import { saveItem } from './index.js';
import { getCompositeKey, pixivReUrl } from '../pixiv-assistant/core/utils.js';

const SAVE_BATCH_SIZE = 3;

/**
 * 保存作品全部页到相册 — 详情页长按❤️ 与网格长按共用的唯一实现。
 *
 * - 已保存的页跳过（幂等）；
 * - 详情未加载时自动补拉 fetchIllust，拿完整日期路径 URL（避免 pixiv.re 短链）；
 * - 分批并发，最多 3 页同时下载；
 * - 成功后更新 pixivCache 的 saved/cached 标记。
 *
 * @param {object} item 作品条目（illustId / type / illustType / title / author / tags / URL 等）
 * @param {object} [opts]
 * @param {object} [opts.pixivCache]      当前缓存，用于跳过已保存页
 * @param {function} [opts.setPixivCache] 更新缓存
 * @param {Array} [opts.images]           已加载的详情图片数组（可为空，内部补拉）
 * @param {number} [opts.totalPages]      已知总页数（可为空）
 * @returns {Promise<{saved: number, exists: number}>}
 */
export async function saveAllPages(item, { pixivCache = {}, setPixivCache, images, totalPages } = {}) {
  if (!item?.illustId) return { saved: 0, exists: 0 };
  const isGif = item.type === 'gif' || Number(item.illustType) === 2;

  let imgs = Array.isArray(images) ? images : [];
  let total = Math.max(
    Number(totalPages) || 0,
    Number(item._totalPages || item.pageCount) || 0,
    imgs.length || 0,
    1,
  );
  if (imgs.length === 0) {
    try {
      const r = await pixivApi.fetchIllust(item.illustId);
      imgs = r?.illust?.images || [];
      total = Math.max(r?.illust?.pageCount || 0, imgs.length || 0, total);
    } catch { /* 拿不到详情就按已有信息继续 */ }
  }

  const pages = [];
  let existsInCache = 0;
  for (let p = 0; p < total; p++) {
    const ck = getCompositeKey({ illustId: item.illustId, _pageIndex: p });
    if (pixivCache[ck]?.saved) { existsInCache += 1; continue; }
    const pg = imgs[p] || {};
    const derived = pixivReUrl(String(item.illustId), p);
    pages.push({
      ck,
      item: {
        illustId: item.illustId,
        _pageIndex: p,
        _silent: true, // 批量保存不弹每页 toast，由调用方汇总提示
        type: isGif ? 'gif' : 'image',
        originalUrl: pg.originalUrl || (p === 0 ? item.originalUrl : '') || derived || '',
        mediumUrl: pg.url || (p === 0 ? item.mediumUrl : '') || derived || '',
        thumbnailUrl: item.thumbnailUrl,
        title: item.title,
        author: item.author || item.authorName || '',
        authorName: item.authorName || item.author || '',
        tags: Array.isArray(item.tags) ? item.tags : [],
      },
    });
  }

  let savedCount = 0;
  let existsCount = existsInCache;
  for (let i = 0; i < pages.length; i += SAVE_BATCH_SIZE) {
    const batch = pages.slice(i, i + SAVE_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async ({ item: saveIt, ck }) => {
      const r = await saveItem(saveIt);
      if (r?.success || r?.cached) {
        setPixivCache?.(prev => ({ ...prev, [ck]: { ...prev[ck], cached: true, saved: true } }));
        return r;
      }
      return null;
    }));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        if (r.value.idempotent || r.value.skipped) existsCount += 1;
        else savedCount += 1;
      }
    }
  }

  return { saved: savedCount, exists: existsCount };
}
