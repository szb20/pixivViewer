/**
 * 图片 URL 生成 —— 与来源/档位相关的换算都收在这里。
 *
 * 放在 utils 而不是组件文件里：`ImageGrid.jsx` 早就被 `ImageDetailView` 反过来 import
 * 这个函数，形成组件↔组件的隐性依赖，也让 fast-refresh 失效。
 *
 * ── 档位速查（实测，2026-10）────────────────────────────────
 *   i.pixiv.re 路径                              状态
 *   img-master/..._master1200.jpg                200  约 300KB   ← 高清档
 *   c/540x540_70/img-master/..._master1200.jpg   200  约 30KB    ← 网格/详情默认
 *   c/600x600_70/、c/900x900_70/、c/1200x1200_70/ 403  ← 全被拒
 * 所以「更大」不等于「换个更大的 c/ 尺寸」——pixiv.re 只放行 540 这一种裁剪前缀，
 * 要更高清只能退回**不带 c/ 前缀**的 img-master 原图。加新档位前先用 curl 验一遍。
 */
import { pixivPageUrl } from '../pixiv-assistant/core/utils.js';

/**
 * 生成等比预览图 URL（Pixiv）。
 *
 * @param {string} url    任意该作品的图片 URL（缩略图/原图均可，内部会解析出 illustId）
 * @param {number} [page] 页码
 * @param {string} [source] 来源 id；非 pixiv 原样返回
 * @param {number} [max]  预览档位上限，默认 540（网格用）。
 *                        传 >540 表示要高清档，见文件头的档位速查。
 */
export function masonryThumbUrl(url, page = 0, source = 'pixiv', max = 540) {
  if (!url || typeof url !== 'string') return '';
  if (source && source !== 'pixiv') return url;
  // 先转成等比底座（已处理 dev 代理）
  const base = pixivPageUrl(url, page, 1200);
  if (!base) return '';
  if (max > 540) return base;
  // 540 档：pixivPageUrl 一律产出 img-master，故这里只需处理 img-master 一种路径
  return base
    .replace('https://i.pixiv.re/img-master', `https://i.pixiv.re/c/${max}x${max}_70/img-master`)
    .replace('/pixiv-img/img-master', `/pixiv-img/c/${max}x${max}_70/img-master`);
}
