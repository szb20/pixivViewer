/**
 * 二级菜单条 —— 独立悬浮在主底栏上方，圆形按钮，不与主底栏相连。
 */
export default function SubTabBar({ tabs, active, onChange, hidden }) {
  return (
    <div className={`sub-tab-bar${hidden ? ' sub-tab-bar--hidden' : ''}`}>
      {tabs.map(t => (
        <button
          key={t.key}
          className={`sub-tab-btn${t.key === active ? ' active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
