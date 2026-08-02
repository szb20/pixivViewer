/**
 * HeartIcon — SVG 爱心图标
 *
 * 风格：24×24 SVG，stroke-based，currentColor 继承
 * 支持 filled / outline 两种状态 + 点击动画
 *
 * Props:
 *   filled  — boolean，是否已喜欢（实心填充）
 *   className — 额外 class
 *   onClick   — 点击回调
 */
import React from 'react';

export default function HeartIcon({ filled = false, className = '', onClick }) {
  return (
    <svg
      className={`heart-icon ${filled ? 'heart-icon--filled' : 'heart-icon--outline'} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      onClick={onClick}
      role="img"
      aria-label={filled ? '已喜欢' : '未喜欢'}
    >
      <path
        d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  );
}