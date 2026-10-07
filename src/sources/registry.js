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
import { API_CLIENT_UA } from './shared.js';

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
 * @property {string} [userAgent]    — 覆盖默认 UA（见 shared.js 的 API_CLIENT_UA 说明）
 */

/**
 * @typedef {object} SourceDef
 * @property {string} id
 * @property {string} label       — 完整名（设置页 / 详情页外链文案）
 * @property {string} shortLabel  — 短名（胶囊按钮）
 * @property {{min:number,max:number}} ratioRange — 瀑布流卡片宽高比允许范围（w/h）：
 *                                   插画生态（pixiv）只放竖/方；图库/壁纸站放开竖图范围，
 *                                   横图统一钳 1:1（放开横图后横向卡片过小，已回退）
 * @property {SourceCaps} caps
 * @property {SourceNet} net
 * @property {string} [kind]      — 适配器类型：'moebooru' | 'danbooru' | 'gelbooru' | 'wallhaven'
 *                                  | 'zerochan'
 *                                  （由 sources/api.js 的 FACTORIES 分发；'pixiv' 没有适配器）
 * @property {number} [feedMinScore] — 推荐流 score:>=N 阈值按源覆盖（默认见各适配器的
 *                                  FEED_MIN_SCORE；sakugabooru 投票少，20 会筛成空流）
 */

