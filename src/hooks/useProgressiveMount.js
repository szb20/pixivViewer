import { useEffect, useRef, useState } from 'react';

/* ===== 渐进挂载：只渲染前 renderCap 个条目，接近末尾经哨兵扩容 =====
 * 触底翻页 + tab 缓存恢复会让 feed 一次挂进数百条；全量挂载 DOM（每卡片
 * 十几个节点 + 事件监听）线性推高滚动 hit-test 与 GC 成本。列分配是
 * 纯计算（plan 对全量 items 计算），渲染前缀 [0, cap) 与全量渲染的上半
 * 部分完全一致 → 扩容只在底部追加，不重排、不重挂。 */
const RENDER_BATCH = 150;

/**
 * 渐进挂载 — 返回 { renderCap, sentinelRef }。
 * sentinelRef 挂在列表末尾的哨兵元素上（条件渲染「还有未渲染条目」时才挂），
 * 进入视口前 800px 即扩容一批。列表重置（total 变小）回到初始窗口。
 * 注意：hook 必须在所有条件 return 之前调用。
 */
export function useProgressiveMount(total) {
  const [renderCap, setRenderCap] = useState(RENDER_BATCH);
  const capRef = useRef(renderCap);
  capRef.current = renderCap;
  // 列表重置（换源/清空，total 变小）回到初始窗口，避免下次恢复直接全量挂载
  useEffect(() => {
    if (total < capRef.current) setRenderCap(RENDER_BATCH);
  }, [total]);
  const sentinelRef = useRef(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        setRenderCap(c => (c < total ? c + RENDER_BATCH : c));
      }
    }, { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [total]);
  return { renderCap, sentinelRef };
}
