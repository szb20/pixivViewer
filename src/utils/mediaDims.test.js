/**
 * mediaDims 测试 — 尺寸学习缓存 + 详情页比例解析链（比例真相源的唯一优先级）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('mediaDims', () => {
  let mediaDims;

  // 模块在 import 时就读 appStorage（迁移 + 恢复），必须先清空存储再动态 import
  beforeEach(async () => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.resetModules();
    mediaDims = await import('./mediaDims.js');
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('ratioOfSize：有宽高成串，缺一边空串', () => {
    expect(mediaDims.ratioOfSize(1200, 900)).toBe('1200 / 900');
    expect(mediaDims.ratioOfSize(0, 900)).toBe('');
    expect(mediaDims.ratioOfSize(1200, 0)).toBe('');
  });

  it('isSquareCropThumb：只认 pixiv 方形裁剪三档，真方图（680）不误伤', () => {
    expect(mediaDims.isSquareCropThumb(250, 250)).toBe(true);
    expect(mediaDims.isSquareCropThumb(540, 540)).toBe(true);
    expect(mediaDims.isSquareCropThumb(1200, 1200)).toBe(true);
    expect(mediaDims.isSquareCropThumb(680, 680)).toBe(false);
    expect(mediaDims.isSquareCropThumb(680, 383)).toBe(false);
  });

  it('remember → get 往返；非法值拒绝', () => {
    mediaDims.rememberMediaDims('twitter:1', 0, 680, 383);
    expect(mediaDims.getMediaDims('twitter:1', 0)).toEqual({ w: 680, h: 383 });
    expect(mediaDims.getMediaDims('twitter:1', 1)).toBeNull();
    mediaDims.rememberMediaDims('x', 0, 0, 100); // 零宽拒绝
    mediaDims.rememberMediaDims('x', 0, -1, 100); // 负值拒绝
    expect(mediaDims.getMediaDims('x', 0)).toBeNull();
  });

  it('同比例不同档位不重复入库（等比缩放宽高不同、比例一致）', () => {
    mediaDims.rememberMediaDims('a', 0, 680, 383);
    const v1 = mediaDims.getMediaDims('a', 0);
    mediaDims.rememberMediaDims('a', 0, 1360, 766); // 同比例更清晰
    expect(mediaDims.getMediaDims('a', 0)).toBe(v1); // 引用没换
  });

  it('持久化经 appStorage 落盘，重新 import 可恢复', async () => {
    mediaDims.rememberMediaDims('b', 2, 800, 600);
    vi.advanceTimersByTime(1000); // 触发 800ms 防抖落盘
    const { appStorage } = await import('./appStorage.js');
    const raw = appStorage.get('mediaDims');
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toContainEqual(['b:2', { w: 800, h: 600 }]);

    vi.resetModules();
    const reloaded = await import('./mediaDims.js');
    expect(reloaded.getMediaDims('b', 2)).toEqual({ w: 800, h: 600 });
  });

  it('resolveRatio 优先级：实测 > 接口 > 列表 > 学到 > 兜底', () => {
    mediaDims.rememberMediaDims('c', 0, 500, 400);
    // 每层单独可用
    expect(mediaDims.resolveRatio({ measured: '1 / 1' })).toBe('1 / 1');
    expect(mediaDims.resolveRatio({ api: '4 / 3' })).toBe('4 / 3');
    expect(mediaDims.resolveRatio({ list: '3 / 4' })).toBe('3 / 4');
    expect(mediaDims.resolveRatio({ illustId: 'c', page: 0 })).toBe('500 / 400'); // 学到的
    expect(mediaDims.resolveRatio({})).toBe(''); // 全空
    expect(mediaDims.resolveRatio({ fallback: '3 / 4' })).toBe('3 / 4');
    // 高层存在时低层被遮蔽
    expect(mediaDims.resolveRatio({ measured: '1 / 1', api: '4 / 3', list: '3 / 4', illustId: 'c', page: 0, fallback: '3 / 4' })).toBe('1 / 1');
    expect(mediaDims.resolveRatio({ api: '4 / 3', list: '3 / 4', illustId: 'c', page: 0 })).toBe('4 / 3');
    expect(mediaDims.resolveRatio({ list: '3 / 4', illustId: 'c', page: 0 })).toBe('3 / 4');
  });
});
