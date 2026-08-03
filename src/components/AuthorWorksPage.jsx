import { useEffect, useState } from 'react';
import { registerBackHandler } from '../utils/backHandler.js';
import { gridThumbUrl } from '../utils/quality.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AuthorWorks');
/** 最多拉取的作品数（profile/all 返回全部 ID，这里取前 N 个） */
const PAGE_LIMIT = 200;

/**
 * 全屏"作者作品"页 — 网格展示某画师的作品，点击可打开详情。
 * 叠加在详情页之上，系统返回键先关闭本页。
 */
export default function AuthorWorksPage({ authorId, authorName, onClose, onOpenImage }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // 系统返回手势/返回键：先关本页
  useEffect(() => {
    return registerBackHandler(() => {
      onClose();
      return true;
    });
  }, [onClose]);

  useEffect(() => {
    if (!authorId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await window.api.fetchUserIllusts?.(authorId, { limit: PAGE_LIMIT });
        if (cancelled) return;
        const list = (r?.illusts || []).map(it => ({
          ...it,
          author: it.authorName || authorName || '',
          authorName: it.authorName || authorName || '',
          title: it.title || '',
        }));
        setItems(list);
        if (!list.length) setError(r?.error || '该作者暂无作品');
      } catch (e) {
        if (cancelled) return;
        log.warn('作者作品加载失败:', e?.message || e);
        setError('加载失败，请重试');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [authorId, authorName]);

  return (
    <div className="author-works-overlay">
      <div className="author-works-header">
        <button className="author-works-back" onClick={onClose} aria-label="返回">‹</button>
        <span className="author-works-title">@{authorName || authorId} 的作品</span>
      </div>
      <div className="author-works-content">
        {loading && <div className="hint">加载中...</div>}
        {error && <div className="error-box">{error}</div>}
        {!loading && !error && (
          <div className="pixiv-grid">
            {items.map(it => (
              <div key={it.illustId} className="pixiv-grid-item" onClick={() => onOpenImage?.(it)}>
                <div className="media-card-thumb-wrap">
                  <img
                    className="media-card-thumb"
                    src={gridThumbUrl(it.thumbnailUrl)}
                    alt={it.title || it.illustId}
                    loading="lazy"
                    onError={e => { e.target.style.display = 'none'; }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
