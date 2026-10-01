/**
 * 来源注册表 — 全应用唯一的「有哪些图站」清单。
 *
 * caps 是 UI 分支的唯一依据：组件问 caps.follow / caps.related / caps.multiPage，
 * 而不是散落 source === 'pixiv' 判断。新增站点只需在这里加一条 + 写一个适配器。
 *
 * net 是该来源的代理配置，dev/桌面壳的代理路由与前端的 URL 重写都从它派生。
 * ⚠️ scripts/booru-proxy.mjs 里有一份等价的路由表（Node 侧不便直接 import src/），
 *    改这里时务必同步那边。
 */
import { DEFAULT_SOURCE } from '../pixiv-assistant/core/utils.js';

/**
 * @typedef {object} SourceCaps
 * @property {boolean} feed      — 有无「推荐」信息流
 * @property {boolean} ranking   — 有无排行榜
 * @property {boolean} search    — 有无标签搜索
 * @property {boolean} multiPage — 单作品是否有多页
 * @property {boolean} follow    — 有无作者关注（账号态）
 * @property {boolean} related   — 有无相关推荐
 * @property {boolean} ugoira    — 有无动图
 * @property {boolean} accountTabs — 「我」页的账号态子页（关注/收藏/订阅）是否有意义
 */

/**
 * @typedef {object} SourceNet
 * @property {string} apiOrigin      — 生产环境 API 直连源
 * @property {string} apiPrefix      — dev / 桌面壳的 API 代理前缀
 * @property {Record<string,string>} imgHosts — 图片域名 → dev 下的代理前缀
 */

/**
 * @typedef {object} SourceDef
 * @property {string} id
 * @property {string} label       — 完整名（设置页 / 详情页外链文案）
 * @property {string} shortLabel  — 短名（胶囊按钮）
 * @property {SourceCaps} caps
 * @property {SourceNet} net
 * @property {string} [kind]      — 适配器类型，'moebooru' 走 createMoebooruSource
 */

/** @type {Record<string, SourceDef>} */
export const SOURCES = {
  pixiv: {
    id: 'pixiv',
    label: 'Pixiv',
    shortLabel: 'Pixiv',
    kind: 'pixiv',
    caps: {
      feed: true, ranking: true, search: true, multiPage: true,
      follow: true, related: true, ugoira: true, accountTabs: true,
    },
    net: {
      apiOrigin: 'https://www.pixiv.net',
      apiPrefix: '/pixiv-api',
      imgHosts: { 'i.pixiv.re': '/pixiv-img', 'pixiv.re': '/pixiv-img' },
    },
  },
  yande: {
    id: 'yande',
    label: 'yande.re',
    shortLabel: 'yande',
    kind: 'moebooru',
    caps: {
      feed: true, ranking: true, search: true, multiPage: false,
      follow: false, related: false, ugoira: false, accountTabs: false,
    },
    net: {
      apiOrigin: 'https://yande.re',
      apiPrefix: '/yande-api',
      imgHosts: { 'files.yande.re': '/yande-img', 'assets.yande.re': '/yande-thumb' },
    },
  },
  konachan: {
    id: 'konachan',
    label: 'Konachan',
    shortLabel: 'Konachan',
    kind: 'moebooru',
    caps: {
      feed: true, ranking: true, search: true, multiPage: false,
      follow: false, related: false, ugoira: false, accountTabs: false,
    },
    net: {
      apiOrigin: 'https://konachan.com',
      apiPrefix: '/konachan-api',
      imgHosts: { 'konachan.com': '/konachan-img' },
    },
  },
};

/** 设置页 / 来源胶囊里可选的全部来源（顺序即展示顺序） */
export const SOURCE_LIST = Object.values(SOURCES);

/**
 * 取来源定义。未知 id 一律兜底 pixiv ——
 * 历史数据里没有 imageSource 字段，兜底到 pixiv 才能保证老用户打开就是原样。
 * @param {string} [id]
 * @returns {SourceDef}
 */
export function getSource(id) {
  return SOURCES[id] || SOURCES[DEFAULT_SOURCE];
}

/** 该来源的能力集（含兜底） */
export function capsOf(id) {
  return getSource(id).caps;
}
