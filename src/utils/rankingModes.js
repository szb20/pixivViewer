/**
 * 排行榜档位定义 —— 手机端的底部筛选条（RankingPage）与桌面端的侧边栏（SideNav）共用。
 *
 * 两边都要知道「这个来源有哪些档位」「R18 开关当前能不能按」，放一份在这里，
 * 免得侧边栏和页面各判一次然后漂移。
 */
import { booruApiFor } from '../sources/api.js';

/** Pixiv 档位 */
export const PIXIV_MODES = [
  { key: 'daily', label: '日榜' },
  { key: 'weekly', label: '周榜' },
  { key: 'monthly', label: '月榜' },
  { key: 'male', label: '男性向' },
  { key: 'female', label: '女性向' },
  { key: 'rookie', label: '新人' },
  { key: 'original', label: '原创' },
  { key: 'r18g', label: 'R18G' },
];

/** 非 Pixiv 来源的缺省档位（Moebooru 系：popular_recent 的日 / 周 / 月三档） */
export const BOORU_MODES = [
  { key: '1d', label: '日榜' },
  { key: '1w', label: '周榜' },
  { key: '1m', label: '月榜' },
];

/** 支持 R-18 变体的分类（monthly / rookie / original 无 R18 档） */
export const R18_CATEGORIES = new Set(['daily', 'weekly', 'male', 'female']);

/**
 * 该来源可用的档位。
 *
 * 档位由适配器自报（`api.rankingModes`）——各站能提供的排序语义差很远：
 * Moebooru 只有时间窗、Danbooru 是官方 popular 的三档、Wallhaven 有 1d~1y 七档。
 * 没自报的（Moebooru 系）落回 BOORU_MODES。
 * @returns {{modes: Array<{key:string,label:string}>, isBooru: boolean, defaultKey: string}}
 */
export function getRankingModes(sourceId) {
  const api = booruApiFor(sourceId);
  if (!api) return { modes: PIXIV_MODES, isBooru: false, defaultKey: PIXIV_MODES[0].key };
  const modes = api.rankingModes?.length ? api.rankingModes : BOORU_MODES;
  return { modes, isBooru: true, defaultKey: modes[0].key };
}

/** R18 开关当前是否可切换：R18G 固定开 R18，月/新人/原创 三档没有 R18 变体 */
export function canToggleR18(category) {
  return category !== 'r18g' && R18_CATEGORIES.has(category);
}

/**
 * 把 store 里的档位收敛到该来源可用的档位。
 * 切来源后 store 里可能留着另一个站的档位 key（pixiv 的 daily vs booru 的 1d），
 * 侧边栏与页面都用它兜底，避免两处各判一次。
 */
export function clampRankingCategory(modes, raw) {
  return modes.some(m => m.key === raw) ? raw : modes[0].key;
}

/**
 * 选档位时与 R18 的耦合规则（与原 handleCategory 一致）：
 * 选 R18G 自动开 R18；选没有 R18 变体的档位自动关；其余保持不变。
 * @returns {{category: string, r18: boolean}}
 */
export function nextRankingSelection(category, currentR18) {
  if (category === 'r18g') return { category, r18: true };
  if (!R18_CATEGORIES.has(category)) return { category, r18: false };
  return { category, r18: currentR18 };
}
