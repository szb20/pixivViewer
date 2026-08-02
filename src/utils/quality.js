/**
 * 画质档位工具 — 网格/详情按设置生成对应 URL。
 */
import { getSettingsSync } from '../pixiv-assistant/index.js';

/**
 * 网格缩略图：设置 'mini' 时把 crop 段降为 48×48，'thumb'（默认）保持 250×250。
 * URL 形态：…/c/250x250_80_a2/img-master/…/xxx_p0_square1200.jpg
 */
export function gridThumbUrl(url, quality = getSettingsSync().gridQuality) {
  if (!url) return '';
  if (quality === 'mini') {
    return url.replace(/\/c\/[^/]+(?=\/img-master)/, '/c/48x48');
  }
  return url;
}
