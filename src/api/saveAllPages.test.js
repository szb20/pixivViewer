/**
 * saveAllPages 测试 — 「保存全部页」的编排规则：补拉详情、幂等跳过、
 * 分批并发、汇总计数、批量缓存合并。saveItem / pixivApi 全部 mock，
 * 只验证编排层与 pixiv-assistant 真实纯函数的配合。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./pixiv.js', () => ({ pixivApi: { fetchIllust: vi.fn() } }));
vi.mock('./index.js', () => ({ saveItem: vi.fn() }));

// 在 vi.mock 工厂之外拿到 mock 引用
const { pixivApi } = await import('./pixiv.js');
const { saveItem } = await import('./index.js');
const { saveAllPages } = await import('./saveAllPages.js');

const ok = (extra = {}) => ({ success: true, ...extra });

beforeEach(() => {
  vi.mocked(pixivApi.fetchIllust).mockReset();
  vi.mocked(saveItem).mockReset();
});

describe('pixiv 多页', () => {
  const pixivItem = { illustId: '12345', title: 't', pageCount: 3, mediumUrl: 'https://pixiv.re/12345.jpg' };
  const detail = {
    illust: {
      pageCount: 3,
      images: [
        { originalUrl: 'https://i.pximg.re/img-original/a.jpg', url: 'https://i.pximg.re/m1.jpg' },
        { originalUrl: 'https://i.pximg.re/img-original/b.jpg', url: 'https://i.pximg.re/m2.jpg' },
        { originalUrl: 'https://i.pximg.re/img-original/c.jpg', url: 'https://i.pximg.re/m3.jpg' },
      ],
    },
  };

  it('详情未给时自动补拉一次，逐页保存，结果汇总', async () => {
    pixivApi.fetchIllust.mockResolvedValue(detail);
    saveItem.mockResolvedValue(ok());

    const r = await saveAllPages(pixivItem, {});

    expect(pixivApi.fetchIllust).toHaveBeenCalledTimes(1);
    expect(saveItem).toHaveBeenCalledTimes(3);
    expect(r).toEqual({ saved: 3, exists: 0 });
    // 3 页在一个批次（SAVE_BATCH_SIZE=3）里：setPixivCache 只合并一次
    expect(saveItem.mock.calls.map(([it]) => it._pageIndex)).toEqual([0, 1, 2]);
  });

  it('已保存的页跳过（幂等），计入 exists', async () => {
    pixivApi.fetchIllust.mockResolvedValue(detail);
    saveItem.mockResolvedValue(ok());

    const cache = { '12345_1': { saved: true } };
    const setPixivCache = vi.fn();
    const r = await saveAllPages(pixivItem, { pixivCache: cache, setPixivCache });

    expect(saveItem).toHaveBeenCalledTimes(2); // 第 1、3 页
    expect(r.exists).toBe(1);
    expect(r.saved).toBe(2);
    expect(setPixivCache).toHaveBeenCalledTimes(1);
    const updater = setPixivCache.mock.calls[0][0];
    const next = updater(cache);
    expect(Object.keys(next).sort()).toEqual(['12345_0', '12345_1', '12345_2']);
    expect(next['12345_0'].saved).toBe(true);
  });

  it('saveItem 幂等返回（idempotent）计入 exists 而非 saved', async () => {
    pixivApi.fetchIllust.mockResolvedValue(detail);
    saveItem.mockResolvedValue({ success: true, idempotent: true });

    const r = await saveAllPages(pixivItem, {});
    expect(r).toEqual({ saved: 0, exists: 3 });
  });

  it('单页失败不拖垮整批，失败页不写缓存', async () => {
    pixivApi.fetchIllust.mockResolvedValue(detail);
    saveItem.mockImplementation(async (it) => (it._pageIndex === 1 ? { success: false } : ok()));

    const setPixivCache = vi.fn();
    const r = await saveAllPages(pixivItem, { setPixivCache });
    expect(r).toEqual({ saved: 2, exists: 0 });
    const updater = setPixivCache.mock.calls[0][0];
    const next = updater({});
    expect(next['12345_1']).toBeUndefined();
    expect(next['12345_0'].saved).toBe(true);
  });

  it('条目无 illustId 直接零结果，不触网不落盘', async () => {
    const r = await saveAllPages(null, {});
    expect(r).toEqual({ saved: 0, exists: 0 });
    expect(pixivApi.fetchIllust).not.toHaveBeenCalled();
    expect(saveItem).not.toHaveBeenCalled();
  });
});

describe('X 多图推文（无详情接口，靠 _pages）', () => {
  it('不调 fetchIllust，逐页用 _pages 里的原图地址', async () => {
    saveItem.mockResolvedValue(ok());
    const item = {
      illustId: 'twitter_1735000000000000000',
      source: 'twitter',
      _totalPages: 2,
      _pages: [
        { originalUrl: 'https://pbs.twimg.com/media/Abc?name=orig', url: 'https://pbs.twimg.com/media/Abc?name=small' },
        { originalUrl: 'https://pbs.twimg.com/media/Xyz?name=orig', url: 'https://pbs.twimg.com/media/Xyz?name=small' },
      ],
    };
    const r = await saveAllPages(item, {});
    expect(pixivApi.fetchIllust).not.toHaveBeenCalled();
    expect(saveItem).toHaveBeenCalledTimes(2);
    expect(saveItem.mock.calls[0][0].originalUrl).toContain('pbs.twimg.com/media/Abc');
    expect(saveItem.mock.calls[1][0]._pageIndex).toBe(1);
    expect(r).toEqual({ saved: 2, exists: 0 });
  });
});

describe('booru 单页', () => {
  it('一条 post 一张图：只保存 1 次，绝不补拉 pixiv 详情（防同号顶包）', async () => {
    saveItem.mockResolvedValue(ok());
    const item = {
      illustId: 'yande_1269655',
      source: 'yande',
      originalUrl: 'https://files.yande.re/jpeg/xxx/yande.1269655.jpg',
      mediumUrl: 'https://files.yande.re/sample/xxx.jpg',
    };
    const r = await saveAllPages(item, {});
    expect(pixivApi.fetchIllust).not.toHaveBeenCalled();
    expect(saveItem).toHaveBeenCalledTimes(1);
    expect(saveItem.mock.calls[0][0].originalUrl).toContain('files.yande.re');
    expect(r).toEqual({ saved: 1, exists: 0 });
  });
});

describe('动图', () => {
  it('isGif 条目整条 type=gif 且只按 1 页走保存', async () => {
    saveItem.mockResolvedValue(ok());
    const item = { illustId: '777', illustType: 2, pageCount: 1 };
    const r = await saveAllPages(item, {});
    expect(saveItem).toHaveBeenCalledTimes(1);
    expect(saveItem.mock.calls[0][0].type).toBe('gif');
    expect(r).toEqual({ saved: 1, exists: 0 });
  });
});
