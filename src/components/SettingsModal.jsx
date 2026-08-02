import { useEffect, useState } from 'react';
import { getSettings, saveSettings } from '../pixiv-assistant/index.js';

export default function SettingsModal({ onClose }) {
  const [cookie, setCookie] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    getSettings().then(s => {
      setCookie(s.pixivCookie || '');
      setProxyUrl(s.proxyUrl || '');
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const s = await getSettings();
    await saveSettings({ ...s, pixivCookie: cookie.trim(), proxyUrl: proxyUrl.trim() });
    setSaving(false);
    setMsg('已保存，重新进入对应页面即可生效');
    setTimeout(onClose, 900);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>设置</h3>
        <div className="field">
          <label>Pixiv Cookie（PHPSESSID）</label>
          <input
            type="text"
            value={cookie}
            placeholder="登录 pixiv.net 后从浏览器 Cookie 中获取"
            onChange={e => setCookie(e.target.value)}
          />
        </div>
        <div className="field">
          <label>代理地址（默认 http://127.0.0.1:7890）</label>
          <input
            type="text"
            value={proxyUrl}
            placeholder="http://127.0.0.1:7890"
            onChange={e => setProxyUrl(e.target.value)}
          />
        </div>
        {msg && <div className="hint" style={{ color: 'var(--ok)' }}>{msg}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
