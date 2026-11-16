import { useCallback, useEffect, useRef, useState } from 'react';
import { getSettings, saveSettings } from '../pixiv-assistant/index.js';
import { registerBackHandler } from '../utils/backHandler.js';
import { useOverlayFocus } from '../hooks/useOverlayFocus.js';
import { SOURCES } from '../sources/registry.js';
import { useVisibleSourceIds, setSourceVisible, setBooruSafeOnly } from '../hooks/useImageSource.js';
import { useHiddenTabKeys, setTabVisible } from '../hooks/useVisibleTabs.js';
import { useHiddenGridBadges, setGridBadgeVisible } from '../hooks/useGridBadges.js';
import { isDesktopShell, getDesktopProxy } from '../utils/platform.js';
import { setTheme } from '../utils/theme.js';
import SourceConfigPicker from './settings/SourceConfigPicker.jsx';
import PixivConfig from './settings/PixivConfig.jsx';
import XConfig from './settings/XConfig.jsx';
import WeiboConfig from './settings/WeiboConfig.jsx';
import InstagramConfig from './settings/InstagramConfig.jsx';
import GeneralGroups from './settings/GeneralGroups.jsx';
import {
  isMetaBackupAvailable, hasAllFilesAccess, requestAllFilesAccess, cleanupLegacyMetaPngs,
  backupNow, restoreNow,
} from '../pixiv-assistant/index.js';
import '../styles/settings.css';

/** 有配置子页的来源 → 组件映射（其余来源不进图源配置墙） */
const SOURCE_CONFIGS = {
  pixiv: PixivConfig,
  twitter: XConfig,
  weibo: WeiboConfig,
  instagram: InstagramConfig,
};

/**
 * 全屏设置页（壳）。
 * 只管：设置加载、串行即时保存（doSave）、toast、subSource 二级路由与返回链。
 * 各分组 / 图源子页是纯受控组件，状态全在这里。
 */
