import { useCallback, useState } from 'react';
import CookieField from './CookieField.jsx';
import { isValidCookieText } from '../../sources/xDirect.js';
import { fetchFollowing, parseUserList } from '../../sources/nitter.js';

/** X 子页：登录 Cookie（直连官方）+ 关注名单（Nitter 回落）+ 从账号导入 + Nitter 实例 */
export default function XConfig({
  twitterUsers, setTwitterUsers,
  nitterInstance, setNitterInstance,
  twitterCookie, setTwitterCookie,
  doSave, showToast,
}) {
  // 「从账号导入」的输入与进行中状态：纯 UI 态，留在本组件即可
  const [importHandle, setImportHandle] = useState('');
  const [importing, setImporting] = useState(false);

  // 从某个账号的公开 following 导入名单：去重合并后写入设置
  const importFollowing = useCallback(async () => {
    const handle = importHandle.trim().replace(/^@/, '');
    if (!handle || importing) return;
    setImporting(true);
    try {
      const list = await fetchFollowing(handle);
      if (!list.length) {
        showToast('没读到关注列表（账号不存在或已设为私密）');
        return;
      }
      const merged = [...new Set([...parseUserList(twitterUsers), ...list])];
      const next = merged.join('\n');
      setTwitterUsers(next);
      doSave({ twitterUsers: next }, { silent: true });
      showToast(`已导入 ${list.length} 个（合计 ${merged.length}）`);
    } catch {
      showToast('导入失败，检查网络或实例');
    } finally {
      setImporting(false);
    }
  }, [importHandle, importing, twitterUsers, setTwitterUsers, doSave, showToast]);

  return (
    <div className="settings-group">
      <CookieField
        label="登录 Cookie（可选，推荐）"
        value={twitterCookie}
        onChange={setTwitterCookie}
        onBlur={() => {
          const v = twitterCookie.trim();
          if (v && !isValidCookieText(v)) {
            showToast('Cookie 里缺少 auth_token 或 ct0，检查是否复制完整');
            return;
          }
          doSave({ twitterCookie: v });
        }}
        placeholder="auth_token=xxx; ct0=xxx; ... （整段粘贴）"
        hint="登录 x.com → F12 → Network → 任意请求 → 复制整段 Cookie 请求头（须含 auth_token 与 ct0）。配置后关注流 / 搜索 / 推荐博主直连官方接口，失败自动回落 Nitter"
      />

      <div className="settings-field">
        <div className="settings-field-label">关注名单</div>
        <textarea
          className="settings-textarea"
          value={twitterUsers}
          placeholder={'@ToMoveee\nx.com/somebody_else'}
          onChange={e => setTwitterUsers(e.target.value)}
          onBlur={() => doSave({ twitterUsers })}
        />
      </div>

      <div className="settings-field">
        <div className="settings-field-label">从账号导入</div>
        <div className="settings-import-row">
          <input
            className="settings-input"
            type="text"
            value={importHandle}
            placeholder="@mikunikuni1"
            onChange={e => setImportHandle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') importFollowing(); }}
          />
          <button
            className="settings-pill"
            onClick={importFollowing}
            disabled={importing || !importHandle.trim()}
          >
            {importing ? '导入中…' : '导入'}
          </button>
        </div>
      </div>

      <div className="settings-field">
        <div className="settings-field-label">Nitter 实例</div>
        <input
          className="settings-input"
          type="text"
          value={nitterInstance}
          placeholder="留空自动轮换；填域名，如 nitter.netbub.com"
          onChange={e => setNitterInstance(e.target.value)}
          onBlur={() => doSave({ nitterInstance: nitterInstance.trim() })}
        />
      </div>
    </div>
  );
}
