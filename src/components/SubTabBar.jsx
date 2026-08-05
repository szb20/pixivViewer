/**
 * 子标签栏 — 复用主底边栏（TabBar）样式（tab-bar frosted + tab-btn），
 * 位置浮在主 TabBar 上方（bottom:48px）；hidden 时带 chips-hidden 的下滑淡出。
 */
export default function SubTabBar({ tabs, active, onChange, hidden }) {
  return (
    <div className={`tab-bar frosted sub-tab-bar${hidden ? ' chips-hidden' : ''}`}>
      {tabs.map(t => (
        <button
          key={t.key}
          className={`tab-btn${t.key === active ? ' active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