export default function SettingsPage({ onClose }) {
  const [cookie, setCookie] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [gridLayout, setGridLayout] = useState('waterfall');
  const [themeMode, setThemeMode] = useState('dark');
  const [saveDirectory, setSaveDirectory] = useState('');
  const [askEachTimeState, setAskEachTimeState] = useState(false);
  // X / 微博 / IG 的名单与 Cookie（各自子页编辑，这里统一持有）
  const [twitterUsers, setTwitterUsers] = useState('');
  const [nitterInstance, setNitterInstance] = useState('');
  const [twitterCookie, setTwitterCookie] = useState('');
  const [weiboUsers, setWeiboUsers] = useState('');
  const [weiboCookie, setWeiboCookie] = useState('');
  const [instagramUsers, setInstagramUsers] = useState('');
  const [instagramCookie, setInstagramCookie] = useState('');
  // 分级过滤走 useImageSource 单例（立即广播 + 自行持久化），不进 doSave
  const [safeOnly, setSafeOnly] = useState(false);
  // 图源配置二级子页：null = 主列表，否则为来源 id
  const [subSource, setSubSource] = useState(null);

  // 来源 / 页面 / 标记开关（单例响应式，随点击即时更新）
  const visibleSourceIds = useVisibleSourceIds();
  const hiddenTabKeys = useHiddenTabKeys();
  const hiddenGridBadges = useHiddenGridBadges();

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
      setTwitterCookie(s.twitterCookie || '');
      setWeiboUsers(s.weiboUsers || '');
      setWeiboCookie(s.weiboCookie || '');
      setInstagramUsers(s.instagramUsers || '');
      setInstagramCookie(s.instagramCookie || '');
      loadedResolveRef.current?.();
    });
    return () => { cancelled = true; };
  }, []);

  // 即时保存核心（串行队列，避免并发读改写引起的丢更新）
  const doSave = useCallback((patch, { silent = false } = {}) => {
    saveChain.current = saveChain.current
      .then(() => loadedPromiseRef.current)
      .then(() => getSettings())
      .then((s) => saveSettings({ ...s, ...patch }))
      .then(() => { if (!silent) showToast(); })
      .catch(() => { /* 静默忽略 */ });
  }, [showToast]);

  // 返回链：子页开着先退子页，再关设置。Esc / header 返回钮 / 系统返回键共用这一条
  const handleBack = useCallback(() => {
    if (subSource) {
      setSubSource(null);
      return;
    }
    onClose();
  }, [subSource, onClose]);

  const overlayRef = useOverlayFocus(true, handleBack);

  // 系统返回键
  useEffect(() => {
    return registerBackHandler(() => {
      handleBack();
      return true;
    });
  }, [handleBack]);

  // 子页切换时滚动归零（条件渲染不加动画，规避滚动位置恢复）
  const contentRef = useRef(null);
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [subSource]);

  // ── 通用分组的事件（壳持有，传给 GeneralGroups） ──
  const handleThemeChange = (value) => {
    setThemeMode(value);
    setTheme(value);
    doSave({ theme: value });
  };

  const handleGridLayoutChange = (value) => {
    setGridLayout(value);
    doSave({ gridLayout: value });
    window.dispatchEvent(new CustomEvent('pixiv:grid-layout-changed', { detail: value }));
  };

  const handleSafeOnlyChange = (v) => {
    setSafeOnly(v);
    setBooruSafeOnly(v);
  };

  const handleProxyChange = (value) => {
    setProxyUrl(value);
    doSave({ proxyUrl: value.trim() });
  };

  // ── 备份（安卓原生壳，「所有文件访问」+ 默认路径 Download/Prism） ──
  const backupAvailable = isMetaBackupAvailable();
  const [allFilesAccess, setAllFilesAccess] = useState(false);
  const prevAccessRef = useRef(false);
  useEffect(() => {
    if (!backupAvailable) return;
    let alive = true;
    const check = () => {
      hasAllFilesAccess().then(granted => {
        if (!alive) return;
        // 权限刚打开：立即迁移 —— 写一份到默认路径 + 清掉相册里的旧 PNG 副本
        if (granted && !prevAccessRef.current) {
          prevAccessRef.current = true;
          backupNow();
          cleanupLegacyMetaPngs();
        } else if (!granted) {
          prevAccessRef.current = false;
        }
        setAllFilesAccess(granted);
      }).catch(() => {});
    };
    check();
    // 用户在系统设置页开完开关回到 App 后自动刷新状态
    const timer = setInterval(check, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [backupAvailable]);

  const handleRequestAllFilesAccess = async () => {
    const launched = await requestAllFilesAccess();
    if (!launched) showToast('无法打开系统设置页');
  };

  const handleBackupNow = async () => {
    const n = await backupNow();
    showToast(n > 0 ? `已备份 ${n} 条记录` : '没有可备份的数据');
  };

  const handleRestoreBackup = async () => {
    const { imported, merged } = await restoreNow();
    const n = imported + merged;
    showToast(n > 0 ? `已恢复 ${n} 条记录` : '备份里没有需要恢复的数据');
    if (n > 0) window.dispatchEvent(new CustomEvent('pixiv:likes-updated'));
  };

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

  const ConfigPanel = subSource ? SOURCE_CONFIGS[subSource] : null;

  return (
    <div className="settings-overlay" ref={overlayRef} tabIndex={-1}>
      {/* 毛玻璃 sticky 顶栏 */}
      <div className="settings-header">
        <button className="settings-header-back" onClick={handleBack} aria-label="返回">‹</button>
        <span className="settings-header-title">
          {subSource ? SOURCES[subSource].label : '设置'}
        </span>
      </div>

      {/* 可滚动内容 */}
      <div className="settings-content" ref={contentRef}>
        {ConfigPanel ? (
          <ConfigPanel
            doSave={doSave}
            showToast={showToast}
            cookie={cookie}
            setCookie={setCookie}
            twitterUsers={twitterUsers}
            setTwitterUsers={setTwitterUsers}
            nitterInstance={nitterInstance}
            setNitterInstance={setNitterInstance}
            twitterCookie={twitterCookie}
            setTwitterCookie={setTwitterCookie}
            weiboUsers={weiboUsers}
            setWeiboUsers={setWeiboUsers}
            weiboCookie={weiboCookie}
            setWeiboCookie={setWeiboCookie}
            instagramUsers={instagramUsers}
            setInstagramUsers={setInstagramUsers}
            instagramCookie={instagramCookie}
            setInstagramCookie={setInstagramCookie}
          />
        ) : (
          <>
            <SourceConfigPicker onOpen={setSubSource} />
            <GeneralGroups
              themeMode={themeMode}
              onThemeChange={handleThemeChange}
              gridLayout={gridLayout}
              onGridLayoutChange={handleGridLayoutChange}
              hiddenGridBadges={hiddenGridBadges}
              onGridBadgeToggle={setGridBadgeVisible}
              hiddenTabKeys={hiddenTabKeys}
              onTabToggle={setTabVisible}
              visibleSourceIds={visibleSourceIds}
              onSourceToggle={setSourceVisible}
              safeOnly={safeOnly}
              onSafeOnlyChange={handleSafeOnlyChange}
              proxyUrl={proxyUrl}
              backupAvailable={backupAvailable}
              allFilesAccess={allFilesAccess}
              onRequestAllFilesAccess={handleRequestAllFilesAccess}
              onBackupNow={handleBackupNow}
              onRestoreBackup={handleRestoreBackup}
              onProxyChange={handleProxyChange}
              isDesktop={isDesktopShell()}
              saveDirectory={saveDirectory}
              onChooseDir={chooseDir}
              onResetDir={resetDir}
              askEachTime={askEachTimeState}
              onAskEachTimeChange={setAskEachTime}
            />
          </>
        )}
      </div>

      {/* 即时保存提示 */}
      {toast && <div className="settings-toast">{toast}</div>}
    </div>
  );
}
