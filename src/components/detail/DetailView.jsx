import { useCallback, useEffect, useRef, useState } from 'react';
import ImageDetailView from './ImageDetailView.jsx';
import { registerBackHandler } from '../../utils/backHandler.js';
import { createLogger } from '../../utils/logger.js';
import { getDetailScrollEl } from '../../utils/scroll.js';
import BackIcon from '../icons/BackIcon.jsx';

const log = createLogger('DetailView');

const scrollKeyOf = (img) => (
  img?.illustId ? `${img.illustId}:${img._pageIndex ?? 0}` : ''
);

const captureScrollAnchor = () => {
  const root = getDetailScrollEl();
  if (!root) return { top: 0, anchor: null };
  const rootTop = root.getBoundingClientRect().top;
  const blocks = [...root.querySelectorAll('[data-detail-anchor]')];
  let best = null;
  for (const node of blocks) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= rootTop) continue;
    best = {
      id: node.dataset.detailAnchor,
      delta: rect.top - rootTop,
    };
    break;
  }
  return { top: root.scrollTop || 0, anchor: best };
};

/**
 * 详情页包装 — 管理"当前作品"切换栈：
 * 相关推荐点图 → 压栈切换；返回键 → 弹栈，栈空则关闭详情页。
 */
export default function DetailView({ image: initialImage, onClose, onExitToHome, onSearchTag, onAuthorWorks }) {
  const [image, setImage] = useState(initialImage);
  const [restoreState, setRestoreState] = useState({ top: 0, anchor: null });
  const stackRef = useRef([initialImage]);
  const handleBackRef = useRef(null);
  const scrollMapRef = useRef({}); // `${illustId}:${pageIndex}` → { top, anchor }
  const detailBgUrl = image?.thumbnailUrl || image?.previewUrl || image?.mediumUrl || image?.url || '';

  // 外部 prop 变化（从列表/推荐直接打开新作品）→ 重置栈
  useEffect(() => {
    if (initialImage?.illustId !== stackRef.current[stackRef.current.length - 1]?.illustId) {
      stackRef.current = [initialImage];
      setImage(initialImage);
      setRestoreState({ top: 0, anchor: null });
    }
  }, [initialImage]);

  const getCurrentScrollState = useCallback(() => captureScrollAnchor(), []);

  const handleSelect = (img) => {
    if (!img) return;
    const cur = stackRef.current[stackRef.current.length - 1];
    const s = getCurrentScrollState();
    const curKey = scrollKeyOf(cur);
    if (curKey) scrollMapRef.current[curKey] = s;
    log.info('push:', cur?.illustId, 'stack:', stackRef.current.length, '→', img.illustId);
    stackRef.current.push(img);
    setRestoreState({ top: 0, anchor: null });
    setImage(img);
  };

  const handleBack = () => {
    const cur = stackRef.current[stackRef.current.length - 1];
    const s = getCurrentScrollState();
    const curKey = scrollKeyOf(cur);
    if (curKey) scrollMapRef.current[curKey] = s;
    log.info('pop:', cur?.illustId, 'stack:', stackRef.current.length, 'scroll:', s.top);
    stackRef.current.pop();
    const prev = stackRef.current[stackRef.current.length - 1];
    if (prev) {
      setRestoreState(scrollMapRef.current[scrollKeyOf(prev)] || { top: 0, anchor: null });
      log.info('restore:', prev.illustId);
      setImage(prev);
    } else {
      log.info('close');
      onClose();
    }
  };
  handleBackRef.current = handleBack;

  // 系统返回手势/返回键：先弹详情内历史，栈空才关闭详情页
  useEffect(() => {
    return registerBackHandler(() => {
      handleBackRef.current();
      return true;
    });
  }, []);

  return (
    <div
      className="detail-overlay"
      style={detailBgUrl ? { '--detail-bg-image': `url(${JSON.stringify(detailBgUrl)})` } : undefined}
    >
      <div className="detail-glass-bg" aria-hidden="true" />
      <button className="glass-icon-btn detail-back-home" onClick={onExitToHome} aria-label="返回主页">
        <BackIcon />
      </button>
      <ImageDetailView
        image={image}
        onBack={handleBack}
        onSelectImage={handleSelect}
        onSearchTag={onSearchTag}
        onAuthorWorks={onAuthorWorks}
        restoreScroll={restoreState.top}
        restoreAnchor={restoreState.anchor}
      />
    </div>
  );
}
