export default function TabBar({ tabs, active, onChange, hidden = false }) {
  return (
    <nav className={`tab-bar frosted${hidden ? ' tab-bar--hidden' : ''}`}>
      {tabs.map(t => (
        <button
          key={t.key}
          className={`tab-btn${t.key === active ? ' active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
