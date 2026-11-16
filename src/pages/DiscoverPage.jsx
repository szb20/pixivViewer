import { useEffect, useRef, useState } from 'react';
import { pixivApi, isCookieErrorCode } from '../api/pixiv.js';
import { useTabFeed } from '../hooks/useTabFeed.js';
import { useLikedSet, usePixivCache } from '../context/pixivCacheContext.js';
import ImageGrid from '../components/ImageGrid.jsx';
import SkeletonGrid from '../components/SkeletonGrid.jsx';
import NeedCookieNotice from '../components/NeedCookieNotice.jsx';
import FollowIcon from '../components/icons/FollowIcon.jsx';
import { createLogger } from '../utils/logger.js';
import { hiddenWorks } from '../utils/hiddenWorks.js';
import { useImageSourceId, useBooruSafeOnly } from '../hooks/useImageSource.js';
import { booruApiFor } from '../sources/api.js';
import { parseUserList, hydrateIndex } from '../sources/nitter.js';
import { scopedTabKey, getSettingsSync, getSettings, saveSettings } from '../pixiv-assistant/index.js';
import { showToast } from '../utils/toast.js';

const PAGE_SIZE = 20;
const CACHE_KEY = 'discover';
const log = createLogger('Discover');

/**
 * DiscoverPage — 推荐页（单源）。
 * useTabFeed + tabCache 水合：切来源时按 App.jsx 的 sourceId key 重挂载，缓存按源隔离。
 */
