export default function TabBar({ tabs, active, onChange }) {
  return (
    <nav className="tab-bar">
      {tabs.map(t => (
        <button
          key={t.key}
          className={`tab-btn${t.key === active ? ' active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          <span className="tab-icon">{t.icon}</span>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
