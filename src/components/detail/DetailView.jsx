import { useEffect, useRef, useState } from 'react';
import ImageDetailView from './ImageDetailView.jsx';
import { registerBackHandler } from '../../utils/backHandler.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('DetailView');

/**
 * 详情页包装 — 管理"当前作品"切换栈：
 * 相关推荐点图 → 压栈切换；返回键 → 弹栈，栈空则关闭详情页。
 */
export default function DetailView({ image: initialImage, onClose, onSearchTag, onAuthorWorks }) {
  const [image, setImage] = useState(initialImage);
  const [restoreScroll, setRestoreScroll] = useState(0);
  const stackRef = useRef([initialImage]);
  const handleBackRef = useRef(null);
  const scrollMapRef = useRef({}); // illustId → scrollTop

  // 外部 prop 变化（从列表/推荐直接打开新作品）→ 重置栈
  useEffect(() => {
    if (initialImage?.illustId !== stackRef.current[stackRef.current.length - 1]?.illustId) {
      stackRef.current = [initialImage];
      setImage(initialImage);
      setRestoreScroll(0);
    }
  }, [initialImage]);

  const getCurrentScroll = () => {
    const el = document.querySelector('.char-state-content');
    return el?.scrollTop || 0;
  };

  const handleSelect = (img) => {
    if (!img) return;
    const cur = stackRef.current[stackRef.current.length - 1];
    const s = getCurrentScroll();
    if (cur?.illustId) scrollMapRef.current[cur.illustId] = s;
    log.info('push:', cur?.illustId, 'stack:', stackRef.current.length, '→', img.illustId);
    stackRef.current.push(img);
    setRestoreScroll(0);
    setImage(img);
  };

  const handleBack = () => {
    const cur = stackRef.current[stackRef.current.length - 1];
    const s = getCurrentScroll();
    if (cur?.illustId) scrollMapRef.current[cur.illustId] = s;
    log.info('pop:', cur?.illustId, 'stack:', stackRef.current.length, 'scroll:', s);
    stackRef.current.pop();
    const prev = stackRef.current[stackRef.current.length - 1];
    if (prev) {
      setRestoreScroll(scrollMapRef.current[prev.illustId] || 0);
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
    <div className="detail-overlay">
      <ImageDetailView
        image={image}
        onBack={handleBack}
        onSelectImage={handleSelect}
        onSearchTag={onSearchTag}
        onAuthorWorks={onAuthorWorks}
        restoreScroll={restoreScroll}
      />
    </div>
  );
}
