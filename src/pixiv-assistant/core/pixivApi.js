/**
 * Pixiv API 共享工厂 — 所有 API 函数只写一次，平台只提供 HTTP 传输层。
 *
 * Transport 接口：
 *   fetch(pathname, opts?) → Promise<parsedJSON|string>  发 GET/POST，opts 支持 method/body/raw（raw 返回文本），失败 throw
 *   getCookie() → string | Promise<string>        当前 PHPSESSID 值（空串表示无）
 *
 * 用法：
 *   const api = createPixivApi(transport);
 *   const { images } = await api.searchPixiv('keyword');
 *
 * 内部按端点分组（pixiv/ 目录）：
 *   client   — HTTP 传输、Cookie 注入、CSRF token、错误分类
 *   mappers  — 原始响应 → 应用内部数据结构（纯函数）
 *   illust   — 作品详情（LRU 缓存）/ 随机 / 相似推荐
 *   search   — 标签与作品 ID 搜索 / 用户搜索
 *   ranking  — 排行榜
 *   feed     — 每日推荐 / 收藏夹 / 关注最新作品
 *   user     — 作者作品列表 / 全部作品 ID / 作者资料
 *   social   — 关注 / 取关 / 关注的作者列表
 */

import { createLogger } from '../../utils/logger.js';
import { createApiClient } from './pixiv/client.js';
import { createIllustApi } from './pixiv/illust.js';
import { createSearchApi } from './pixiv/search.js';
import { createRankingApi } from './pixiv/ranking.js';
import { createFeedApi } from './pixiv/feed.js';
import { createUserApi } from './pixiv/user.js';
import { createSocialApi } from './pixiv/social.js';

const log = createLogger('pixivApi');

export function createPixivApi(transport) {
  const client = createApiClient(transport);
  const ctx = { ...client, transport, log };

  const illust = createIllustApi(ctx);
  // 搜索按 ID 直查时复用作品详情（含缓存），避免重复请求
  const search = createSearchApi({ ...ctx, fetchIllust: illust.fetchIllust });
  const ranking = createRankingApi(ctx);
  const feed = createFeedApi(ctx);
  const user = createUserApi(ctx);
  const social = createSocialApi(ctx);

  return {
    ...search,
    ...illust,
    ...feed,
    ...user,
    ...ranking,
    ...social,
  };
}