/**
 * 设置页胶囊。Pill = 单个胶囊（单选组右对齐用）；
 * PillWall = 全宽换行铺开的多选胶囊墙（来源 / 页面 / 标记开关）。
 */
export function Pill({ active = false, ...props }) {
  return (
    <button
      type="button"
      className={`settings-pill${active ? ' settings-pill--active' : ''}`}
      aria-pressed={active}
      {...props}
    />
  );
}

/**
 * @param {Array<{key: string, label: string}>} items
 * @param {string[]} hidden — 被隐藏的 key 列表（不在墙里亮起的）
 * @param {(key: string, visible: boolean) => void} onToggle
 */
export function PillWall({ items, hidden = [], onToggle }) {
  return (
    <div className="settings-pill-group settings-pill-group--wrap">
      {items.map(it => {
        const visible = !hidden.includes(it.key);
        return (
          <Pill key={it.key} active={visible} onClick={() => onToggle(it.key, !visible)}>
            {it.label}
          </Pill>
        );
      })}
    </div>
  );
}
