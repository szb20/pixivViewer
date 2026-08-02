import { useCallback, useEffect, useRef, useState } from 'react';
import { storageFacade } from '../pixiv-assistant/index.js';

const PAGE_SIZE = 24;

export default function GalleryPage() {
  const [items, setItems] = useState([]);
  const [thumbs, setThumbs] = useState({}); // `${illustId}_${page}` -> localUrl
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);
  const thumbsRef = useRef({});

  const load = useCallback(async (append) => {
    setLoading(true);
    try {
      const r = await storageFacade.listByState('saved', offsetRef.current, PAGE_SIZE);
      const list = r?.items || [];
      offsetRef.current += list.length;
      setHasMore((r?.total || 0) > offsetRef.current);
      setItems(prev => (append ? [...prev, ...list] : list));
      // 逐张读取本地文件生成 blob 缩略图（非原生环境读不到文件，显示占位）
      for (const item of list) {
        const id = `${item.illustId}_${item.pageIndex ?? 0}`;
        if (thumbsRef.current[id]) continue;
        const local = await storageFacade.load(item.illustId, item.pageIndex ?? 0);
        if (local?.localUrl) {
          thumbsRef.current[id] = local.localUrl;
          setThumbs(prev => ({ ...prev, [id]: local.localUrl }));
        }
      }
    } catch { /* 忽略 */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(false); }, [load]);

  return (
    <div className="page">
      {loading && items.length === 0 && <div className="hint">加载中...</div>}
      {!loading && items.length === 0 && (
        <div className="error-box">相册为空 — 在推荐/排行/搜索中浏览作品会自动下载</div>
      )}
      <div className="gallery-grid">
        {items.map(item => {
          const id = `${item.illustId}_${item.pageIndex ?? 0}`;
          const src = thumbs[id];
          return (
            <div key={id} className="gallery-item">
              {src ? <img className="gallery-thumb" src={src} alt={item.title || ''} loading="lazy" /> : <span>🖼️</span>}
            </div>
          );
        })}
      </div>
      {!loading && items.length > 0 && hasMore && (
        <button className="load-more" onClick={() => load(true)}>加载更多</button>
      )}
    </div>
  );
}
