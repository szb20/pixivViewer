import { useCallback, useEffect, useRef, useState } from 'react';
import { getSettings, saveSettings } from '../pixiv-assistant/index.js';
import { registerBackHandler } from '../utils/backHandler.js';
import { THEMES, getSavedTheme, applyTheme } from '../utils/theme.js';
import '../styles/settings.css';

const QUALITY_OPTIONS = [
  { value: 'thumb', label: 'thumb 250px' },
  { value: 'mini', label: 'mini 48px' },
];

const DETAIL_OPTIONS = [
  { value: 'original', label: 'original 原图' },
  { value: 'regular', label: 'regular 1200px' },
];

/**
 * 全屏设置页。
 * 覆盖在 tab 页之上，毛玻璃 sticky header + 卡片式分组 + 即时保存。
 */
export default function SettingsPage({ onClose }) {
  const loadedRef = useRef(false);
  const [cookie, setCookie] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [gridQuality, setGridQuality] = useState('thumb');
  const [detailQuality, setDetailQuality] = useState('original');

  // Cookie 收起/展开
  const [cookieOpen, setCookieOpen] = useState(false);

  // 即时保存状态
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);

  // 加载设置
  const [themeKey, setThemeKey] = useState(() => getSavedTheme());

  // 加载设置
  useEffect(() => {
    let cancelled = false;
    getSettings().then(s => {
      if (cancelled) return;
      setCookie(s.pixivCookie || '');
      setProxyUrl(s.proxyUrl || '');
      setGridQuality(s.gridQuality || 'thumb');
      setDetailQuality(s.detailQuality || 'original');
      loadedRef.current = true;
    });
    return () => { cancelled = true; };
  }, []);

  // 系统返回键
  useEffect(() => {
    return registerBackHandler(() => {
      onClose();
      return true;
    });
  }, [onClose]);

  // 即时保存核心
  const doSave = useCallback(async (patch) => {
    if (!loadedRef.current) return;
    setSaving(true);
    try {
      const s = await getSettings();
      await saveSettings({ ...s, ...patch });
      showToast();
    } catch { /* 静默忽略 */ }
    setSaving(false);
  }, []);

  const showToast = () => {
    setToast('已保存');
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 1500);
  };

  return (
    <div className="settings-overlay">
      {/* 毛玻璃 sticky 顶栏 */}
      <div className="settings-header">
        <button className="settings-header-back" onClick={onClose} aria-label="返回">‹</button>
        <span className="settings-header-title">设置</span>
      </div>

      {/* 可滚动内容 */}
      <div className="settings-content">
        {/* ── 外观 ── */}
        <div className="settings-group">
          <div className="settings-group-label">外观</div>
          <div className="settings-row" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div style={{ width: '100%' }}>
              <div className="settings-row-label">主题色</div>
              <div className="settings-row-hint">按钮、激活态、辉光等强调色</div>
            </div>
            <div className="settings-theme-swatches">
              {THEMES.map(t => (
                <button
                  key={t.key}
                  className={`settings-swatch${themeKey === t.key ? ' settings-swatch--active' : ''}`}
                  style={{ '--swatch-color': t.color }}
                  title={t.label}
                  onClick={() => {
                    setThemeKey(t.key);
                    applyTheme(t.key);
                    doSave({ theme: t.key });
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* ── 账号 ── */}
        <div className="settings-group">
          <div className="settings-group-label">账号</div>

          {/* Cookie — 点击展开 */}
          <div
            className={`settings-row settings-row-expand${cookieOpen ? '' : ''}`}
            onClick={() => setCookieOpen(!cookieOpen)}
            role="button"
            tabIndex={0}
          >
            <div>
              <div className="settings-row-label">Pixiv Cookie</div>
              {!cookieOpen && (
                <div className="settings-row-hint">
                  {cookie ? cookie.slice(0, 24) + '...' : '未设置'}
                </div>
              )}
            </div>
            <span className={`settings-row-chevron${cookieOpen ? ' settings-row-chevron--open' : ''}`}>▾</span>
          </div>
          {cookieOpen && (
            <div className="settings-expand-area">
              <textarea
                value={cookie}
                placeholder="PHPSESSID=..."
                onChange={e => setCookie(e.target.value)}
                onBlur={() => doSave({ pixivCookie: cookie.trim() })}
                autoFocus
              />
              <div className="settings-expand-hint">
                获取方式：浏览器登录 pixiv.net → F12 开发者工具 → Application → Cookies → 复制 PHPSESSID 的值
              </div>
            </div>
          )}
        </div>

        {/* ── 网络 ── */}
        <div className="settings-group">
          <div className="settings-group-label">网络</div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">代理地址</div>
              <div className="settings-row-hint">默认 http://127.0.0.1:7890</div>
            </div>
          </div>
          <div className="settings-input-row">
            <input
              className="settings-input"
              type="text"
              value={proxyUrl}
              placeholder="http://127.0.0.1:7890"
              onChange={e => {
                setProxyUrl(e.target.value);
                doSave({ proxyUrl: e.target.value.trim() });
              }}
            />
          </div>
        </div>

        {/* ── 画质 ── */}
        <div className="settings-group">
          <div className="settings-group-label">画质</div>

          <div className="settings-row">
            <div>
              <div className="settings-row-label">网格图片</div>
              <div className="settings-row-hint">列表和网格中使用的缩略图画质</div>
            </div>
            <div className="settings-pill-group">
              {QUALITY_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  className={`settings-pill${gridQuality === opt.value ? ' settings-pill--active' : ''}`}
                  onClick={() => {
                    setGridQuality(opt.value);
                    doSave({ gridQuality: opt.value });
                  }}
                >{opt.label}</button>
              ))}
            </div>
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row-label">详情大图</div>
              <div className="settings-row-hint">详情页加载的原图画质</div>
            </div>
            <div className="settings-pill-group">
              {DETAIL_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  className={`settings-pill${detailQuality === opt.value ? ' settings-pill--active' : ''}`}
                  onClick={() => {
                    setDetailQuality(opt.value);
                    doSave({ detailQuality: opt.value });
                  }}
                >{opt.label}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 即时保存提示 */}
      {toast && <div className="settings-toast">{toast}</div>}
    </div>
  );
}
