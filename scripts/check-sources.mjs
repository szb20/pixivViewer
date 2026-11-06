/**
 * 多来源接入的自检：身份层不依赖 DOM / IndexedDB，可直接跑。
 * 用法：npm run check:sources
 */
// 本脚本是包内自检器，就是要直读内部实现（parseCacheFileName 等不进 barrel），
// 豁免 barrel 导入约束。其余包外代码一律走 pixiv-assistant/index.js。
// oxlint-disable-next-line no-restricted-imports
import { parseCacheFileName, buildCacheFileName, getCompositeKey, qualifyId, sourceOfId, rawIdOf, KNOWN_SOURCES } from '../src/pixiv-assistant/core/utils.js';
import { SOURCE_LIST, getSource, capsOf } from '../src/sources/registry.js';
import { BOORU_ROUTES } from './booru-proxy.mjs';
import { pixivRoutes } from './pixiv-proxy.mjs';

let failed = 0;
function ok(cond, label, extra = '') {
  if (cond) return;
  failed += 1;
  console.error('FAIL:', label, extra);
}

// 1) 老 Pixiv 文件名解析结果必须逐字节不变（含 pageIndex）
ok(parseCacheFileName('12345678.jpg')?.illustId === '12345678', 'bare id');
ok(parseCacheFileName('12345678_p2.jpg')?.pageIndex === 2, 'bare + page');
ok(parseCacheFileName('pixiv_12345678_p3_[moonian]_[Title].jpg')?.illustId === '12345678', 'pixiv prefix');
ok(parseCacheFileName('pixiv_12345678_p3_[moonian]_[Title].jpg')?.pageIndex === 3, 'pixiv prefix page');
ok(parseCacheFileName('pixiv_12345678_p3_[moonian]_[Title].jpg')?.source === undefined, 'pixiv prefix has no source key (老路径不变)');
ok(parseCacheFileName('pixiv_12345678_g0_[a]_[t].gif')?.isGif === true, 'pixiv gif');

// 2) booru 文件名带来源，且 id 已限定来源
const y = parseCacheFileName('yande_1269655_p0_[moonian]_[Title].jpg');
ok(y?.source === 'yande' && y?.illustId === 'yande_1269655', 'booru filename');
const k = parseCacheFileName('konachan_42_g9_[a]_[t].gif');
ok(k?.source === 'konachan' && k?.illustId === 'konachan_42' && k?.pageIndex === 9, 'konachan filename');
// 标题里恰好含来源形状 → 不得误判（白名单 + 前缀必须是来源名）
ok(parseCacheFileName('random_title_x_12_p0_[a]_[t].jpg') === null, 'title-looking name rejected');
// 放宽 altSource 两段字符类后，白名单仍是硬门槛：来源名不在词表里一律拒绝
ok(parseCacheFileName('notasource_216o5y_p0_[a]_[t].jpg') === null, 'unknown source prefix rejected');
// 历史 bug 产出的「双前缀」文件名（KNOWN_SOURCES 漏登记的年代）：解析时要剥掉重复那段，
// 否则相册里那些文件永远对不回元数据
const dup = parseCacheFileName('zerochan_zerochan_12345_p0_[A]_[T].jpg');
ok(dup?.source === 'zerochan' && dup?.illustId === 'zerochan_12345' && dup?.pageIndex === 0, 'double-prefix filename');

// 3) 撞号隔离：同号不同来源得到不同 uid，同来源得到同一 uid
ok(getCompositeKey({ illustId: '100', _pageIndex: 0 }) === '100_0', 'pixiv composite key');
ok(getCompositeKey({ illustId: 'yande_100', _pageIndex: 0 }) === 'yande_100_0', 'booru composite key');
ok(qualifyId('yande', '100') !== qualifyId('pixiv', '100'), 'collision isolation');
ok(sourceOfId('yande_100') === 'yande' && rawIdOf('yande_100') === '100', 'source/raw roundtrip');
ok(sourceOfId('100') === 'pixiv' && rawIdOf('100') === '100', 'pixiv passthrough');

// 4) 注册表契约：caps 齐全、net 前缀唯一（代理路由表按前缀匹配）
for (const s of SOURCE_LIST) {
  for (const cap of ['feed', 'ranking', 'search', 'multiPage', 'follow', 'related', 'ugoira', 'accountTabs']) {
    ok(typeof s.caps[cap] === 'boolean', `${s.id}.caps.${cap} 必须是 boolean`);
  }
  ok(!!s.net?.apiPrefix && !!s.net?.apiOrigin, `${s.id}.net 完整`);
  ok(s.shortLabel !== undefined, `${s.id}.shortLabel 存在`);
}
// 代理前缀唯一性：同一来源内 apiPrefix / 各 imgHosts 前缀不得重复
// （pixiv 的 i.pixiv.re 与 pixiv.re 共用 /pixiv-img 是刻意的：两个域名同一个上游）
const apiPrefixes = SOURCE_LIST.map(s => s.net.apiPrefix);
ok(new Set(apiPrefixes).size === apiPrefixes.length, 'apiPrefix 互不冲突', apiPrefixes.join(','));
// 图床域名归属必须一致：同一域名可以被多个来源认领，但**代理前缀必须相同**，
// 否则 URL 重写会张冠李戴。（safebooru-donmai 复用 danbooru 的 cdn.donmai.us + /danbooru-img
// 是刻意的：同构镜像站、同一图床；同一来源下多域名共用前缀也允许，如 pixiv 的 i.pixiv.re / pixiv.re）
const hostPrefix = new Map();
const hostConflicts = [];
for (const s of SOURCE_LIST) {
  for (const [host, prefix] of Object.entries(s.net.imgHosts)) {
    if (!hostPrefix.has(host)) hostPrefix.set(host, prefix);
    else if (hostPrefix.get(host) !== prefix) hostConflicts.push(`${host}: ${hostPrefix.get(host)} vs ${prefix}`);
  }
}
ok(hostConflicts.length === 0, 'imgHosts 域名归属一致（同域名必须同前缀）', hostConflicts.join(', '));
ok(getSource('nope').id === 'pixiv', '未知来源兜底 pixiv');
ok(capsOf('yande').multiPage === false && capsOf('pixiv').multiPage === true, 'caps 分流依据正确');

