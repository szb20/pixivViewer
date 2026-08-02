// ═══════════════════════════════════════════════════════
// CharStatePanel 模板共享工具函数与常量
// 从 CharStatePanel.jsx 抽取，供 char-templates/ 下各模板复用
// ═══════════════════════════════════════════════════════

import { pixivReUrl } from '../../pixiv-assistant/core/utils.js';

// ═══════════════════════════════════════════════════════
// 状态标签
// ═══════════════════════════════════════════════════════

export function formatMomentTime(t) {
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  if (diff < 172800000) return '昨天';
  return `${Math.floor(diff / 86400000)}天前`;
}

function affinityLabel(aff) {
  if (aff >= 90) return '生死相托';
  if (aff >= 70) return '亲密挚友';
  if (aff >= 50) return '友好熟识';
  if (aff >= 25) return '萍水相逢';
  return '冷淡疏离';
}

function arousalLabel(ars) {
  if (ars >= 90) return '情欲沸腾';
  if (ars >= 70) return '情欲高涨';
  if (ars >= 50) return '蠢蠢欲动';
  if (ars >= 25) return '隐约萌动';
  return '心如止水';
}

function staminaLabel(sta) {
  if (sta >= 70) return '精力充沛';
  if (sta >= 40) return '正常状态';
  if (sta >= 20) return '疲惫低落';
  return '精疲力竭';
}

function rationalityLabel(rat) {
  if (rat >= 70) return '冷静清醒';
  if (rat >= 40) return '略有波动';
  if (rat >= 20) return '情绪失控';
  return '彻底迷失';
}

function obedienceLabel(obd) {
  if (obd >= 85) return '绝对服从';
  if (obd >= 55) return '高度服从';
  if (obd >= 25) return '顺从配合';
  return '独立自主';
}

// ═══════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════

export const BAR_COLORS = {
  affinity:    '#f0c840',
  arousal:     '#e88090',
  stamina:     '#5cb860',
  rationality: '#5090e0',
  obedience:   '#c050d0',
};

export const ELEMENT_COLORS = {
  '火': '#ef7938', '水': '#4cc2f1', '风': '#75c2c9',
  '雷': '#af6fcf', '冰': '#9fd6e3', '岩': '#fab72e', '草': '#a5c83b',
};

export const STAT_BARS = [
  { label: '好感', key: 'affinity',    labelFn: affinityLabel,     cssKey: 'affinity' },
  { label: '体力', key: 'stamina',     labelFn: staminaLabel,     cssKey: 'stamina' },
  { label: '理智', key: 'rationality', labelFn: rationalityLabel, cssKey: 'rationality' },
  { label: '性欲', key: 'arousal',     labelFn: arousalLabel,     cssKey: 'arousal' },
  { label: '服从', key: 'obedience',   labelFn: obedienceLabel,   cssKey: 'obedience' },
];

// ═══════════════════════════════════════════════════════
// Pixiv 数据处理
// ═══════════════════════════════════════════════════════

/** 将 Pixiv API 返回的原始结果展开为全部页面（格子只渲染 page 0）*/
export function parsePixivResults(rawList) {
  return rawList.flatMap(r => {
    const pageCount = r.pageCount || r._totalPages || 1;
    const illustId = r.illustId;
    const entries = [];
    for (let p = 0; p < pageCount; p++) {
      entries.push({
        ...r,
        illustId,
        _pageIndex: p,
        _totalPages: pageCount,
        _msgId: 'pixiv-gallery',
        type: r.illustType === 2 ? 'gif' : 'image',
        mediumUrl: pixivReUrl(String(illustId), p),
        originalUrl: r.originalUrl || pixivReUrl(String(illustId), p),
        thumbnailUrl: p === 0 ? r.thumbnailUrl : pixivReUrl(String(illustId), p),
      });
    }
    return entries;
  });
}

/** 将 parsePixivResults 条目转为 allMedia 格式，供 ImageDetailView 使用 */
export function allMediaFromRelated(img) {
  const w = img.width || 0;
  const h = img.height || 0;
  return {
    type: img.type === 'gif' ? 'gif' : 'image',
    src: img._pageIndex > 0
      ? pixivReUrl(img.illustId, img._pageIndex)
      : (img.mediumUrl || img.thumbnailUrl),
    title: img.title,
    author: img.author,
    authorId: img.authorId || '',
    authorName: img.authorName || img.author || '',
    authorAccount: img.authorAccount || '',
    pixivUrl: img.pixivUrl,
    illustId: img.illustId,
    _pageIndex: img._pageIndex,
    _totalPages: img._totalPages,
    thumbnailUrl: img.thumbnailUrl,
    mediumUrl: img.mediumUrl,
    originalUrl: img.originalUrl || img.mediumUrl,
    width: w,
    height: h,
    _lazy: img.type === 'gif' ? true : undefined,
  };
}

/** 按作者分组作品列表 */
export function groupByAuthor(rawList) {
  const groups = {};
  for (const item of rawList) {
    const authorId = item.authorId || 'unknown';
    if (!groups[authorId]) {
      groups[authorId] = {
        authorId,
        authorName: item.authorName || item.author || '未知',
        authorAccount: item.authorAccount || '',
        works: [],
      };
    }
    groups[authorId].works.push(item);
  }
  return groups;
}
