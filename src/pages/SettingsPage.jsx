import { useCallback, useEffect, useRef, useState } from 'react';
import { getSettings, saveSettings } from '../pixiv-assistant/index.js';
import { registerBackHandler } from '../utils/backHandler.js';
import { useOverlayFocus } from '../hooks/useOverlayFocus.js';
import { getSource } from '../sources/registry.js';
import { fetchFollowing, parseUserList } from '../sources/nitter.js';
import { useImageSourceId, setBooruSafeOnly } from '../hooks/useImageSource.js';
import { isDesktopShell, getDesktopProxy } from '../utils/platform.js';
import { setTheme } from '../utils/theme.js';
import '../styles/settings.css';

const LAYOUT_OPTIONS = [
  { value: 'waterfall', label: '瀑布流' },
  { value: 'grid', label: '方形宫格' },
];

const THEME_OPTIONS = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

/**
 * 全屏设置页。
 * 覆盖在 tab 页之上，毛玻璃 sticky header + 卡片式分组 + 即时保存。
 */
export default function SettingsPage({ onClose }) {
  const [cookie, setCookie] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [gridLayout, setGridLayout] = useState('waterfall');
  const [themeMode, setThemeMode] = useState('dark');
  const [saveDirectory, setSaveDirectory] = useState('');
  const [askEachTimeState, setAskEachTimeState] = useState(false);
  // X 图源（Nitter）：名单与实例都是纯本地配置，切到 X 时才显示
  const [twitterUsers, setTwitterUsers] = useState('');
  const [nitterInstance, setNitterInstance] = useState('');
  // 「从账号导入关注列表」的输入与进行中状态
  const [importHandle, setImportHandle] = useState('');
  const [importing, setImporting] = useState(false);
  // 当前来源：读模块单例的实时值（切来源的入口在侧边栏 / 抽屉，不在这里）。
  // 分级过滤是 booru 专属项，靠它决定显隐，所以必须跟着实时值走，不能只读一次 settings。
  const imageSourceId = useImageSourceId();
  // 分级开关走 useImageSource 的模块单例（立即广播 + 自行持久化），
  // 所以它不能进 doSave —— 否则同一次改动会写两遍 settings。
  const [safeOnly, setSafeOnly] = useState(false);

  // Cookie 收起/展开
  const [cookieOpen, setCookieOpen] = useState(false);

  // 即时保存状态
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);

  const showToast = useCallback((msg = '已保存') => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 1800);
  }, []);

  // 卸载时清理 toast 定时器
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // 串行化保存队列，规避读-改-写竞态丢失更新；并等待首次加载完成，避免首次保存被丢弃
  const saveChain = useRef(Promise.resolve());
  const loadedResolveRef = useRef(null);
  const loadedPromiseRef = useRef(null);
  if (loadedPromiseRef.current === null) {
    loadedPromiseRef.current = new Promise((resolve) => { loadedResolveRef.current = resolve; });
  }

  // 加载设置
  useEffect(() => {
    let cancelled = false;
    getSettings().then(s => {
      if (cancelled) return;
      setCookie(s.pixivCookie || '');
      setProxyUrl(s.proxyUrl || '');
      setGridLayout(s.gridLayout || 'waterfall');
      setThemeMode(s.theme || 'dark');
      setSaveDirectory(s.saveDirectory || '');
      setAskEachTimeState(s.saveAskEachTime === true);
      setSafeOnly(s.booruSafeOnly === true);
      setTwitterUsers(s.twitterUsers || '');
      setNitterInstance(s.nitterInstance || '');
      loadedResolveRef.current?.();
    });
    return () => { cancelled = true; };
  }, []);

  const overlayRef = useOverlayFocus(true, onClose);

  // 系统返回键
  useEffect(() => {
    return registerBackHandler(() => {
      onClose();
      return true;
    });
  }, [onClose]);

  // 即时保存核心（串行队列，避免并发读改写引起的丢更新）
  const doSave = useCallback((patch, { silent = false } = {}) => {
    saveChain.current = saveChain.current
      .then(() => loadedPromiseRef.current)
      .then(() => getSettings())
      .then((s) => saveSettings({ ...s, ...patch }))
      .then(() => { if (!silent) showToast(); })
      .catch(() => { /* 静默忽略 */ });
  }, [showToast]);

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
  }, [importHandle, importing, twitterUsers, doSave, showToast]);

  // 选择图片保存目录（仅桌面壳，经 Electron 文件夹选择对话框）
  const chooseDir = async () => {
    const dir = await getDesktopProxy()?.chooseDirectory?.();
    if (dir) {
      setSaveDirectory(dir);
      doSave({ saveDirectory: dir });
    }
  };

  // 恢复系统默认（图片文件夹）
  const resetDir = () => {
    setSaveDirectory('');
    doSave({ saveDirectory: '' });
  };

  // 指定目录后是否仍每次弹「另存为」
  const setAskEachTime = (v) => {
    setAskEachTimeState(v);
    doSave({ saveAskEachTime: v });
  };

  return (
    <div className="settings-overlay" ref={overlayRef} tabIndex={-1}>
      {/* 毛玻璃 sticky 顶栏 */}
      <div className="settings-header">
        <button className="settings-header-back" onClick={onClose} aria-label="返回">‹</button>
        <span className="settings-header-title">设置</span>
      </div>

      {/* 可滚动内容 */}
      <div className="settings-content">
        {/* ── 账号 ── */}
        <div className="settings-group">
          <div className="settings-group-label">账号</div>

          {/* Cookie — 点击展开 */}
          <div
            className="settings-row settings-row-expand"
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

        {/* ── 来源 ──
            来源本身只在侧边栏 / 抽屉的「来源」组里切（这里原来还有一排来源胶囊，
            同一件事两个入口，已删）；本组只留跟着当前来源走的分级过滤 */}
        <div className="settings-group">
          <div className="settings-group-label">来源</div>

          {/* 分级过滤：仅图站有意义（Pixiv 的分级由账号设置决定） */}
          {getSource(imageSourceId).kind !== 'pixiv' && (
            <div className="settings-row">
              <div style={{ minWidth: 0 }}>
                <div className="settings-row-label">分级过滤</div>
                <div className="settings-row-hint">
                  {/* 各站的过滤语法不同（rating:safe / rating:g / purity），这里不写死某一种 */}
                  {safeOnly ? '只显示安全级作品' : '显示该站可获取的全部分级'}
                </div>
              </div>
              <div className="settings-pill-group">
                <button
                  className={`settings-pill${safeOnly ? '' : ' settings-pill--active'}`}
                  onClick={() => { setSafeOnly(false); setBooruSafeOnly(false); }}
                  aria-pressed={!safeOnly}
                >全部</button>
                <button
                  className={`settings-pill${safeOnly ? ' settings-pill--active' : ''}`}
                  onClick={() => { setSafeOnly(true); setBooruSafeOnly(true); }}
                  aria-pressed={safeOnly}
                >仅安全</button>
              </div>
            </div>
          )}
        </div>

        {/* ── X (Twitter) 图源 ──
            只在切到 X 时显示：名单是本地静态配置（Nitter 读不到你的 following），
            改了之后回到「推荐」下拉刷新即可生效 */}
        {getSource(imageSourceId).kind === 'nitter' && (
          <div className="settings-group">
            <div className="settings-group-label">X 图源</div>
            <div className="settings-row">
              <div style={{ minWidth: 0 }}>
                <div className="settings-row-label">关注名单</div>
                <div className="settings-row-hint">
                  一行一个，支持 @name / x.com/name。Nitter 只覆盖每个账号最近约 50 条媒体。
                </div>
              </div>
            </div>
            <div className="settings-input-row">
              <textarea
                className="settings-textarea"
                value={twitterUsers}
                placeholder={'@ToMoveee\nx.com/somebody_else'}
                onChange={e => setTwitterUsers(e.target.value)}
                onBlur={() => doSave({ twitterUsers })}
              />
            </div>
            <div className="settings-row">
              <div style={{ minWidth: 0 }}>
                <div className="settings-row-label">从账号导入</div>
                <div className="settings-row-hint">
                  读取该账号的公开关注列表，去重后合并进上面（私密账号读不到）
                </div>
              </div>
            </div>
            <div className="settings-input-row settings-import-row">
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
            <div className="settings-row">
              <div style={{ minWidth: 0 }}>
                <div className="settings-row-label">Nitter 实例</div>
                <div className="settings-row-hint">留空自动轮换；填域名，如 nitter.netbub.com</div>
              </div>
            </div>
            <div className="settings-input-row">
              <input
                className="settings-input"
                type="text"
                value={nitterInstance}
                placeholder="nitter.netbub.com"
                onChange={e => setNitterInstance(e.target.value)}
                onBlur={() => doSave({ nitterInstance: nitterInstance.trim() })}
              />
            </div>
          </div>
        )}

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

        {/* ── 外观 ── */}
        <div className="settings-group">
          <div className="settings-group-label">外观</div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">主题</div>
              <div className="settings-row-hint">跟随系统时随系统暗/亮实时联动</div>
            </div>
            <div className="settings-pill-group">
              {THEME_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  className={`settings-pill${themeMode === opt.value ? ' settings-pill--active' : ''}`}
                  onClick={() => {
                    setThemeMode(opt.value);
                    setTheme(opt.value);
                    doSave({ theme: opt.value });
                  }}
                  aria-pressed={themeMode === opt.value}
                >{opt.label}</button>
              ))}
            </div>
          </div>
        </div>

        {/* ── 布局 ── */}
        <div className="settings-group">
          <div className="settings-group-label">布局</div>
          <div className="settings-row">
            <div>
              <div className="settings-row-label">网格样式</div>
              <div className="settings-row-hint">瀑布流按真实比例密铺，方形宫格整齐等分</div>
            </div>
            <div className="settings-pill-group">
              {LAYOUT_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  className={`settings-pill${gridLayout === opt.value ? ' settings-pill--active' : ''}`}
                  onClick={() => {
                    setGridLayout(opt.value);
                    doSave({ gridLayout: opt.value });
                    window.dispatchEvent(new CustomEvent('pixiv:grid-layout-changed', { detail: opt.value }));
                  }}
                  aria-pressed={gridLayout === opt.value}
                >{opt.label}</button>
              ))}
            </div>
          </div>
        </div>

        {/* ── 保存 ── 仅桌面壳 */}
        {isDesktopShell() && (
          <div className="settings-group">
            <div className="settings-group-label">保存</div>
            <div className="settings-row">
              <div style={{ minWidth: 0 }}>
                <div className="settings-row-label">图片保存目录</div>
                <div className="settings-row-hint" style={{ wordBreak: 'break-all' }}>{saveDirectory || '系统「图片」文件夹'}</div>
              </div>
              <div className="settings-pill-group">
                <button className="settings-pill" onClick={chooseDir}>选择文件夹</button>
                {saveDirectory && (
                  <button className="settings-pill" onClick={resetDir}>恢复默认</button>
                )}
              </div>
            </div>

            <div className="settings-row">
              <div style={{ minWidth: 0 }}>
                <div className="settings-row-label">保存方式</div>
                <div className="settings-row-hint">
                  {!saveDirectory
                    ? '未指定目录，保存时会弹「另存为」'
                    : (askEachTimeState ? '每次保存都弹「另存为」' : '直接存进上面的目录，不再打断')}
                </div>
              </div>
              <div className="settings-pill-group">
                <button
                  className={`settings-pill${askEachTimeState ? '' : ' settings-pill--active'}`}
                  onClick={() => setAskEachTime(false)}
                  aria-pressed={!askEachTimeState}
                >直接保存</button>
                <button
                  className={`settings-pill${askEachTimeState ? ' settings-pill--active' : ''}`}
                  onClick={() => setAskEachTime(true)}
                  aria-pressed={askEachTimeState}
                >每次询问</button>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* 即时保存提示 */}
      {toast && <div className="settings-toast">{toast}</div>}
    </div>
  );
}