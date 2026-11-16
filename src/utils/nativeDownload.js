/**
 * nativeDownload — 原生流式下载（Android StreamingDownload 插件）。
 *
 * 绕开 WebView 对 i.pixiv.re 的 CORS 限制（fetch/XHR 跨域读不到字节）。
 * 数据以拉模式分块过桥（startStream → readChunk×N → closeStream），
 * 避免整份 base64 过桥撑爆 WebView 堆；进度按累计字节在 JS 侧计算。
 *
 * 全程不解码：下游（相册导出）要的就是 base64，每块 atob 逐字节解码、
 * 下完再整份编码回去，等于把几 MB 数据在主线程上来回搬运两遍 ——
 * 这是下载中滑动卡顿的元凶。块大小取 3 的倍数后各块 base64 无填充字符，
 * 可以直接字符串拼接，字节进度从 base64 长度换算。
 */
import { registerPlugin } from '@capacitor/core';
import { isNative } from './platform.js';

const StreamingDownload = registerPlugin('StreamingDownload');

/** 单块 510KB（与原生侧 CHUNK_BYTES 一致；过桥 base64 峰值约 680KB）。
 *  必须是 3 的倍数：否则分块 base64 带填充字符，直接拼接会损坏数据 */
const CHUNK_BYTES = 510 * 1024;

/** base64 字符串 → 字节数（按填充修正；非末块长度是 4 的倍数且无填充，结果为整数） */
function b64ByteLen(s) {
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

export function isNativeDownloadAvailable() {
  return isNative();
}

/**
 * 按目标域名给 Referer：Pixiv 图床与微博 sinaimg 图床校验（空 Referer 也 403），
 * booru 图床不校验。传空字符串即不设置该请求头（原生侧读取时以空串为准）。
 */
function refererFor(url) {
  if (/pximg\.net|pixiv\.re/i.test(url || '')) return 'https://www.pixiv.net/';
  if (/sinaimg\.cn/i.test(url || '')) return 'https://m.weibo.cn/';
  return '';
}

/**
 * 原生流式下载图片，返回 base64。
 * @param {string} url — 完整图片 URL
 * @param {function} [onProgress] — ({pct, loaded, total}) => void
 *        loaded/total 是真实字节数（按累计分块计算），下载管理用它显示大小与速度。
 *        total 归一化为 0 表示上游没给 Content-Length（原生 getContentLengthLong()
 *        无该响应头时返回 -1），此时不报进度（不编造 pct），UI 只显示「下载中」。
 * @returns {Promise<string>} base64 数据
 */
export async function nativeDownload(url, onProgress) {
  const id = `${url}_${Date.now()}`;
  const start = await StreamingDownload.startStream({ url, id, referer: refererFor(url) });
  const total = start?.total > 0 ? start.total : 0;
  // 直接收集各块 base64 字符串，末尾一次 join —— 不在主线程上做任何逐字节搬运
  const parts = [];
  let loaded = 0;
  let lastUiAt = 0;
  const report = (force) => {
    if (!onProgress || total <= 0) return;
    const pct = Math.min(100, Math.floor((loaded * 100) / total));
    const now = Date.now();
    // 节流：最快每 80ms 更新一次 UI，避免快速下载时进度跳动；EOF/100% 强制补报
    if (!force && now - lastUiAt < 80) return;
    lastUiAt = now;
    onProgress({ pct, loaded, total });
  };
  try {
    for (;;) {
      const chunk = await StreamingDownload.readChunk({ id, size: CHUNK_BYTES });
      const data = chunk?.data || '';
      if (data) {
        parts.push(data);
        loaded += b64ByteLen(data);
        report(false);
      }
      if (chunk?.eof) {
        report(true);
        break;
      }
    }
  } catch (e) {
    await StreamingDownload.closeStream({ id }).catch(() => {});
    throw e;
  }
  await StreamingDownload.closeStream({ id }).catch(() => {});
  const base64 = parts.join('');
  if (!base64) throw new Error('下载无数据');
  return base64;
}
