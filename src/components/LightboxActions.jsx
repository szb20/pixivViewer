/**
 * LikeButton — 喜欢按钮（灯箱左下角 / 详情页悬浮 / 详情页操作条）。
 *
 * 交互（逻辑见 hooks/useLikeAction）：
 * - 点按：切换喜欢；单图/GIF 会顺带保存（喜欢=下载）；多图只切喜欢不下载
 * - 长按：切换喜欢 + 下载全部页
 *
 * @param {string} [className] 外层样式，默认玻璃圆钮；详情页操作条传 'detail-action'
 */

import { useLikeAction } from '../hooks/useLikeAction.js';
import HeartIcon from './icons/HeartIcon.jsx';

export function LikeButton({ cur, onLikeSaveAll, totalPages, className = 'glass-icon-btn' }) {
  const { liked, multiPage, handleLike, startLongPress, cancelLongPress } = useLikeAction(cur, { onLikeSaveAll, totalPages });

  if (!cur?.illustId) return null;

  return (
    <button
      className={className}
      onClick={handleLike}
      onPointerDown={startLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      title={multiPage ? '点按喜欢；长按喜欢+下载全部页' : '喜欢并保存'}
      aria-pressed={liked}
      aria-label={liked ? '取消喜欢' : '喜欢'}
    >
      <HeartIcon filled className={liked ? 'heart-icon--liked' : 'heart-icon--neutral'} />
    </button>
  );
}
