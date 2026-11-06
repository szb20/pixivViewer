import { useEffect, useRef, useState } from 'react';
import { getCompositeKey, storageFacade } from '../../pixiv-assistant/index.js';

/**
 * 已保存页 → 本地 blob URL 管理 — 从 ImageDetailView 抽出。
 *
 * 仅在灯箱打开后读取（详情流不加载本地原图）；pixivCache 变化（保存/取消保存）时
 * 增量更新：复用已有 URL、新增刚保存的页、回收已取消的页；切换作品时整体回收。
 *
 * @param {string} illustId - 当前作品 ID
 * @param {number} pageCount - 页数（详情接口）
 * @param {number} totalPagesHint - 列表条目自带的 _totalPages（兜底）
 * @param {object} pixivCache - 已保存/喜欢的复合键缓存
 * @param {number|null} lightboxIndex - 灯箱当前页；null（关闭）时不加载本地文件
 * @returns {Record<number, string>} page → 本地 blob URL
 */
export function useLocalSrcs(illustId, pageCount, totalPagesHint, pixivCache, lightboxIndex) {
  const [localSrcs, setLocalSrcs] = useState({});
  const prevLocalSrcsRef = useRef({});

  // 切换作品时清空本地 URL 缓存，避免跨作品误用上一张图的本地原图
  useEffect(() => {
    setLocalSrcs({});
    prevLocalSrcsRef.current = {};
    return () => {
      // 卸载或切换作品时回收本实例持有的本地 blob URL，避免累积
      const prev = prevLocalSrcsRef.current;
      for (const u of Object.values(prev)) {
        try { URL.revokeObjectURL(u); } catch { /* 忽略 */ }
      }
    };
  }, [illustId]);

  // 已保存页 → 本地 blob URL：仅在灯箱打开后读取
  useEffect(() => {
    if (!illustId || lightboxIndex === null) return;
    let cancelled = false;
    const totalPages = Math.max(pageCount, totalPagesHint || 1);
    const created = []; // 本次运行新建的 blob URL，取消时回收未提交部分
    (async () => {
      const map = {};
      const prev = prevLocalSrcsRef.current;
      for (let p = 0; p < totalPages; p++) {
        const ck = getCompositeKey({ illustId, _pageIndex: p });
        if (!pixivCache[ck]?.saved) continue;
        if (prev[p]) { map[p] = prev[p]; continue; } // 复用已有本地 URL，避免重复读相册
        const r = await storageFacade.load(illustId, p).catch(() => null);
        if (cancelled) return;
        if (r?.localUrl) { map[p] = r.localUrl; created.push(r.localUrl); }
      }
      if (cancelled) return;
      // 回收不再使用（已取消保存 / 切换作品）的旧 blob URL
      for (const [p, u] of Object.entries(prev)) {
        if (map[p] !== u) URL.revokeObjectURL(u);
      }
      const unchanged = Object.keys(map).length === Object.keys(prev).length
        && Object.keys(map).every(p => map[p] === prev[p]);
      prevLocalSrcsRef.current = map;
      if (!unchanged) setLocalSrcs(map);
    })();
    return () => {
      cancelled = true;
      // 仅回收尚未提交到 prevLocalSrcsRef 的新建 URL（异步加载中途被卸载/切换）
      const prevValues = new Set(Object.values(prevLocalSrcsRef.current));
      for (const u of created) {
        if (!prevValues.has(u)) {
          try { URL.revokeObjectURL(u); } catch { /* 忽略 */ }
        }
      }
    };
  }, [illustId, pixivCache, pageCount, totalPagesHint, lightboxIndex]); // oxlint-disable-line react-hooks/exhaustive-deps

  return localSrcs;
}
