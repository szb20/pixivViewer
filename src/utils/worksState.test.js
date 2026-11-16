/**
 * worksState 测试 — 复合键 → illustId 集合派生（跨来源两种 id 形状都要还原）。
 */
import { describe, expect, it } from 'vitest';
import { buildLikedIllustIdSet, buildLikedOrSavedSet } from './worksState.js';

describe('buildLikedIllustIdSet', () => {
  it('pixiv 裸数字 id：剥掉末尾页码', () => {
    const s = buildLikedIllustIdSet(new Set(['123_0', '456_2']));
    expect([...s].sort()).toEqual(['123', '456']);
  });
  it('非 pixiv 的 id 自身含下划线，页码仍能正确剥掉', () => {
    const s = buildLikedIllustIdSet(new Set(['yande_1269655_0', 'konachan-net_7_1']));
    expect([...s].sort()).toEqual(['konachan-net_7', 'yande_1269655']);
  });
  it('尾段不是纯数字的 id 原样保留（如 wallhaven 的字母 id）', () => {
    const s = buildLikedIllustIdSet(new Set(['wallhaven_216o5y']));
    expect([...s]).toEqual(['wallhaven_216o5y']);
  });
  it('_ 后不是纯数字时整个 key 视为 illustId', () => {
    const s = buildLikedIllustIdSet(new Set(['twitter_abc_x']));
    expect([...s]).toEqual(['twitter_abc_x']);
  });
});

describe('buildLikedOrSavedSet', () => {
  it('liked 或 saved 任一命中即收录，忽略其余', () => {
    const cache = {
      '1_0': { liked: true },
      '2_0': { saved: true },
      '3_0': { liked: false, saved: false },
      '4_0': null,
    };
    expect([...buildLikedOrSavedSet(cache)].sort()).toEqual(['1', '2']);
  });
});