export default function DiscoverPage({ onOpen, onOpenSettings, onSearchTag, registerRefresh, refreshToken = 0 }) {
  const likedSet = useLikedSet();
  const { recommendationExcludedSet, cacheReady } = usePixivCache();
  const sourceId = useImageSourceId();
  const safeOnly = useBooruSafeOnly();
  const booruApi = booruApiFor(sourceId);
  const startRef = useRef(0);
  const isBooru = !!booruApi;

  const feed = useTabFeed({
    cacheKey: scopedTabKey(sourceId, CACHE_KEY),
    registerRefresh,
    // 下拉刷新按 tab key 注册：store 的 triggerPullRefresh 取 refreshFns[activeTab]
    refreshKey: 'discover',
    refreshToken,
    // 推荐排除以启动时的收藏/保存快照为准，避免本次收藏改变当前会话的推荐流。
    // booru 来源没有这份快照，无需等待，直接放行。
    enabled: isBooru || cacheReady,
    // 缓存 hasMore=false（可能是不足一页的旧缓存）时不跳过网络请求，确保能继续加载
    shouldSkipFirstFetch: (applied) => !!applied.hasMore,
    hydrate: (cache) => {
      if (!cache?.items?.length) return null;
      if (cache.start > 0) startRef.current = cache.start;
      // X：缓存条目自带 tags，灌回 nitter 内存索引 —— 冷启动推荐博主不用再等首拉建索引
      if (sourceId === 'twitter') hydrateIndex(cache.items);
      return {
        items: isBooru ? cache.items : cache.items.filter(item => !recommendationExcludedSet?.has(String(item.illustId))),
        hasMore: !!cache.hasMore,
      };
    },
    fetchPage: async (append, currentItems, isStale) => {
      if (!append) startRef.current = 0;

      // ── 非 Pixiv 来源：Moebooru 没有 offset 游标，翻页就是 page+1 ──
      if (isBooru) {
        const page = append ? startRef.current + 1 : 1;
        const r = await booruApi.feed({ page, limit: PAGE_SIZE, safeOnly });
        if (isStale?.()) return null;
        const list = r?.illusts || [];
        const failed = !list.length && !!(r?.message || r?.error);
        if (!failed) startRef.current = page;
        const fresh = list.filter(img => !hiddenWorks.has(img.illustId));
        return {
          list: fresh,
          // X 直连透传 hasMore（游标链），booru 适配器没有该字段 —— 两者兼容：
          // 有透传值听游标的，没有再退回「本页有条目就有下一页」
          hasMore: r?.hasMore === true || (r?.hasMore === undefined && list.length > 0),
          error: failed ? (r?.message || r?.error || '') : '',
          emptyMessage: r?.message || '暂无推荐',
          cacheExtra: { start: startRef.current },
        };
      }

      // 去重（discovery 可能重复返回同一批）
      const seen = new Set(currentItems.map(i => i.illustId));
      // 只过滤启动前已喜欢/已保存的作品。本会话新增收藏保留在后续推荐中，直到下次启动。
      const excludedAtStartup = recommendationExcludedSet || new Set();

      // 整页全被过滤（已喜欢/已保存/不想看）时继续向后拉，避免流提前中断；
      // 连续 3 页都过滤不出新内容（或上游重复返回同一批）才判定断流
      const collected = [];
      let rawTotal = 0;
      let emptyStreak = 0;
      let lastError = '';
      let lastErrorCode = '';
      while (rawTotal < PAGE_SIZE * 3 && emptyStreak < 3) {
        const r = await pixivApi.fetchDiscovery({ limit: PAGE_SIZE, start: startRef.current });
        // 响应已被刷新/新请求取代 → 立刻停手：这次 await 之后不能再推进 startRef，
        // 否则会把新一轮刷新刚归零的游标又推走一页，导致下一次触底跳过一整页
        if (isStale?.()) return null;
        const rawList = r?.illusts || [];
        lastError = r?.message || r?.error || '';
        lastErrorCode = r?.error || '';
        if (!rawList.length) break;
        rawTotal += rawList.length;
        startRef.current += rawList.length;
        let fresh = 0;
        for (const img of rawList) {
          // 跳过已显示过的 + 用户"不想看"的 + 启动前已喜欢/已保存的
          if (seen.has(img.illustId) || hiddenWorks.has(img.illustId) || excludedAtStartup.has(String(img.illustId))) continue;
          seen.add(img.illustId);
          collected.push(img);
          fresh++;
        }
        if (collected.length >= PAGE_SIZE) break;
        emptyStreak = fresh === 0 ? emptyStreak + 1 : 0;
      }
      log.debug('[discover-load] append:', append, 'start:', startRef.current, 'raw:', rawTotal, 'fresh:', collected.length, 'err:', lastError || '');
      // 整页无任何返回且有错误 → 判定为请求失败（区别于"整页被过滤"），交给 useTabFeed 提示重试
      const failed = rawTotal === 0 && !!lastError;
      return {
        list: collected,
        // 上游仍有返回就继续；连续多页无新内容才断流（整页被过滤不算断流）
        hasMore: rawTotal > 0 && emptyStreak < 3,
        error: failed ? (lastError || '推荐为空（需要 Cookie）') : '',
        errorCode: failed ? lastErrorCode : '',
        emptyMessage: lastError || '推荐为空（需要 Cookie）',
        cacheExtra: { start: startRef.current },
      };
    },
  });

  // X 来源：详情页的关注/取关按钮改的是 settings.twitterUsers（本地名单）。
  // 已加载的帖子不会自己消失 —— 听取关/关注事件后刷新推荐流：
  // 取关账号的帖子立即清掉，新关注的账号下一拉并入。keepOnFail：刷新失败保留旧列表。
  const reloadFeed = feed.load;
  useEffect(() => {
    if (sourceId !== 'twitter') return;
    const onFollowsChanged = () => reloadFeed(false, { keepOnFail: true });
    window.addEventListener('twitter:follows-changed', onFollowsChanged);
    return () => window.removeEventListener('twitter:follows-changed', onFollowsChanged);
  }, [sourceId, reloadFeed]);

  // ── X 推荐博主行 ──
  // 信号链：关注流高频 tag → nitter tag 搜索 → 聚合未关注发帖者（sources/nitter.js suggest）。
  // 列表首屏出内容后再拉；tag 频次来自内存索引，冷启动水合态索引未建（ready=false）时
  // 每 20s 重试，等首拉/下拉刷新把索引建起来（重试只算内存频次，不发网络请求）。
  const [suggested, setSuggested] = useState(null);
  // 推荐分批浏览：候选池最多 24 个，每批显示 8 个，「换一批」轮换 offset（模回绕）。
  // 关注成功后 refreshSuggest 重拉过滤，列表变短时模运算天然兜底不越界
  const [suggestOffset, setSuggestOffset] = useState(0);
  const SUGGEST_BATCH = 8;
  const feedReady = feed.items.length > 0;
  useEffect(() => {
    if (sourceId !== 'twitter' || !feedReady) return;
    let cancelled = false;
    let timer = 0;
    let tries = 0;
    const run = async () => {
      if (cancelled) return;
      try {
        const api = booruApiFor('twitter');
        if (typeof api?.suggest !== 'function') return;
        const followed = parseUserList(getSettingsSync()?.twitterUsers || '');
        const { users, ready } = await api.suggest(followed);
        if (cancelled) return;
        setSuggested(users);
        // 索引未就绪：不当作「没有推荐」，稍后重试（最多 15 次 ≈ 5 分钟）
        if (!ready && ++tries < 15) timer = setTimeout(run, 20000);
      } catch { /* 推荐行是锦上添花，失败静默 */ }
    };
    run();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sourceId, feedReady]);

  // 关注/取关事件 → 用缓存重过滤推荐行（已关注的立即从行里消失），不用重搜
  useEffect(() => {
    if (sourceId !== 'twitter') return;
    const refreshSuggest = async () => {
      const api = booruApiFor('twitter');
      if (typeof api?.suggest !== 'function') return;
      const followed = parseUserList(getSettingsSync()?.twitterUsers || '');
      const { users } = await api.suggest(followed);
      setSuggested(users);
    };
    window.addEventListener('twitter:follows-changed', refreshSuggest);
    return () => window.removeEventListener('twitter:follows-changed', refreshSuggest);
  }, [sourceId]);

  // 推荐行上的一键关注：与详情页 toggleTwitterFollow 同一份数据流（settings.twitterUsers + 事件）
  const followSuggested = async (handle) => {
    try {
      const s = await getSettings();
      const users = parseUserList(s?.twitterUsers || '');
      if (users.includes(handle)) return;
      await saveSettings({ ...s, twitterUsers: [...users, handle].join('\n') });
      showToast(`已关注 @${handle}`, { type: 'success' });
      window.dispatchEvent(new CustomEvent('twitter:follows-changed', { detail: { user: handle, followed: true } }));
    } catch {
      showToast('操作失败', { type: 'error' });
    }
  };

  // 注意：已喜欢/已保存的作品保留在当前网格，仅在 fetchPage 中对后续新页过滤

  const needCookie = !isBooru && isCookieErrorCode(feed.errorCode);

  return (
    <div className="page">
      {needCookie
        ? <NeedCookieNotice onOpenSettings={onOpenSettings} />
        : (feed.error && (
          <div className="error-box">
            {feed.error}
            <button className="error-retry" onClick={() => feed.load(false)}>重试</button>
          </div>
        ))}
      {sourceId === 'twitter' && suggested && suggested.length > 0 && (
        (() => {
          const total = suggested.length;
          // 候选池 > 一批时模回绕轮换，避免 offset 越界；≤ 一批直接全显（无换一批按钮）
          const batch = total <= SUGGEST_BATCH
            ? suggested
            : Array.from({ length: SUGGEST_BATCH }, (_, i) => suggested[(suggestOffset + i) % total]);
          return (
            <div className="suggest-row" role="list" aria-label="推荐博主">
              {batch.map(u => (
                <div className="suggest-chip" key={u.username} role="listitem">
                  <button
                    type="button"
                    className="suggest-chip-main"
                    onClick={() => onSearchTag?.(`@${u.username}`)}
                    title={`查看 @${u.username} 的媒体`}
                  >
                    {u.avatar
                      ? <img className="suggest-chip-avatar" src={u.avatar} alt="" loading="lazy" />
                      : <span className="suggest-chip-avatar suggest-chip-avatar--ph">{u.fullname.slice(0, 1)}</span>}
                    <span className="suggest-chip-names">
                      <span className="suggest-chip-name">{u.fullname}</span>
                      <span className="suggest-chip-handle">@{u.username}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="glass-icon-btn suggest-chip-follow"
                    aria-label={`关注 @${u.username}`}
                    title={`关注 @${u.username}`}
                    onClick={() => followSuggested(u.username)}
                  >
                    <FollowIcon />
                  </button>
                </div>
              ))}
              {total > SUGGEST_BATCH && (
                <button
                  type="button"
                  className="glass-icon-btn suggest-more"
                  aria-label="换一批推荐博主"
                  title="换一批"
                  onClick={() => setSuggestOffset(o => (o + SUGGEST_BATCH) % total)}
                >⟳</button>
              )}
            </div>
          );
        })()
      )}
      <ImageGrid items={feed.items} likedSet={likedSet} onOpen={onOpen} />
      {!feed.loading && feed.hasMore && <div ref={feed.sentinelRef} style={{ height: 1 }} />}
      {/* pixiv 来源首拉需等 cacheReady（含相册权限申请），骨架屏占位避免整页空白。
          下拉刷新（列表已有内容）时不叠骨架，只靠原生下拉反馈表达 */}
      {feed.loading && feed.items.length === 0 && <SkeletonGrid count={12} />}
      {feed.loadingMore && <div className="feed-spinner" role="status" aria-label="加载中" />}
      {!feed.loading && feed.appendError && (
        <div className="hint hint--error" onClick={feed.retryAppend} role="button">
          加载失败，点击重试
        </div>
      )}
      {!feed.loading && !feed.appendError && !feed.hasMore && feed.items.length > 0 && <div className="hint">没有更多了</div>}
    </div>
  );
}
