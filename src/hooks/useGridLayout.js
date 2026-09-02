/**
 * useGridLayout — 网格布局偏好（瀑布流 / 方形宫格）。
 *
 * 设置项 `gridLayout`：'waterfall'（默认，按图真实比例密铺）/ 'grid'（方形宫格）。
 * 所有内容页共用此开关；手机端也生效（瀑布流在窄屏下固定 2 列）。
 *
 * 返回 ImageGrid 可直接使用的 layout：'masonry' | 'grid'。
 * 设置页保存后会 dispatch `pixiv:grid-layout-changed`，各页即时切换。
 */
import { useEffect, useState } from 'react';
import { getSettings } from '../pixiv-assistant/index.js';

function toLayout(value) {
  return value === 'grid' ? 'grid' : 'masonry';
}

export function useGridLayout() {
  const [layout, setLayout] = useState('masonry');

  useEffect(() => {
    let cancelled = false;
    getSettings().then((s) => {
      if (!cancelled) setLayout(toLayout(s.gridLayout));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onChange = (e) => setLayout(toLayout(e.detail));
    window.addEventListener('pixiv:grid-layout-changed', onChange);
    return () => window.removeEventListener('pixiv:grid-layout-changed', onChange);
  }, []);

  return layout;
}