// 5) KNOWN_SOURCES 与注册表必须严格一致。
// 这条挡的是最阴的一类回归：注册表加了来源、词表忘了加 → sourceOfId/parseCacheFileName
// 把该来源的 id 判回 pixiv，下载文件名、缓存恢复、点赞 key 全部错位，且不抛任何错。
const registryIds = SOURCE_LIST.map(s => s.id).sort();
ok(
  JSON.stringify([...KNOWN_SOURCES].sort()) === JSON.stringify(registryIds),
  'KNOWN_SOURCES 与 SOURCE_LIST 一致',
  `known=[${[...KNOWN_SOURCES].sort()}] registry=[${registryIds}]`,
);
for (const s of SOURCE_LIST) {
  // sourceOfId 按第一个下划线切分，来源 id 含下划线会让 rawIdOf 取到半截
  ok(!s.id.includes('_'), `${s.id} 不得含下划线`, s.id);
}
// 顺带验证：每个非 pixiv 来源的 qualifier 都能原样解析回来
for (const s of SOURCE_LIST) {
  if (s.id === 'pixiv') continue;
  const q = qualifyId(s.id, '42');
  ok(sourceOfId(q) === s.id && rawIdOf(q) === '42', `${s.id} qualifier 往返`, q);
}

// 6) 文件名往返：全部来源走一遍 buildCacheFileName → parseCacheFileName。
// 挡的是「解析正则只照顾了 yande/konachan 的纯数字 id」这类漂移 ——
// konachan-net 的来源名带连字符、Wallhaven 的 id 是 6 位字母数字（216o5y），
// 旧正则对这两类返回 null，reconcileGallery 的 `if (!parsed) continue` 会静默跳过，
// 相册里的文件就永远回不了库（修复前线上就是这个行为）。
const ALNUM_ID_SOURCES = { wallhaven: '216o5y' }; // 其余来源的站点 id 都是纯数字
for (const s of SOURCE_LIST) {
  const raw = ALNUM_ID_SOURCES[s.id] || '1269655';
  const cases = [
    { pageIndex: 3, authorName: 'moonian', title: 'Title', isGif: false },
    { pageIndex: 0, authorName: '', title: '标题超长'.repeat(30), isGif: true }, // 空作者 + 触发字节截断
  ];
  for (const c of cases) {
    const entity = { illustId: qualifyId(s.id, raw), source: s.id, ...c };
    const name = buildCacheFileName(entity);
    const back = parseCacheFileName(name);
    ok(
      back?.illustId === entity.illustId && back?.pageIndex === c.pageIndex && back?.isGif === c.isGif,
      `${s.id} 文件名往返`,
      `${name} → ${JSON.stringify(back)}`,
    );
    // pixiv 走老分支（无 source 键，与历史数据一致）；其余来源必须带回来源
    ok(
      s.id === 'pixiv' ? back?.source === undefined : back?.source === s.id,
      `${s.id} 文件名往返带回来源`,
      `${name} → ${JSON.stringify(back)}`,
    );
  }
}

// 7) 代理路由表与注册表一致。BOORU_ROUTES 已从 net 派生，这里断言派生结果
// 覆盖全部非 pixiv 来源的 apiPrefix 与 imgHosts 前缀、target/UA 对齐 ——
// 防的是有人把手抄路由表改回来后两处悄悄漂移（历史教训：wallhaven 图床 UA 漂过）。
const routeByPrefix = new Map(BOORU_ROUTES.map(r => [r.prefix, r]));
ok(new Set(routeByPrefix.keys()).size === BOORU_ROUTES.length, 'BOORU_ROUTES 前缀唯一');
for (const s of SOURCE_LIST) {
  if (s.id === 'pixiv') continue;
  const api = routeByPrefix.get(s.net.apiPrefix);
  ok(!!api, `${s.id} API 路由存在`, s.net.apiPrefix);
  ok(api?.target === s.net.apiOrigin, `${s.id} API 路由 target 一致`);
  ok(api?.userAgent === s.net.userAgent, `${s.id} API 路由 UA 一致`);
  for (const [host, prefix] of Object.entries(s.net.imgHosts)) {
    const r = routeByPrefix.get(prefix);
    ok(!!r, `${s.id} 图床路由 ${prefix} 存在`);
    ok(r?.target === `https://${host}`, `${s.id} 图床路由 target 一致（${host}）`);
    ok(r?.userAgent === s.net.userAgent, `${s.id} 图床路由 UA 一致（${host}）`);
  }
}
// pixiv 路由表：4 条固定前缀齐全（thumb/zip 是基础设施路由，不在 net.imgHosts 里）
const pixivPrefixes = pixivRoutes().map(r => r.prefix).sort();
ok(
  JSON.stringify(pixivPrefixes) === JSON.stringify(['/pixiv-api', '/pixiv-img', '/pixiv-thumb', '/pixiv-zip']),
  'PIXIV_ROUTES 前缀齐全',
  pixivPrefixes.join(','),
);
ok(getSource('pixiv').net.apiPrefix === '/pixiv-api', 'pixiv apiPrefix 与路由表对齐');

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('OK — 身份层与来源注册表自检通过');
