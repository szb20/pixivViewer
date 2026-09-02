/**
 * Pixiv API 数据映射 — 把各接口返回的原始结构统一成应用内部格式。
 * 纯函数，无平台依赖、无网络请求，便于单测。
 */

import { pixivReUrl, pixivPageUrl, pixivOriginalUrl, proxyThumb } from '../utils.js';

/** 统一映射插画条目（API 返回 → 输出格式），兼容 camelCase 和 snake_case */
export function mapIllustItem(item) {
    const illustId = String(item.illustId || item.id || item.illust_id || '');
    const illustType = parseInt(item.illustType || item.illust_type) || 0;
    return {
        illustId,
        title: item.title || item.illustTitle || '',
        author: item.userName || item.user_name || item.userAccount || item.user_account || '',
        authorName: item.userName || item.user_name || '',
        authorAccount: item.userAccount || item.user_account || '',
        authorId: String(item.userId || item.user_id || ''),
        // 列表接口自带的作者头像（避免每张详情页都请求 /ajax/user/{id} 触发反爬）
        authorAvatar: proxyThumb(item.profileImageUrl || item.userProfileImageUrl || ''),
        thumbnailUrl: proxyThumb(item.url || item.thumbnailUrl || item.profileImageUrl || ''),
        mediumUrl: pixivReUrl(illustId),
        originalUrl: item.originalUrl || pixivReUrl(illustId),
        tags: (item.tags || []).map(t => typeof t === 'string' ? t : (t.tag || t)),
        pixivUrl: `https://www.pixiv.net/artworks/${illustId}`,
        pageCount: parseInt(item.pageCount || item.illust_page_count) || 1,
        type: illustType === 2 ? 'gif' : 'image',
        illustType,
        width: item.width || 0,
        height: item.height || 0,
    };
}

/** 映射排行榜条目（在 mapIllustItem 基础上追加排行/热度字段） */
export function mapRankingItem(item) {
    return {
        ...mapIllustItem(item),
        rank: item.rank,
        viewCount: item.viewCount || item.view_count || 0,
        ratingCount: item.ratingCount || item.rating_count || 0,
    };
}

/** 映射图片页面（从 API 详情响应提取），带 original 原图档 */
export function mapImagePages(basePage0Url, basePage0ThumbUrl, pageCount, baseOriginalUrl = '', basePreviewUrl = '') {
    const images = [];
    for (let p = 0; p < pageCount; p++) {
        images.push({
            index: p,
            url: pixivPageUrl(basePage0Url, p),
            // 详情页滚动视图用的等比预览图：直接用 API 的 small 档（c/540x540_70 → 540px 长边等比，约 45KB）
            previewUrl: basePreviewUrl
                ? proxyThumb(basePreviewUrl.replace(/_p0_/, `_p${p}_`))
                : '',
            thumbnailUrl: p === 0 ? proxyThumb(basePage0ThumbUrl) : pixivPageUrl(basePage0Url, p),
            mediumUrl: pixivPageUrl(basePage0Url, p),
            originalUrl: baseOriginalUrl ? pixivOriginalUrl(baseOriginalUrl, p) : pixivPageUrl(basePage0Url, p),
            width: 0,
            height: 0,
        });
    }
    return images;
}

/** 映射 /ajax/illust/{id}/pages 返回的逐页数据（含每页真实宽高） */
export function mapAjaxPages(pages) {
    if (!Array.isArray(pages) || pages.length === 0) return [];
    return pages.map((page, index) => {
        const urls = page?.urls || {};
        const regular = urls.regular || urls.small || urls.thumb_mini || urls.original || '';
        const preview = urls.small || urls.regular || regular;
        const thumb = urls.thumb_mini || urls.small || regular;
        const original = urls.original || urls.regular || regular;
        return {
            index,
            url: proxyThumb(regular),
            previewUrl: proxyThumb(preview),
            thumbnailUrl: proxyThumb(thumb),
            mediumUrl: proxyThumb(regular),
            originalUrl: proxyThumb(original),
            width: page?.width || 0,
            height: page?.height || 0,
        };
    });
}