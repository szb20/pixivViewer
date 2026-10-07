/**
 * 手机端侧边抽屉 — 来源单选 + 快捷入口（设置 / 下载管理）。
 *
 * 桌面端有常驻 SideNav，本组件只服务 <900px：入口是 App 渲染的左上角汉堡按钮。
 * 三路关闭：安卓返回键（registerBackHandler）/ Esc（useOverlayFocus 栈顶）/ backdrop 点击。
 */
import { useEffect } from 'react';
import { useOverlayFocus } from '../hooks/useOverlayFocus.js';
import { registerBackHandler } from '../utils/backHandler.js';
import { useImageSourceId, setImageSource } from '../hooks/useImageSource.js';
import { useSourcesExpanded, setSourcesExpanded } from '../hooks/useSourcesExpanded.js';
import { useDownloadJobs } from '../hooks/useDownloadJobs.js';
import { useAppStore } from '../store/useAppStore.js';
import { SOURCE_LIST, getSource } from '../sources/registry.js';
import '../styles/sourceDrawer.css';

// 图标规格与 SideNav / 设置页齿轮一致：24 viewBox、stroke=currentColor、线宽 2
const svgProps = {
  width: 19,
  height: 19,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const ICONS = {
  source: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
};

export default function SourceDrawer({ onClose, onOpenSettings }) {
  const sourceId = useImageSourceId();
  const sourcesExpanded = useSourcesExpanded();
  const currentSource = getSource(sourceId);
  const closeOverlays = useAppStore(s => s.closeOverlays);
  const setDownloadOpen = useAppStore(s => s.setDownloadOpen);
  const { total, failCount } = useDownloadJobs();
  const panelRef = useOverlayFocus(true, onClose);

  // 安卓返回键先关抽屉：backHandler 倒序栈，灯箱/详情的 handler 先注册先消费，层级天然正确
  useEffect(() => {
    return registerBackHandler(() => {
      onClose();
      return true;
    });
  }, [onClose]);

  // 抽屉里的动作都先关抽屉再执行
  const closeAnd = (fn) => () => {
    onClose();
    fn();
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <nav
        className="drawer-panel"
        ref={panelRef}
        role="dialog"
        aria-label="导航抽屉"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-brand-row">
          <div className="drawer-brand">PixivViewer</div>
          <button className="drawer-close-btn" onClick={onClose} aria-label="关闭侧边栏">
            <svg {...svgProps} width={18} height={18}>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* 来源单选：与桌面侧边栏同款折叠交互 —— 标题行展开/收起，
            展开态持久化共享（useSourcesExpanded）；点副项切换来源（抽屉不自动关，方便连换对比） */}
        <div className="drawer-group">
          <button
            className="drawer-item drawer-toggle"
            onClick={() => setSourcesExpanded(!sourcesExpanded)}
            aria-expanded={sourcesExpanded}
            aria-label={`来源：${currentSource?.shortLabel || currentSource?.label || ''}`}
          >
            <span className="drawer-icon" aria-hidden="true">
              <svg {...svgProps}>{ICONS.source}</svg>
            </span>
            <span className="drawer-label">来源</span>
            {!sourcesExpanded && (
              <span className="drawer-value">{currentSource?.shortLabel || currentSource?.label || ''}</span>
            )}
            <svg
              className={`drawer-chevron${sourcesExpanded ? ' open' : ''}`}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          {sourcesExpanded && (
            <div className="drawer-subs">
              {SOURCE_LIST.map(s => (
                <button
                  key={s.id}
                  className={`drawer-item drawer-item--sub${sourceId === s.id ? ' active' : ''}`}
                  onClick={() => { closeOverlays(); setImageSource(s.id); }}
                  aria-current={sourceId === s.id ? 'true' : undefined}
                >
                  <span className="drawer-label">{s.shortLabel || s.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="drawer-footer">
          <button className="drawer-item" onClick={closeAnd(() => setDownloadOpen(true))}>
            <span className="drawer-icon" aria-hidden="true"><svg {...svgProps}>{ICONS.download}</svg></span>
            <span className="drawer-label">下载管理</span>
            {/* 有失败优先显示失败数（红色），否则显示队列文件数 */}
            {failCount > 0
              ? <span className="drawer-badge drawer-badge--fail">{failCount}</span>
              : total > 0 && <span className="drawer-badge">{total}</span>}
          </button>

          <button className="drawer-item" onClick={closeAnd(onOpenSettings)}>
            <span className="drawer-icon" aria-hidden="true"><svg {...svgProps}>{ICONS.settings}</svg></span>
            <span className="drawer-label">设置</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
