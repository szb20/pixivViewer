/**
 * mediaDims — 「学到的」图片真实尺寸缓存。
 *
 * 为什么需要：Nitter RSS / 部分列表接口不提供图片宽高（X 源恒为 0），
 * 网格卡片与详情页只能猜比例（伪随机 / 3:4 兜底），猜错就会：
 *   - 网格：卡片形状与图片不符（object-fit 跑去裁剪）
 *   - 详情：占位框在图片加载完成后跳变成真实形状
 * 缩略图/预览图加载完成时浏览器能测到 naturalWidth/Height（twitter 的
 * name=small 等档位是等比缩放，比例与原图一致），把测到的值存下来：
 *   - 内存 Map：本会话内网格 → 详情共享
 *   - localStorage：跨重启保留，回看不再跳变
 *
 * 只有来源拿不到 API 尺寸的图才依赖这里（pixiv/booru 列表都自带宽高），
 * 写入方都跳过方形裁剪缩略图（见 GridItem / DetailPageBlock 的守卫）。
 */
import { useSyncExternalStore } from 'react';
import { appStorage, migrateFromLegacyKey } from './appStorage.js';

const DIMS_NS = 'mediaDims';
const MAX_ENTRIES = 1000;

/** 'illustId:page' → { w, h }；Map 迭代保持插入序，超限从最旧的开始淘汰 */
const dims = new Map();
let version = 0;
const listeners = new Set();

// 早期版本的独立 key 一次性迁移到统一存储
migrateFromLegacyKey('pixivviewer:mediaDims', DIMS_NS);

function emit() {
  version += 1;
  for (const fn of listeners) fn();
}

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      while (dims.size > MAX_ENTRIES) dims.delete(dims.keys().next().value);
      appStorage.set(DIMS_NS, [...dims.entries()]);
    } catch { /* 私密模式/写满：忽略，内存缓存仍然生效 */ }
  }, 800);
}

try {
  const raw = appStorage.get(DIMS_NS, []);
  if (Array.isArray(raw)) {
    for (const [k, v] of raw) {
      if (v?.w > 0 && v?.h > 0) dims.set(k, { w: v.w, h: v.h });
    }
  }
} catch { /* 损坏的历史数据：当没有 */ }

/** 读某个作品某页的已知尺寸；不知道返回 null */
export function getMediaDims(illustId, page = 0) {
  return dims.get(`${illustId}:${page}`) || null;
}

/**
 * 方形裁剪缩略图判定：pixiv 的方形裁剪图（宫格 250×250、瀑布流 master 540×540、
 * 部分 1200×1200）是裁出来的，不代表原图比例，测到也不能入库。
 * （X 的等比档位最大 680，真方图不会撞这三个数。）
 */
export function isSquareCropThumb(nw, nh) {
  return nw === nh && (nw === 250 || nw === 540 || nw === 1200);
}

/**
 * 记录测到的真实尺寸。0/负值直接忽略；比例没变不重复触发
 * （不同档位的等比缩放宽高不同，但比例一致）。
 */
export function rememberMediaDims(illustId, page, w, h) {
  if (!illustId || !(w > 0) || !(h > 0)) return;
  const key = `${illustId}:${page}`;
  const prev = dims.get(key);
  if (prev) {
    if (Math.abs(prev.w / prev.h - w / h) < 0.005) return;
    dims.delete(key); // 重新插入保持新鲜度（淘汰时先淘汰最旧的）
  }
  dims.set(key, { w, h });
  schedulePersist();
  emit();
}

/** 宽高 → CSS aspect-ratio 用的 'w / h' 字符串；缺一边给空串 */
export function ratioOfSize(w, h) {
  return w && h ? `${w} / ${h}` : '';
}

/**
 * 详情页比例解析 —— 全应用唯一的优先级顺序（收口，改动顺序只改这里）：
 *   本页实测（pageRatios，DetailPageBlock 预览加载后测得）
 *   → 接口尺寸（详情接口 images[page] 的宽高）
 *   → 列表尺寸（列表条目自带的 width/height）
 *   → 学到的尺寸（mediaDims，缩略图/预览加载时测得并持久化）
 *   → 调用方兜底（占位 3:4）
 * 入参全是 'w / h' 串或空串，实测值本质就是第 4 层的会话内缓存，所以排最前。
 */
export function resolveRatio({
  measured = '',
  api = '',
  list = '',
  illustId,
  page = 0,
  fallback = '',
} = {}) {
  if (measured) return measured;
  if (api) return api;
  if (list) return list;
  const d = getMediaDims(illustId, page);
  if (d) return `${d.w} / ${d.h}`;
  return fallback;
}

/** 网格等消费方订阅：任何一次学到的尺寸都会触发按真实比例重排 */
export function useMediaDimsVersion() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => version,
  );
}
