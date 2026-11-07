/**
 * 红心 ↔ Pixiv 远端收藏同步编排。
 *
 * 原则：本地红心为唯一可信源（乐观更新立即反馈），远端同步 best-effort、
 * fire-and-forget——失败只 toast 提示、不回滚本地红心，也不阻塞「喜欢后自动下载」。
 * 仅 pixiv 源且已登录时触发；booru 源无远端收藏概念，直接跳过。
 */

import { pixivApi } from './pixiv.js';
import { sourceOfId } from '../pixiv-assistant/index.js';
import { showToast } from '../utils/toast.js';

// 按作品串行化：同一作品快速连点（喜欢→取消→喜欢）时按顺序执行，
// 防止「取消」晚于第二次「收藏」返回把收藏删掉
const inflight = new Map();

/**
 * 同步单作品的远端收藏状态。
 * @param {object} opts
 * @param {string|number} opts.illustId
 * @param {string} [opts.source] 图源（缺省从 id 前缀推导）
 * @param {boolean} opts.targetLiked 红心目标态：true=收藏，false=取消收藏
 */
export function syncBookmark({ illustId, source, targetLiked }) {
  const src = source || sourceOfId(illustId);
  if (!illustId || (src && src !== 'pixiv')) return Promise.resolve(false);
  const id = String(illustId);

  const run = (prev) => prev
    .catch(() => { })
    .then(() => _doSync(id, targetLiked));

  const next = run(inflight.get(id) || Promise.resolve());
  inflight.set(id, next);
  next.finally(() => {
    // 队尾且已结束时清理（后续排队者会带着新引用）
    if (inflight.get(id) === next) inflight.delete(id);
  });
  return next;
}

async function _doSync(id, targetLiked) {
  let result;
  try {
    result = targetLiked
      ? await pixivApi.bookmarkIllust(id)
      : await pixivApi.unbookmarkIllust(id);
  } catch {
    result = { success: false };
  }
  // 未登录：静默跳过（本地红心照常，不打扰）
  if (result?.error === 'no_cookie') return false;
  if (!result?.success) {
    showToast(targetLiked ? '已喜欢，同步收藏失败' : '已取消，收藏移除失败', { type: 'warning' });
    return false;
  }
  // 修详情 LRU 缓存，防 5 分钟内详情页红心回显错误；顺带存 bookmarkId，取消收藏可省一次详情请求
  try { pixivApi.patchIllustCache(id, { bookmarked: targetLiked, bookmarkId: targetLiked ? result?.bookmarkId : null }); } catch { }
  // 幂等命中（远端本来就处于目标态）不弹「已移除」——那会误导用户以为刚刚删了什么
  if (!targetLiked && !result?.already) showToast('已从 Pixiv 收藏夹移除', { type: 'info' });
  return true;
}
