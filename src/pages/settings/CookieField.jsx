import { useState } from 'react';

/**
 * Cookie 折叠行 — 全部图源的 Cookie 统一形态（设置页控件形态统一规则）。
 * 收起：label + 「未设置 / 前 24 字符」+ chevron；展开：textarea + 一行获取提示。
 */
export default function CookieField({ label, value, onChange, onBlur, placeholder, hint }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        className="settings-row settings-row-expand"
        onClick={() => setOpen(!open)}
        role="button"
        tabIndex={0}
      >
        <div>
          <div className="settings-row-label">{label}</div>
          {!open && (
            <div className="settings-row-hint">
              {value ? value.slice(0, 24) + '…' : '未设置'}
            </div>
          )}
        </div>
        <span className={`settings-row-chevron${open ? ' settings-row-chevron--open' : ''}`}>▾</span>
      </div>
      {open && (
        <div className="settings-expand-area">
          <textarea
            value={value}
            placeholder={placeholder}
            onChange={e => onChange(e.target.value)}
            onBlur={onBlur}
            autoFocus
          />
          {hint && <div className="settings-expand-hint">{hint}</div>}
        </div>
      )}
    </>
  );
}
