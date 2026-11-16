/**
 * 「账号态 / 本地数据」页签（关注 / 订阅 / 喜欢 / 收藏）的定义与按来源裁剪。
 *
 * 「我」页签拆开后，这些直接是主导航的顶级 tab：useVisibleTabs 用 getMeSubTabs
 * 过滤当前来源实际显示哪几项 —— 过滤逻辑只此一份，避免导航与页面各判一次。
 */
import { getSource } from '../sources/registry.js';

// key 即主 tab key（useVisibleTabs 的 TABS 直接展开这一份）
export const ME_SUB_TABS = [
  { key: 'following', label: '关注' },
  { key: 'subscriptions', label: '订阅' },
  { key: 'liked', label: '喜欢' },
  { key: 'bookmarks', label: '收藏' },
];

/** 该来源下实际可用的页签（「喜欢」是本地数据，任何来源恒可用；侧边栏把它渲染到底部全局组） */
export function getMeSubTabs(sourceId) {
  // X：没有 Pixiv 账号态面板，但有自己的「关注」时间线（XFollowingPanel，直连/回落自动）
  if (sourceId === 'twitter') {
    return ME_SUB_TABS.filter(t => t.key === 'following' || t.key === 'liked');
  }
  return getSource(sourceId).caps.accountTabs === false
    ? ME_SUB_TABS.filter(t => t.key === 'liked')
    : ME_SUB_TABS;
}
