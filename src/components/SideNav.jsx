/**
 * 桌面侧边栏导航 —— 仅在 ≥900px 显示（手机端由 CSS 隐藏，继续用底部 TabBar）。
 *
 * 三段结构：主导航 / 当前章节的二级项 / 底部设置入口。
 * 二级项只在对应章节激活时展开：把「我」(4) 和「排行」(8) 常驻铺开会把侧边栏撑得很长。
 * 取值与过滤和 MePage / RankingPage 共用 getMeSubTabs / getRankingModes，避免两处逻辑漂移。
 */
import { useRef } from 'react';
import { useImageSourceId, setImageSource } from '../hooks/useImageSource.js';
import { useDownloadJobs } from '../hooks/useDownloadJobs.js';
import { useSourcesExpanded, setSourcesExpanded } from '../hooks/useSourcesExpanded.js';
import { useAppStore } from '../store/useAppStore.js';
import { getMeSubTabs } from '../utils/meTabs.js';
import { getRankingModes, clampRankingCategory, canToggleR18 } from '../utils/rankingModes.js';
import { SOURCE_LIST, getSource } from '../sources/registry.js';

// 图标与设置页齿轮同规格：24×24、stroke=currentColor、线宽 2
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
  discover: (
    <>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </>
  ),
  ranking: (
    <>
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  me: (
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </>
  ),
};

