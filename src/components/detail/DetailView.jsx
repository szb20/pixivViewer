import { useEffect, useRef, useState } from 'react';
import ImageDetailView from './ImageDetailView.jsx';
import { registerBackHandler } from '../../utils/backHandler.js';

/**
 * 详情页包装 — 管理"当前作品"切换栈：
 * 相关推荐点图 → 压栈切换；返回键 → 弹栈，栈空则关闭详情页。
 */
export default function DetailView({ image: initialImage, pixivCache, setPixivCache, onClose }) {
  const [image, setImage] = useState(initialImage);
  const stackRef = useRef([initialImage]);
  const handleBackRef = useRef(null);

  const handleSelect = (img) => {
    if (!img) return;
    stackRef.current.push(img);
    setImage(img);
  };

  const handleBack = () => {
    stackRef.current.pop();
    const prev = stackRef.current[stackRef.current.length - 1];
    if (prev) setImage(prev);
    else onClose();
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
    <ImageDetailView
      image={image}
      onBack={handleBack}
      onSelectImage={handleSelect}
      pixivCache={pixivCache}
      setPixivCache={setPixivCache}
    />
  );
}
