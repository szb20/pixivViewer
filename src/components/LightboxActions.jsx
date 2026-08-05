/**
 * LikeButton — 喜欢按钮（灯箱左下角/详情页悬浮）。
 *
 * 交互（逻辑见 hooks/useLikeAction）：
 * - 点按：切换喜欢；单图/GIF 会顺带保存（喜欢=下载）；多图只切喜欢不下载
 * - 长按：切换喜欢 + 下载全部页
 */

import { useLikeAction } from '../hooks/useLikeAction.js';
import HeartIcon from './icons/HeartIcon.jsx';

export function LikeButton({ cur, onLikeSaveAll, totalPages }) {
  const { liked, multiPage, handleLike, startLongPress, cancelLongPress } = useLikeAction(cur, { onLikeSaveAll, totalPages });

  if (!cur?.illustId) return null;

  return (
    <button
      className="glass-icon-btn"
      onClick={handleLike}
      onPointerDown={startLongPress}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
      title={multiPage ? '点按喜欢；长按喜欢+下载全部页' : '喜欢并保存'}
    >
      <HeartIcon filled className={liked ? 'heart-icon--liked' : 'heart-icon--neutral'} />
    </button>
  );
}
