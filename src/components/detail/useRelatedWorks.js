import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../../api/pixiv.js';
import { createLogger } from '../../utils/logger.js';
import { parsePixivResults } from './helpers.js';

const log = createLogger('ImageDetail');
// Pixiv 的 recommend/init 不是可翻页列表：start 基本无效（同一作品换 start 仍是同一批），
// 推荐池本身有上限（实测约 85 条），limit 拉满即一次返回全部——所以不做无限滚动，一次取完。
const RELATED_FETCH_LIMIT = 100;
// 相关推荐模块级缓存（跨详情实例共享）：返回上一作品时 ImageDetailView 因 key 变化整体重挂载，
// 实例内缓存会丢失、推荐区需重新走网络，导致滚动恢复等待且闪烁。LRU 上限防长会话膨胀。
const relatedCache = new Map();
const RELATED_CACHE_MAX = 20;

/**
 * 相关推荐数据源 — 从 ImageDetailView 抽出。
 * 模块级 LRU 缓存 + 请求 seq 守卫（切换作品时丢弃过期响应，不写回旧列表）。
 * @param {string} illustId - 当前作品 ID
 * @param {boolean} relatedCapable - 来源是否支持相关推荐（caps.related；booru 无此接口）
 * @returns {{related: Array, loadingRelated: boolean, relatedRef: object}}
 *          relatedRef 是推荐区哨兵节点，父组件挂 IntersectionObserver（悬浮爱心的显隐）用
 */
export function useRelatedWorks(illustId, relatedCapable) {
  const [related, setRelated] = useState([]);
  const [loadingRelated, setLoadingRelated] = useState(false);
  const relatedRef = useRef(null); // 相关推荐哨兵
  const loadingRelatedRef = useRef(false);
  const relatedRequestSeqRef = useRef(0);
  const illustIdRef = useRef('');
  illustIdRef.current = illustId || '';

  const loadRelated = useCallback(async ({ requestSeq } = {}) => {
    const id = illustId ? String(illustId) : '';
    if (!id || loadingRelatedRef.current) return;
    // booru 站没有相关推荐接口：直接置空，区块随 related.length === 0 自动不渲染
    if (!relatedCapable) { setRelated([]); setLoadingRelated(false); return; }
    const activeSeq = requestSeq || relatedRequestSeqRef.current;
    const isCurrentRequest = () => (
      relatedRequestSeqRef.current === activeSeq &&
      illustIdRef.current === id
    );
    loadingRelatedRef.current = true;
    setLoadingRelated(true);
    try {
      const result = await pixivApi.fetchRelated(id, { limit: RELATED_FETCH_LIMIT });
      if (!isCurrentRequest()) return;
      const rawList = result?.illusts || [];
      const parsed = rawList.length > 0 ? parsePixivResults(rawList) : [];
      const seen = new Set();
      const merged = [];
      for (const item of parsed) {
        if (seen.has(item.illustId)) continue;
        seen.add(item.illustId);
        merged.push(item);
      }
      relatedCache.set(id, merged);
      if (relatedCache.size > RELATED_CACHE_MAX) {
        relatedCache.delete(relatedCache.keys().next().value); // 淘汰最旧
      }
      setRelated(merged);
    } catch (e) {
      if (!isCurrentRequest()) return;
      log.warn('fetchRelated failed:', e);
    } finally {
      if (isCurrentRequest()) {
        loadingRelatedRef.current = false;
        setLoadingRelated(false);
      }
    }
  }, [illustId, relatedCapable]);

  // 切换作品：优先缓存命中（秒开）；否则清空并拉取
  useEffect(() => {
    if (!illustId) return;
    const id = String(illustId);
    relatedRequestSeqRef.current += 1;
    const requestSeq = relatedRequestSeqRef.current;
    loadingRelatedRef.current = false;
    const cached = relatedCache.get(id);
    if (cached) {
      setRelated(cached);
      setLoadingRelated(false);
      return;
    }
    setRelated([]);
    loadRelated({ requestSeq });
  }, [illustId, loadRelated]);

  return { related, loadingRelated, relatedRef };
}
