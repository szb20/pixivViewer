export default function TabBar({ tabs, active, onChange, hidden = false }) {
  return (
    <nav className={`tab-bar${hidden ? ' tab-bar--hidden' : ''}`} aria-label="主导航">
      {tabs.map(t => (
        <button
          key={t.key}
          className={`tab-btn${t.key === active ? ' active' : ''}`}
          onClick={() => onChange(t.key)}
          // 这些按钮是页面级导航而非 tab 面板，用 aria-current 表达「当前所在」
          aria-current={t.key === active ? 'page' : undefined}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}