function NavButton({ icon, label, active, onClick, sub = false, ...rest }) {
  return (
    <button
      className={`side-nav-item${sub ? ' side-nav-item--sub' : ''}${active ? ' active' : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      {...rest}
    >
      {icon && <span className="side-nav-icon" aria-hidden="true">{icon}</span>}
      <span className="side-nav-label">{label}</span>
    </button>
  );
}

export default function SideNav({ tabs, active, onChange, onOpenSettings, onSearchNav }) {
  const sourceId = useImageSourceId(); // 排行/我的子项跟随当前来源
  const sourcesExpanded = useSourcesExpanded();
  const currentSource = getSource(sourceId);
  const meSubTabs = getMeSubTabs(sourceId);
  const meSubTab = useAppStore(s => s.meSubTab);
  const setMeSubTab = useAppStore(s => s.setMeSubTab);
  const settingsOpen = useAppStore(s => s.settingsOpen);
  const searchComposerOpen = useAppStore(s => s.searchComposerOpen);
  const setDownloadOpen = useAppStore(s => s.setDownloadOpen);
  const closeOverlays = useAppStore(s => s.closeOverlays);
  const { total, failCount } = useDownloadJobs();

  const { modes: rankingModes, isBooru } = getRankingModes(sourceId);
  const rawRankingCategory = useAppStore(s => s.rankingCategory);
  const rankingCategory = clampRankingCategory(rankingModes, rawRankingCategory);
  const rankingR18 = useAppStore(s => s.rankingR18);
  const selectRankingCategory = useAppStore(s => s.selectRankingCategory);
  const toggleRankingR18 = useAppStore(s => s.toggleRankingR18);

  // 「我」的二级页签要跟在本项正下方，所以把它排到最后，
  // 否则四个主项会被二级项割断（手机端 TABS 顺序不受影响）
  const orderedTabs = [...tabs.filter(t => t.key !== 'me'), ...tabs.filter(t => t.key === 'me')];

  // 只有在对应章节里才展开二级项：常驻铺开的话「我」4 项 + 「排行」8 项会把侧边栏撑满
  const renderSubs = (key) => {
    if (key === 'me' && meSubTabs.length > 1) {
      return meSubTabs.map(s => (
        <NavButton
          key={s.key}
          label={s.label}
          active={meSubTab === s.key}
          onClick={() => setMeSubTab(s.key)}
          sub
        />
      ));
    }
    if (key === 'ranking') {
      return (
        <>
          {rankingModes.map(m => (
            <NavButton
              key={m.key}
              label={m.label}
              active={m.key === rankingCategory}
              onClick={() => selectRankingCategory(m.key)}
              sub
            />
          ))}
          {/* booru 来源没有 R18 档，整行不出现 */}
          {!isBooru && (
            <button
              className="side-nav-item side-nav-item--sub side-nav-item--switch"
              onClick={toggleRankingR18}
              disabled={!canToggleR18(rankingCategory)}
              aria-pressed={rankingR18}
              aria-label={`R18 内容：${rankingR18 ? '已开启' : '已关闭'}`}
            >
              <span className="side-nav-label">R18 内容</span>
              <span className={`side-nav-state${rankingR18 ? ' on' : ''}`}>
                {rankingR18 ? 'R18' : '公开'}
              </span>
            </button>
          )}
        </>
      );
    }
    return null;
  };

  // 方向键在导航项之间移动焦点（Home/End 跳首尾）。
  // 按钮本身 Tab 就能到，这里补的是「进入侧边栏后用方向键连续浏览」的预期行为；
  // 焦点在子项上时会跨到下一个主项，因为选择器取的是全部 .side-nav-item。
  const navRef = useRef(null);
  const onKeyDown = (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...(navRef.current?.querySelectorAll('.side-nav-item:not(:disabled)') || [])];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length
      : e.key === 'ArrowUp' ? (i - 1 + items.length) % items.length
        : e.key === 'Home' ? 0 : items.length - 1;
    items[next].focus();
  };

  return (
    <nav className="side-nav" aria-label="侧边栏导航" ref={navRef} onKeyDown={onKeyDown}>
      <div className="side-nav-brand">PixivViewer</div>

      {/* 来源单选：折叠样式同「排行」展开二级项 —— 标题行展开/收起，
          列表里当前来源恒为激活副项（收起时只留一行显示当前来源名）。
          点副项切换来源但不收起列表，方便连换几站对比 */}
      {SOURCE_LIST.length > 1 && (
        <div className="side-nav-group side-nav-group--source">
          <button
            className="side-nav-item side-nav-toggle"
            onClick={() => setSourcesExpanded(!sourcesExpanded)}
            aria-expanded={sourcesExpanded}
            aria-label={`来源：${currentSource?.shortLabel || currentSource?.label || ''}`}
          >
            <span className="side-nav-icon" aria-hidden="true">
              <svg {...svgProps}>{ICONS.source}</svg>
            </span>
            <span className="side-nav-label">来源</span>
            {!sourcesExpanded && (
              <span className="side-nav-value">{currentSource?.shortLabel || currentSource?.label || ''}</span>
            )}
            <svg
              className={`side-nav-chevron${sourcesExpanded ? ' open' : ''}`}
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
            <div className="side-nav-subs">
              {SOURCE_LIST.map(s => (
                <NavButton
                  key={s.id}
                  label={s.shortLabel || s.label}
                  active={sourceId === s.id}
                  onClick={() => { closeOverlays(); setImageSource(s.id); }}
                  sub
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="side-nav-group">
        {orderedTabs.map(t => {
          // 桌面端「搜索」点开的是悬浮搜索框（不跳页），所以唤起态也算选中
          const isActive = active === t.key || (t.key === 'search' && searchComposerOpen);
          const subs = isActive ? renderSubs(t.key) : null;
          return (
            <div key={t.key}>
              <NavButton
                icon={<svg {...svgProps}>{ICONS[t.key]}</svg>}
                label={t.label}
                active={isActive}
                aria-current={active === t.key ? 'page' : undefined}
                {...(t.key === 'search' ? { 'data-search-toggle': '' } : null)}
                onClick={() => (t.key === 'search' && onSearchNav ? onSearchNav() : onChange(t.key))}
              />
              {subs && <div className="side-nav-subs">{subs}</div>}
            </div>
          );
        })}
      </div>

      <div className="side-nav-footer">
        <button className="side-nav-item" onClick={() => setDownloadOpen(true)}>
          <span className="side-nav-icon"><svg {...svgProps}>{ICONS.download}</svg></span>
          <span className="side-nav-label">下载</span>
          {/* 有失败优先显示失败数（红色），否则显示队列文件数 */}
          {failCount > 0
            ? <span className="side-nav-badge side-nav-badge--fail">{failCount}</span>
            : total > 0 && <span className="side-nav-badge">{total}</span>}
        </button>

        <NavButton
          icon={<svg {...svgProps}>{ICONS.settings}</svg>}
          label="设置"
          active={settingsOpen}
          onClick={onOpenSettings}
        />
      </div>
    </nav>
  );
}
