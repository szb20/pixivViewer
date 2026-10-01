/**
 * 多来源接入的自检：身份层不依赖 DOM / IndexedDB，可直接跑。
 * 用法：node scripts/check-sources.mjs
 */
import { parseCacheFileName, getCompositeKey, qualifyId, sourceOfId, rawIdOf } from '../src/pixiv-assistant/core/utils.js';
import { SOURCE_LIST, getSource, capsOf } from '../src/sources/registry.js';

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
// 图床域名必须全局唯一：同一域名被两个来源认领会让 URL 重写张冠李戴
// （同一来源下多个域名共用一个代理前缀是允许的，如 pixiv 的 i.pixiv.re / pixiv.re）
const hosts = SOURCE_LIST.flatMap(s => Object.keys(s.net.imgHosts));
ok(new Set(hosts).size === hosts.length, 'imgHosts 域名互不冲突', hosts.join(','));
ok(getSource('nope').id === 'pixiv', '未知来源兜底 pixiv');
ok(capsOf('yande').multiPage === false && capsOf('pixiv').multiPage === true, 'caps 分流依据正确');

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('OK — 身份层与来源注册表自检通过');
