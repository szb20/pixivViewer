import { useCallback, useEffect, useRef, useState } from 'react';
import { pixivApi } from '../api/pixiv.js';
import ImageGrid from '../components/ImageGrid.jsx';
import useSavedSet from '../hooks/useSavedSet.js';

const MODES = [
  { key: 'daily', label: '日榜' },
  { key: 'weekly', label: '周榜' },
  { key: 'monthly', label: '月榜' },
  { key: 'male', label: '男榜' },
  { key: 'female', label: '女榜' },
  { key: 'rookie', label: '新人' },
  { key: 'original', label: '原创' },
  { key: 'r18g', label: 'R18G' },
];

// 支持 R-18 变体的分类（monthly / rookie / original 无 R18 档）
const R18_CATEGORIES = new Set(['daily', 'weekly', 'male', 'female']);

export default function RankingPage({ onOpen }) {
  const [category, setCategory] = useState('daily');
  const [r18, setR18] = useState(true);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const pageRef = useRef(1);
  const saved = useSavedSet();
  const mode = r18 && R18_CATEGORIES.has(category) ? `${category}_r18` : category;

  const load = useCallback(async (append) => {
    const page = append ? pageRef.current + 1 : 1;
    if (append) setLoadingMore(true);
    else { setLoading(true); setError(null); }
    try {
      const r = await pixivApi.fetchRanking({ mode, page });
      const list = r?.illusts || [];
      pageRef.current = page;
      setItems(prev => (append ? [...prev, ...list] : list));
      setHasMore(list.length > 0);
      if (!append && !list.length) setError(r?.message || r?.error || '排行榜为空');
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
    setLoadingMore(false);
  }, [mode]);

  useEffect(() => { load(false); }, [load]);

  const handleCategory = (cat) => {
    // 选 R18G 时自动开 R18；选无 R18 档的分类时自动关
    if (cat === 'r18g') setR18(true);
    else if (!R18_CATEGORIES.has(cat)) setR18(false);
    setCategory(cat);
  };

  const handleR18Toggle = () => {
    if (category === 'r18g') return; // R18G 固定 R18
    if (!R18_CATEGORIES.has(category)) return; // 当前分类无 R18 档
    setR18(v => !v);
  };

  return (
    <div className="page">
      <div className="chips">
        {MODES.map(m => (
          <button
            key={m.key}
            className={`chip${m.key === category ? ' active' : ''}`}
            onClick={() => handleCategory(m.key)}
          >{m.label}</button>
        ))}
        <button
          className={`chip r18-toggle${r18 ? ' on' : ''}`}
          onClick={handleR18Toggle}
          style={r18
            ? { background: '#e88090', color: '#fff', borderColor: '#e88090', marginLeft: 'auto' }
            : { marginLeft: 'auto' }}
        >{r18 ? 'R18' : '公开'}</button>
      </div>
      {loading && <div className="skeleton-grid">{[...Array(4)].map((_, i) => <div key={i} className="skeleton-item" />)}</div>}
      {error && <div className="error-box">{error}</div>}
      <ImageGrid items={items} savedSet={saved} onOpen={onOpen} />
      {!loading && items.length > 0 && (
        <button className="load-more" disabled={loadingMore || !hasMore} onClick={() => load(true)}>
          {loadingMore ? '加载中...' : (hasMore ? '加载更多' : '没有更多了')}
        </button>
      )}
    </div>
  );
}
