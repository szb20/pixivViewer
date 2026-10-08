/**
 * 手机端导航抽屉 —— <900px 的侧边栏形态，内容就是桌面常驻 SideNav 的同一份实现。
 *
 * 本文件只管抽屉外壳（遮罩 / 面板 / 焦点 / 返回键）；导航内容由 App 以 children 传进来。
 * 三路关闭：安卓返回键（registerBackHandler）/ Esc（useOverlayFocus 栈顶）/ backdrop 点击。
 *
 * 入口按钮 DrawerTrigger 也在这里 —— 与抽屉是一体的，
 * 且它订阅了下载队列（角标），必须自成一个组件：
 * 放在 App 里会让每次下载进度跳动都重渲染整棵页面树。
 */
import { useEffect } from 'react';
import { useOverlayFocus } from '../hooks/useOverlayFocus.js';
import { registerBackHandler } from '../utils/backHandler.js';
import { useDownloadJobs } from '../hooks/useDownloadJobs.js';
import '../styles/navDrawer.css';

export default function NavDrawer({ onClose, children }) {
  const panelRef = useOverlayFocus(true, onClose);

  // 安卓返回键先关抽屉：backHandler 倒序栈，灯箱/详情的 handler 先注册先消费，层级天然正确
  useEffect(() => {
    return registerBackHandler(() => {
      onClose();
      return true;
    });
  }, [onClose]);

  // 焦点刚落在面板上（还没进导航项）时，方向键直达第一个导航项；
  // 焦点已经在导航项里时由 SideNav 自己的 roving focus 处理（那条路径的 target 是按钮）
  const onKeyDown = (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    if (e.target !== panelRef.current) return;
    const items = panelRef.current?.querySelectorAll('.side-nav-item:not(:disabled)');
    if (!items?.length) return;
    e.preventDefault();
    (e.key === 'End' ? items[items.length - 1] : items[0]).focus();
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="导航"
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * 左上角汉堡入口。offscreen 时只做位移不收起来 —— 抽屉打开期间它必须留在 DOM 里，
 * 否则 useOverlayFocus 关闭时要把焦点还回去的那个元素已经不在文档中了（焦点会掉到 body）。
 */
export function DrawerTrigger({ offscreen, onClick }) {
  const { activeCount, failCount } = useDownloadJobs();
  const busy = activeCount + failCount;

  return (
    <button
      className={`glass-icon-btn drawer-trigger${offscreen ? ' drawer-trigger--hidden' : ''}`}
      onClick={onClick}
      tabIndex={offscreen ? -1 : undefined}
      aria-label={busy > 0 ? `打开侧边栏（${busy} 个下载任务）` : '打开侧边栏'}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
      {/* 下载悬浮球已删，这里是有进行中/失败任务时手机端唯一的常驻提示（失败优先显示红色） */}
      {busy > 0 && (
        <span className={`drawer-trigger-badge${failCount > 0 ? ' drawer-trigger-badge--fail' : ''}`}>
          {busy}
        </span>
      )}
    </button>
  );
}
