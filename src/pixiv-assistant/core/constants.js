/**
 * Pixiv 模块共享常量。
 *
 * 纯常量，无 Node/Browser 依赖，Electron 主进程 + React 前端共用。
 */

export const PIXIV_BASE = 'https://www.pixiv.net';
export const PIXIV_RE = 'https://pixiv.re';

/** 自动缓存 TTL（7 天） */
export const PIXIV_CACHE_TTL = 7 * 24 * 3600 * 1000;

/** 有效排行榜模式 */
export const RANKING_MODES = [
  'daily', 'weekly', 'monthly', 'rookie', 'original', 'male', 'female',
  'daily_r18', 'weekly_r18', 'monthly_r18', 'male_r18', 'female_r18', 'r18g',
];

/** 排行榜模式中文名 */
export const RANKING_MODE_NAMES = {
  daily: '今日',
  weekly: '本周',
  monthly: '本月',
  rookie: '新人',
  original: '原创',
  male: '男性向',
  female: '女性向',
  daily_r18: '🔞 日榜',
  weekly_r18: '🔞 周榜',
  monthly_r18: '🔞 月榜',
  male_r18: '🔞 男性向',
  female_r18: '🔞 女性向',
  r18g: '🔞 R18G',
};

/** 缓存目录名 */
export const CACHE_DIR = 'PixivViewer';