/** @type {Record<string, SourceDef>} */
export const SOURCES = {
  pixiv: {
    id: 'pixiv',
    label: 'Pixiv',
    shortLabel: 'Pixiv',
    kind: 'pixiv',
    ratioRange: { min: 0.5, max: 1 }, // 插画生态：竖/方为主，横图保持钳方（历史行为）
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
    ratioRange: { min: 0.5, max: 1 }, // 横图钳 1:1：放开横图后横向卡片过小，统一方化
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
    ratioRange: { min: 0.5, max: 1 }, // 横图钳 1:1：放开横图后横向卡片过小，统一方化
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
  'konachan-net': {
    id: 'konachan-net',
    label: 'Konachan.net',
    shortLabel: 'Kona-S',
    kind: 'moebooru',
    ratioRange: { min: 0.5, max: 1 }, // 横图钳 1:1：放开横图后横向卡片过小，统一方化
    caps: {
      feed: true, ranking: true, search: true, multiPage: false,
      follow: false, related: false, ugoira: false, accountTabs: false,
    },
    net: {
      // konachan.com 的纯 SFW 镜像，同一套 Moebooru API，只是站内过滤掉 R18。
      // ⚠️ 站点在 Cloudflare 后面：直连（不经代理）会吃到 JS 挑战，
      //    走 booru-proxy 的 Node 通道则正常（实测 200）。
      apiOrigin: 'https://konachan.net',
      apiPrefix: '/konachan-net-api',
      imgHosts: { 'konachan.net': '/konachan-net-img' },
    },
  },
  danbooru: {
    id: 'danbooru',
    label: 'Danbooru',
    shortLabel: 'Danbooru',
    kind: 'danbooru',
    ratioRange: { min: 0.5, max: 1 }, // 横图钳 1:1：放开横图后横向卡片过小，统一方化
    caps: {
      feed: true, ranking: true, search: true, multiPage: false,
      follow: false, related: false, ugoira: false, accountTabs: false,
    },
    net: {
      apiOrigin: 'https://danbooru.donmai.us',
      apiPrefix: '/danbooru-api',
      imgHosts: { 'cdn.donmai.us': '/danbooru-img' },
      // 必须用非浏览器 UA：Cloudflare 会拒掉「Chrome UA + 非浏览器 TLS 指纹」的组合
      userAgent: API_CLIENT_UA,
    },
  },
  safebooru: {
    id: 'safebooru',
    label: 'Safebooru',
    shortLabel: 'Safebooru',
    kind: 'gelbooru',
    ratioRange: { min: 0.5, max: 1 }, // 横图钳 1:1：放开横图后横向卡片过小，统一方化
    caps: {
      feed: true, ranking: true, search: true, multiPage: false,
      follow: false, related: false, ugoira: false, accountTabs: false,
    },
    net: {
      // 唯一一个实测大陆网络可直连的图库（无需代理），且免 API key、无防盗链。
      // 内容是 Danbooru 的 SFW 子集镜像。
      apiOrigin: 'https://safebooru.org',
      apiPrefix: '/safebooru-api',
      imgHosts: { 'safebooru.org': '/safebooru-img' },
    },
  },
  wallhaven: {
    id: 'wallhaven',
    label: 'Wallhaven',
    shortLabel: 'Wallhaven',
    kind: 'wallhaven',
    ratioRange: { min: 0.4, max: 1 }, // 壁纸站：横图钳 1:1，避免 16:9 卡片过小
    caps: {
      feed: true, ranking: true, search: true, multiPage: false,
      follow: false, related: false, ugoira: false, accountTabs: false,
    },
    net: {
      apiOrigin: 'https://wallhaven.cc',
      apiPrefix: '/wallhaven-api',
      imgHosts: { 'w.wallhaven.cc': '/wallhaven-img', 'th.wallhaven.cc': '/wallhaven-thumb' },
      userAgent: API_CLIENT_UA,
    },
  },
  'safebooru-donmai': {
    id: 'safebooru-donmai',
    label: 'Safebooru Donmai',
    shortLabel: 'SB-Donmai',
    kind: 'danbooru',
    ratioRange: { min: 0.5, max: 1 }, // 横图钳 1:1：放开横图后横向卡片过小，统一方化
    caps: {
      feed: true, ranking: true, search: true, multiPage: false,
      follow: false, related: false, ugoira: false, accountTabs: false,
    },
    net: {
      // Danbooru 官方的 SFW 镜像（safebooru.donmai.us）：与主站同构（含 /explore 榜单），
      // 图床同样是 cdn.donmai.us —— imgHosts 直接复用 danbooru 的代理路由。
      apiOrigin: 'https://safebooru.donmai.us',
      apiPrefix: '/safebooru-donmai-api',
      imgHosts: { 'cdn.donmai.us': '/danbooru-img' },
      userAgent: API_CLIENT_UA,
    },
  },
  tbib: {
    id: 'tbib',
    label: 'TBIB',
    shortLabel: 'TBIB',
    kind: 'gelbooru',
    ratioRange: { min: 0.5, max: 1 }, // 横图钳 1:1：放开横图后横向卡片过小，统一方化
    caps: {
      feed: true, ranking: true, search: true, multiPage: false,
      follow: false, related: false, ugoira: false, accountTabs: false,
    },
    net: {
      // The Big ImageBoard（tbib.org）：老 Gelbooru 0.2 实例，SFW 向。
      // DAPI 只返回 directory/image 组件（URL 由适配器拼，见 gelbooru.js 的 IMG_URL）。
      apiOrigin: 'https://tbib.org',
      apiPrefix: '/tbib-api',
      imgHosts: { 'tbib.org': '/tbib-img' },
    },
  },
  sakugabooru: {
    id: 'sakugabooru',
    label: 'Sakugabooru',
    shortLabel: 'Sakuga',
    kind: 'moebooru',
    ratioRange: { min: 0.5, max: 1 }, // 横图钳 1:1：放开横图后横向卡片过小，统一方化
    caps: {
      feed: true, ranking: true, search: true, multiPage: false,
      follow: false, related: false, ugoira: false, accountTabs: false,
    },
    feedMinScore: 2,   // 作画站投票少：20 会筛成空流（实测 score:>=2 有数据）
    net: {
      // 作画截图站：一半条目是 mp4/webm，适配器按扩展名过滤只留静态图。
      // 图床就是主域名本身（/data/...），API 与图片各走一条代理路由。
      apiOrigin: 'https://www.sakugabooru.com',
      apiPrefix: '/sakugabooru-api',
      imgHosts: { 'www.sakugabooru.com': '/sakugabooru-img' },
    },
  },
  zerochan: {
    id: 'zerochan',
    label: 'Zerochan',
    shortLabel: 'Zerochan',
    kind: 'zerochan',
    ratioRange: { min: 0.5, max: 1 }, // 横图钳 1:1：放开横图后横向卡片过小，统一方化
    caps: {
      feed: true, ranking: false, search: true, multiPage: false,
      follow: false, related: false, ugoira: false, accountTabs: false,
    },
    net: {
      // 自有 JSON 接口（查询词在路径上，见 zerochan.js 文件头）。
      // 图床按档位分三个域：s1（600 档）/ s3（240 缩略图）/ static（full 原图）。
      apiOrigin: 'https://www.zerochan.net',
      apiPrefix: '/zerochan-api',
      imgHosts: {
        's1.zerochan.net': '/zerochan-s1-img',
        's3.zerochan.net': '/zerochan-s3-img',
        'static.zerochan.net': '/zerochan-static-img',
      },
      userAgent: API_CLIENT_UA,
    },
  },
  hypnohub: {
    id: 'hypnohub',
    label: 'Hypnohub',
    shortLabel: 'Hypnohub',
    kind: 'gelbooru',
    ratioRange: { min: 0.5, max: 1 }, // 横图钳 1:1：放开横图后横向卡片过小，统一方化
    caps: {
      feed: true, ranking: true, search: true, multiPage: false,
      follow: false, related: false, ugoira: false, accountTabs: false,
    },
    feedMinScore: 5,   // 投票文化同 tbib：10 会筛成空流，5 起首页 20 条都有票（实测 2026-10）
    net: {
      // 新版 Gelbooru DAPI（直接给 file_url，带 owner 上传者）。
      // ⚠️ 应用层强制 HTTP/2：TLS 能握手，但 HTTP/1.1 请求一律挂起（浏览器默认 h2 所以无感）；
      //    代理路由带 http2 标记，走 proxy-utils.mjs 的 createH2Proxy。
      apiOrigin: 'https://hypnohub.net',
      apiPrefix: '/hypnohub-api',
      imgHosts: { 'hypnohub.net': '/hypnohub-img' },
    },
  },
  xbooru: {
    id: 'xbooru',
    label: 'Xbooru',
    shortLabel: 'Xbooru',
    kind: 'gelbooru',
    ratioRange: { min: 0.5, max: 1 }, // 横图钳 1:1：放开横图后横向卡片过小，统一方化
    caps: {
      feed: true, ranking: true, search: true, multiPage: false,
      follow: false, related: false, ugoira: false, accountTabs: false,
    },
    feedMinScore: 2,   // 全站票少（近期帖普遍 1~3 票），2 起才有满 20 条有票图
    net: {
      // 同 hypnohub：新版 DAPI + 强制 HTTP/2。
      // 图床分两个域：原图在 img.xbooru.com、缩略图在主域（两条代理路由）。
      apiOrigin: 'https://xbooru.com',
      apiPrefix: '/xbooru-api',
      imgHosts: {
        'img.xbooru.com': '/xbooru-img',
        'xbooru.com': '/xbooru-thumb',
      },
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
