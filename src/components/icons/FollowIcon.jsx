/**
 * FollowIcon — 关注按钮符号（SVG）
 *
 * 未关注显示「+」，已关注显示「✓」，currentColor 继承按钮颜色。
 *
 * Props:
 *   followed  — boolean，是否已关注（切换 + / ✓）
 *   className — 额外 class
 */
export default function FollowIcon({ followed = false, className = '' }) {
  return (
    <svg
      className={`follow-icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={followed ? '已关注' : '关注'}
      style={{ display: 'block' }}
    >
      {followed
        ? <path d="M20 6L9 17l-5-5" />
        : <path d="M12 5v14M5 12h14" />}
    </svg>
  );
}
