import { useEffect, useRef } from 'react';
import { getCompositeKey, storageFacade } from '../../pixiv-assistant/index.js';

/**
 * 浏览时回填元数据 — 从 ImageDetailView 抽出。
 *
 * 已保存/喜欢的实体缺元数据时，把 完整缩略图URL/标题/作者/tags 写回并更新备份
 * （这样「喜欢」页无需依赖 pixiv.re 短链反查，直接显示完整 URL 缩略图）。
 * 幂等守卫：同一作品的 meta 指纹未变化则不重复回填（避免每次 like/save 对全部已保存页重跑存储 I/O）。
 *
 * @param {object} params
 * @param {string} params.illustId
 * @param {object} params.illustData - 详情接口响应（illustData.illust）
 * @param {object} params.image - 列表条目（缩略图/标题/作者兜底来源）
 * @param {object} params.pixivCache - 已保存/喜欢的复合键缓存
 * @param {number} params.pageCount
 */
export function useMetaBackfill({ illustId, illustData, image, pixivCache, pageCount }) {
  const backfillFingerprintRef = useRef({}); // illustId → meta 指纹，避免每次 like/save 重复回填

  useEffect(() => {
    const illust = illustData?.illust;
    if (!illustId) return;
    const tags = Array.isArray(illust?.tags) ? illust.tags.filter(Boolean) : [];
    const p0 = illust?.images?.[0] || {};
    const meta = {
      thumbnailUrl: image?.thumbnailUrl || p0.thumbnailUrl || p0.previewUrl || p0.url || '',
      title: image?.title || illust?.title || '',
      author: image?.authorName || image?.author || illust?.authorName || illust?.author || '',
      authorName: image?.authorName || illust?.authorName || illust?.author || '',
      authorId: image?.authorId || illust?.authorId || '',
      pageCount: illust?.pageCount || 0,
      tags,
    };
    if (!meta.thumbnailUrl && !meta.title && !meta.authorName && tags.length === 0) return;
    // 幂等守卫：同一作品的 meta 指纹未变化则不重复回填（避免每次 like/save 对全部已保存页重跑存储 I/O）
    const fingerprint = JSON.stringify(meta);
    if (backfillFingerprintRef.current[illustId] === fingerprint) return;
    backfillFingerprintRef.current[illustId] = fingerprint;
    (async () => {
      const totalPages = Math.max(pageCount, image?._totalPages || 1);
      for (let p = 0; p < totalPages; p++) {
        const ck = getCompositeKey({ illustId, _pageIndex: p });
        const cur = pixivCache[ck];
        if (!cur?.saved && !cur?.liked) continue; // 只回填已保存/喜欢的条目
        await storageFacade.fillMeta(illustId, p, meta); // 补 tags / URL / 标题 / pageCount
      }
    })().catch(() => { });
  }, [illustData, image, pixivCache, pageCount]); // oxlint-disable-line react-hooks/exhaustive-deps
}
