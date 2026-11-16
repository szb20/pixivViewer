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
 * 详情页操作条 — 两种形态共享同一套动作逻辑（见 detail.css）：
 * - panel（默认）：≥900px 信息栏里的一排方形图标钮，主操作（喜欢/下载）与
 *   次操作（复制/放大）之间有细分隔线
 * - floating：手机端右下角悬浮玻璃钮组（喜欢/下载/复制链接）。此前手机端
 *   只有单颗爱心，复制链接完全没有入口；点大图即是灯箱，不需要放大钮
 *
 * 纯图标钮没有文字标签，语义全靠 title / aria-label；title 顺带承担
 * 「下载 3 页」这类提示。下载中的忙态转圈由本组件自持。
 */
export default function DetailActions({
  image, pageCount, illustData, pixivCache, setPixivCache,
  saveAllPages, downloadPage, onOpenLightbox, variant = 'panel',
}) {
  const [actionBusy, setActionBusy] = useState(false);
  const floating = variant === 'floating';
  // 悬浮组是玻璃圆钮，操作条是方形钮：同一套动作只换皮肤
  const btnClass = floating ? 'glass-icon-btn' : 'detail-action detail-action--fill';
  const minorClass = floating ? 'glass-icon-btn' : 'detail-action';
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
    <div className={floating ? 'detail-actions--floating' : 'detail-actions'}>
      <LikeButton
        cur={image}
        onLikeSaveAll={saveAllPages}
        totalPages={pageCount}
        className={btnClass}
        // 操作条里长按是隐藏手势，多图时喜欢和下载是两个独立按钮，title 不再绕着长按解释
        title={pageCount > 1 ? '喜欢' : '喜欢并保存'}
      />
      <button
        className={btnClass}
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
      <button className={minorClass} onClick={handleCopyLink} title="复制链接" aria-label="复制链接">
        <svg {...actionIconProps}>
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </button>
      {/* 次操作用细线隔开，和主操作（喜欢/下载）拉开层次；悬浮组只有三颗钮不分组 */}
      {!floating && (
        <>
          <span className="detail-actions-divider" aria-hidden="true" />
          <button
            className={minorClass}
            onClick={onOpenLightbox}
            title="放大查看"
            aria-label="放大查看"
          >
            <svg {...actionIconProps}>
              <path d="M15 3h6v6" />
              <path d="M9 21H3v-6" />
              <path d="M21 3l-7 7" />
              <path d="M3 21l7-7" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
