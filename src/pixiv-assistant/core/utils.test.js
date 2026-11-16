/**
 * core/utils 纯函数测试 — URL 推导 / 复合键 / 来源限定 / 文件名往返。
 * 这些是缓存、下载、点赞键的地基：错一位不报错但全错位，必须锁死。
 */
import { describe, expect, it } from 'vitest';
import {
  pixivReUrl, pixivPageUrl, getCompositeKey,
  qualifyId, sourceOfId, rawIdOf, entityKeyOf,
  truncateUtf8Bytes, safeFileName, buildCacheFileName, parseCacheFileName,
} from './utils.js';

describe('qualifyId / sourceOfId / rawIdOf（来源限定的 id 体系）', () => {
  it('pixiv 保持裸数字（历史数据零迁移）', () => {
    expect(qualifyId('pixiv', 12345)).toBe('12345');
  });
  it('非 pixiv 加来源前缀', () => {
    expect(qualifyId('yande', 1269655)).toBe('yande_1269655');
  });
  it('来源名含连字符也可往返', () => {
    const id = qualifyId('konachan-net', 123);
    expect(id).toBe('konachan-net_123');
    expect(sourceOfId(id)).toBe('konachan-net');
    expect(rawIdOf(id)).toBe('123');
  });
  it('未知前缀 fail-safe 归 pixiv', () => {
    expect(sourceOfId('whatever_123')).toBe('pixiv');
  });
  it('无下划线的 id 归 pixiv，rawIdOf 原样返回', () => {
    expect(sourceOfId('998877')).toBe('pixiv');
    expect(rawIdOf('998877')).toBe('998877');
  });
});

describe('getCompositeKey / entityKeyOf', () => {
  it('复合键 = illustId_pageIndex，_pageIndex 优先于 page', () => {
    expect(getCompositeKey({ illustId: '123', _pageIndex: 2 })).toBe('123_2');
    expect(getCompositeKey({ illustId: '123', page: 1 })).toBe('123_1');
    expect(getCompositeKey({ illustId: 'yande_9', _pageIndex: 0 })).toBe('yande_9_0');
  });
  it('实体键 = source:illustId:pageIndex', () => {
    expect(entityKeyOf('yande_9', 3)).toBe('yande:yande_9:3');
    expect(entityKeyOf('123')).toBe('pixiv:123:0');
  });
});

describe('pixivReUrl / pixivPageUrl（URL 推导）', () => {
  it('pixivReUrl 页码后缀 1-indexed：p0 无后缀，p1 是 -2', () => {
    expect(pixivReUrl('123')).toBe('https://pixiv.re/123.jpg');
    expect(pixivReUrl('123', 1)).toBe('https://pixiv.re/123-2.jpg');
  });
  it('pixivReUrl thumb 档走 250px 裁剪路径', () => {
    expect(pixivReUrl('123', 0, 'thumb')).toBe('https://pixiv.re/c/250x250_80_a2/123_p0.jpg');
  });
  it('pixivPageUrl 从 page0 master URL 推目标页等比图', () => {
    const base = 'https://i.pximg.net/img-master/img/2024/01/02/03/04/05/123456_p0_square1200.jpg';
    expect(pixivPageUrl(base, 2)).toBe('https://i.pixiv.re/img-master/img/2024/01/02/03/04/05/123456_p2_master1200.jpg');
  });
  it('pixivPageUrl 容忍 2026 起的 32 位内容哈希段', () => {
    const base = 'https://i.pximg.net/img-master/img/2026/01/01/00/00/00/99-abcd0123abcd0123abcd0123abcd0123_p0_square1200.jpg';
    expect(pixivPageUrl(base, 1, 360)).toBe('https://i.pixiv.re/img-master/img/2026/01/01/00/00/00/99_p1_master360.jpg');
  });
  it('pixivPageUrl ugoira（无页码后缀）不加 _p{n}', () => {
    const base = 'https://i.pximg.net/img-master/img/2024/01/02/03/04/05/777_square1200.jpg';
    expect(pixivPageUrl(base, 0)).toBe('https://i.pixiv.re/img-master/img/2024/01/02/03/04/05/777_master1200.jpg');
  });
});

describe('buildCacheFileName ↔ parseCacheFileName（文件名格式契约）', () => {
  const cases = [
    { source: 'pixiv', illustId: '12345', authorName: '作者', title: 'タイトル', pageIndex: 0 },
    { source: 'yande', illustId: 'yande_1269655', authorName: 'author', title: 'title', pageIndex: 2 },
    { source: 'konachan-net', illustId: 'konachan-net_456', authorName: '', title: 'x', pageIndex: 1 },
    { source: 'wallhaven', illustId: 'wallhaven_216o5y', authorName: 'a', title: 'b', pageIndex: 0 },
    { source: 'pixiv', illustId: '888', authorName: '', title: '', pageIndex: 0, isGif: true },
  ];
  it.each(cases)('往返一致：$source $illustId p$pageIndex', (entity) => {
    const name = buildCacheFileName(entity);
    const parsed = parseCacheFileName(name);
    expect(parsed).not.toBeNull();
    expect(parsed.illustId).toBe(entity.illustId);
    expect(parsed.pageIndex).toBe(entity.pageIndex);
    expect(parsed.isGif).toBe(!!entity.isGif);
    if (entity.source !== 'pixiv') expect(parsed.source).toBe(entity.source);
  });
  it('历史双前缀文件名（zerochan_zerochan_…）也能解析', () => {
    const parsed = parseCacheFileName('zerochan_zerochan_12345_p0_[a]_[b].jpg');
    expect(parsed.illustId).toBe('zerochan_12345');
  });
});

describe('truncateUtf8Bytes / safeFileName', () => {
  it('按字节截断，不切碎多字节字符', () => {
    expect(truncateUtf8Bytes('ab', 10)).toBe('ab');
    expect(truncateUtf8Bytes('日本語', 9)).toBe('日本語'); // 3 字 × 3 字节
    expect(truncateUtf8Bytes('日本語', 8)).toBe('日本'); // 最后一字 3 字节放不下
  });
  it('safeFileName 清掉路径非法字符', () => {
    expect(safeFileName('a/b:c*d?"<>|e\r\n')).toBe('a-bcde');
  });
});
