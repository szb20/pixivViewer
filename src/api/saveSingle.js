/**
 * 单条保存 — 非多页来源（booru：一条 post 就是一张图）的入口。
 *
 * saveAllPages 面向「一个作品 N 页」，对单页来源用它会绕一圈无意义的循环；
 * 这里直接走 saveItem，语义更清楚，也避免误调 Pixiv 的取详情接口。
 */
import { saveItem } from './index.js';

/**
 * @param {object} item — 统一条目（illustId / source / originalUrl / mediumUrl / thumbnailUrl / title …）
 * @returns {Promise<{success?: boolean, cached?: boolean, idempotent?: boolean, skipped?: boolean, error?: string}>}
 */
export async function saveSingleItem(item) {
  if (!item?.illustId) return { success: false, error: 'invalid_item' };
  return await saveItem({
    ...item,
    _pageIndex: item._pageIndex ?? 0,
    _silent: item._silent !== false,
  });
}
