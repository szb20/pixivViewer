/**
 * 浏览器版 Ugoira 动图加载 — 下载 ZIP → 解帧 → 生成 blob URL 帧序列。
 *
 * 链路：/ajax/illust/{id}/ugoira_meta 取元数据 →
 *       /pixiv-zip 代理下载 ZIP → jszip 解压 → 每帧生成 blob URL。
 * UgoiraPlayer 约定 result.frames = [{ path, delay }]。
 */
import JSZip from 'jszip';
import { browserFetch } from './pixiv.js';

const cache = new Map(); // illustId -> { frames, meta }

export async function fetchUgoiraFrames(illustId, onProgress) {
  const id = String(illustId);
  const cached = cache.get(id);
  if (cached) return cached;

  onProgress?.(5);
  const metaResp = await browserFetch(`/ajax/illust/${id}/ugoira_meta`, { skipCookie: false });
  const body = metaResp?.body;
  if (!body?.originalSrc || !body?.frames?.length) {
    throw new Error(body?.error_message || 'GIF 元数据未找到');
  }
  onProgress?.(20);

  const zipResp = await fetch(`/pixiv-zip/${encodeURIComponent(body.originalSrc)}`);
  if (!zipResp.ok) throw new Error(`ZIP 下载失败: HTTP ${zipResp.status}`);
  const zipBuf = await zipResp.arrayBuffer();
  onProgress?.(55);

  const zip = await JSZip.loadAsync(zipBuf);
  const entries = Object.keys(zip.files)
    .filter(name => !zip.files[name].dir)
    .sort();

  const urls = [];
  for (let i = 0; i < entries.length; i++) {
    const blob = await zip.files[entries[i]].async('blob');
    urls.push(URL.createObjectURL(blob));
  }
  onProgress?.(85);

  // 按元数据 frames 顺序组装（file 名匹配，匹配不到按压缩包顺序兜底）
  const frames = body.frames.map((f, i) => {
    const fileName = String(f.file || '');
    const idx = fileName
      ? entries.findIndex(n => n.toLowerCase().endsWith(fileName.toLowerCase()))
      : -1;
    const sourceIndex = idx >= 0 ? idx : Math.min(i, urls.length - 1);
    return { path: urls[sourceIndex], delay: f.delay || 100 };
  });

  onProgress?.(100);
  const result = { frames, meta: body };
  cache.set(id, result);
  return result;
}
