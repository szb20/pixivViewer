/**
 * 「我」页的二级页签定义。
 *
 * 侧边栏（桌面）与 MePage（手机）共用这一份，避免两处各写一份过滤逻辑 ——
 * 否则 booru 来源下侧边栏会多出三个拉不到数据的项。
 */
import { getSource } from '../sources/registry.js';

// caps.accountTabs 为 false 的来源（booru）没有账号态：关注/订阅/收藏都拉不到数据，
// 只留本地数据源「喜欢」。
export const ME_SUB_TABS = [
  { key: 'following', label: '关注' },
  { key: 'subscriptions', label: '订阅' },
  { key: 'liked', label: '喜欢' },
  { key: 'bookmarks', label: '收藏' },
];

/** 该来源下实际可用的子页签 */
export function getMeSubTabs(sourceId) {
  return getSource(sourceId).caps.accountTabs === false
    ? ME_SUB_TABS.filter(t => t.key === 'liked')
    : ME_SUB_TABS;
}

/**
 * 把 store 里的子页签收敛到该来源可用的项（booru 只剩「喜欢」）。
 * 切来源后 store 里可能留着别处的 key —— 停在「关注」会渲染出拉不到数据的面板，
 * 侧边栏的高亮也会落在不存在的项上。侧边栏与 MePage 共用这一份，避免两处各判一次。
 * 不把兜底值写回 store：切回 pixiv 时仍能恢复原来的子页。
 */
export function clampMeSubTab(tabs, raw) {
  return tabs.some(t => t.key === raw) ? raw : tabs[0]?.key;
}
