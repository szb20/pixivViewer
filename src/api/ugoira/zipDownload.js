/**
 * Ugoira ZIP 下载。
 *
 * 流式（prod 主路径，边下边解）+ 缓冲（dev 代理 / prod 回退）双路径。
 */
import { CapacitorHttp } from '@capacitor/core';
import { isDesktopShell, getDesktopProxyPort } from '../../utils/platform.js';
import { base64ToBytes } from '../../utils/bytes.js';
import { createUnzipper } from './unzip.js';
import { saveZipToDisk, ZIP_CACHE_MAX_BYTES } from './zipDiskCache.js';

const IS_DEV = import.meta.env.DEV;

/**
 * i.pximg.net → i.pixiv.re：CDN 要求 pixiv Referer（浏览器 fetch 无法设置，WebView 会 403），
 * 而 i.pixiv.re 无需该 Referer 且带 Access-Control-Allow-Origin: *，与图片缩略图同一通道。
 */
export function proxyZipUrl(url) {
  return String(url || '').replace(/i\.pximg\.net/gi, 'i.pixiv.re');
}

/**
 * ZIP 代理拉取地址（仅桌面壳 / dev 有代理通道）：返回 /pixiv-zip 完整 URL（Node 侧带 Referer + Clash，无 CORS），
 * 返回 null 表示无代理通道（prod 安卓直连）。
 */
async function zipProxyFetchUrl(url) {
  const enc = encodeURIComponent(url);
  if (IS_DEV) return `/pixiv-zip/${enc}`;
  if (isDesktopShell()) {
    const port = await getDesktopProxyPort();
    if (!port) throw new Error('桌面代理端口不可用');
    return `http://127.0.0.1:${port}/pixiv-zip/${enc}`;
  }
  return null;
}

/**
 * 流式下载 + 边下边解（prod 主路径）：
 * fetch reader 分块收 ZIP → 逐块喂给 fflate Unzip → 每帧解出立即生成 blob URL。
 * 全程不落地整包（无 base64 整包转码，不会撑爆 WebView 堆），进度 20→85 连续推进。
 */
export async function streamUgoira(id, meta, onProgress) {
  const url = proxyZipUrl(meta.originalSrc);
  // 桌面壳走壳内代理（Node 侧带 Referer + Clash，行为确定）；web/prod 安卓直连 i.pixiv.re（ACAO:*）
  const fetchUrl = (await zipProxyFetchUrl(url)) || url;

  const ctrl = new AbortController();
  // 停滞检测：只在「没有任何数据到达」超过 90 秒时才中止；
  // 慢速但持续有数据的下载不会被误杀。
  const STALL_MS = 90000;
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ctrl.abort(), STALL_MS);
  };
  armStall(); // 连接阶段也算停滞计时
  let resp;
  try {
    resp = await fetch(fetchUrl, { signal: ctrl.signal });
  } catch (e) {
    throw new Error(`ZIP 请求失败: ${e.name === 'AbortError' ? '下载停滞超时' : e.message}`);
  } finally {
    clearTimeout(stallTimer);
  }
  if (!resp.ok) throw new Error(`ZIP 下载失败: HTTP ${resp.status}`);
  if (!resp.body?.getReader) throw new Error('当前 WebView 不支持流式读取');

  const total = Number(resp.headers.get('Content-Length')) || 0;
  // 只有尺寸可接受才收集字节块用于落盘（避免为大包额外占内存）
  const collectForCache = total === 0 || total <= ZIP_CACHE_MAX_BYTES;
  const zipChunks = collectForCache ? [] : null;
  const reader = resp.body.getReader();
  let received = 0;
  let lastPct = -1;
  const report = (pct) => {
    const p = Math.max(20, Math.min(85, Math.round(pct)));
    if (p !== lastPct) {
      lastPct = p;
      onProgress?.(p);
    }
  };

  return await new Promise((resolve, reject) => {
    const fail = (err) => {
      try { ctrl.abort(); } catch { /* ignore */ }
      // 释放已解出的帧 blob：否则下载停滞/解压出错时，几十帧 1200px 的 blob 会一直驻留
      try { unzipper.abandon(); } catch { /* ignore */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const unzipper = createUnzipper(meta, (done, totalFrames) => {
      report(55 + (done / totalFrames) * 30);
    });

    (async () => {
      try {
        for (; ;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength || 0;
          armStall(); // 有数据到达 → 重置停滞计时
          zipChunks?.push(value);
          unzipper.feed(value, false);
          if (total > 0) report(20 + (received / total) * 35);
        }
        clearTimeout(stallTimer);
        unzipper.feed(new Uint8Array(0), true);
        const frames = unzipper.finish();

        // 落盘缓存（不阻塞播放；失败只记日志）
        if (zipChunks) {
          saveZipToDisk(id, meta, zipChunks).catch(() => { });
        }
        resolve(frames);
      } catch (e) {
        clearTimeout(stallTimer);
        fail(e.name === 'AbortError' ? new Error('ZIP 下载停滞超时') : e);
      }
    })();
  });
}

/**
 * 下载 Ugoira ZIP（兜底缓冲版）。
 * 桌面壳 / dev：走代理服务的 /pixiv-zip；prod 安卓：CapacitorHttp 原生下载（可带 pixiv Referer），分块 base64 解码。
 * @returns {Promise<ArrayBuffer>}
 */
export async function downloadZip(url) {
  const proxyUrl = await zipProxyFetchUrl(url);
  if (proxyUrl) {
    const zipResp = await fetch(proxyUrl);
    if (!zipResp.ok) throw new Error(`ZIP 下载失败: HTTP ${zipResp.status}`);
    return await zipResp.arrayBuffer();
  }

  const resp = await CapacitorHttp.request({
    method: 'GET',
    url,
    headers: { Referer: 'https://www.pixiv.net/' },
    responseType: 'blob',
    connectTimeout: 120000,
    readTimeout: 120000,
  });
  if (resp.status < 200 || resp.status >= 300) throw new Error(`ZIP 下载失败: HTTP ${resp.status}`);
  const raw = resp.data;
  let base64 = typeof raw === 'string' ? raw : (raw?.data || '');
  base64 = base64.includes(',') ? base64.split(',')[1] : base64;
  if (!base64) throw new Error('ZIP 下载失败: 数据为空');
  // 分块解码，避免一次性生成整份巨型二进制字符串（降低峰值内存）
  return base64ToBytes(base64).buffer;
}
