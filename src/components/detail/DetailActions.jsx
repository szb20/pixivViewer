import { useCallback, useState } from 'react';
import { LikeButton } from '../LightboxActions.jsx';
import { saveAllPages as saveAllPagesShared } from '../../api/saveAllPages.js';
import { createLogger } from '../../utils/logger.js';
import { showToast } from '../../utils/toast.js';

const log = createLogger('ImageDetail');

/** 操作条图标规格：与侧边栏/设置齿轮一致（24 视窗、currentColor 描边、线宽 2） */
const actionIconProps = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

/**
 * 桌面操作条 — 从 ImageDetailView 抽出（≥900px 显示，见 detail.css）。
 * 手机端仍用图片上的悬浮爱心 + 长按下载。
 *
 * 纯图标方块钮，没有文字标签，语义全靠 title / aria-label；title 顺带承担
 * 「下载 3 页」这类提示。下载中的忙态转圈由本组件自持。
 */
export default function DetailActions({
  image, pageCount, illustData, pixivCache, setPixivCache,
  saveAllPages, downloadPage, onOpenLightbox,
}) {
  const [actionBusy, setActionBusy] = useState(false);
  // 图标钮没有文字，这个文案走 title / aria-label（窄栏下也能看清下载范围）
  const downloadLabel = actionBusy ? '下载中…' : (pageCount > 1 ? `下载全部 ${pageCount} 页` : '下载');

  const handleDownloadAction = useCallback(async () => {
    if (!image?.illustId || actionBusy) return;
    setActionBusy(true);
    try {
      if (pageCount > 1) {
        showToast(`开始下载全部 ${pageCount} 页…`, { type: 'info' });
        await saveAllPagesShared(image, {
          pixivCache,
          setPixivCache,
          // 详情接口未返回时（冷启动）退回列表项自带的逐页地址（X 的 _pages）
          images: illustData?.illust?.images?.length ? illustData.illust.images : image?._pages,
          totalPages: pageCount,
        });
      } else {
        await downloadPage(0);
      }
    } finally {
      setActionBusy(false);
    }
  }, [image, actionBusy, pageCount, downloadPage, pixivCache, setPixivCache, illustData]);

  const handleCopyLink = useCallback(async () => {
    const url = image?.originalUrl || image?.mediumUrl || '';
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast('图片链接已复制', { type: 'success' });
    } catch (e) {
      log.warn('复制链接失败:', e?.message || e);
      showToast('复制失败');
    }
  }, [image]);

  return (
    <div className="detail-actions">
      <LikeButton
        cur={image}
        onLikeSaveAll={saveAllPages}
        totalPages={pageCount}
        className="detail-action detail-action--fill"
      />
      <button
        className="detail-action detail-action--fill"
        onClick={handleDownloadAction}
        disabled={actionBusy}
        title={downloadLabel}
        aria-label={downloadLabel}
      >
        {actionBusy ? <span className="detail-action-spinner" /> : (
          <svg {...actionIconProps}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        )}
      </button>
      <button className="detail-action" onClick={handleCopyLink} title="复制链接" aria-label="复制链接">
        <svg {...actionIconProps}>
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </button>
      <button
        className="detail-action"
        onClick={onOpenLightbox}
        title="查看原图"
        aria-label="查看原图"
      >
        <svg {...actionIconProps}>
          <path d="M15 3h6v6" />
          <path d="M9 21H3v-6" />
          <path d="M21 3l-7 7" />
          <path d="M3 21l7-7" />
        </svg>
      </button>
    </div>
  );
}
