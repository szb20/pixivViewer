/**
 * 侧边栏导航 —— 常驻形态在 ≥900px 显示，手机端（<900px）装进抽屉（NavDrawer）里同一份实现。
 *
 * 三段结构：主导航 / 当前章节的二级项 / 底部全局组（喜欢/下载/设置）。
 * 三组可折叠，交互一致（行右侧箭头，状态持久化）：来源组点整行，主导航行上的箭头是独立热区 ——
 * 那行还要负责切页签，不能让点一下就翻倍成「切页 + 折叠」。
 * 二级项默认只在对应章节展开（「排行」8 项常驻铺开会把侧边栏撑得很长），
 * 手动点过箭头的章节以用户的选择为准，见 useSectionExpanded。
 * 点二级项 = 选中它 + 切到它所属的页面（已在那一页则只换内容）—— 二级项是「具体条目」，
 * 选完必须能看到结果，否则这一下点击在界面上等于没发生（抽屉里还先把抽屉关掉了）。
 * 取值与过滤和 RankingPage 共用 getRankingModes，避免两处逻辑漂移。
 *
 * R18 是当前档位的修饰（公开/R18 两个变体）而不是又一个档位，所以不跟档位列表并排：
 * 开关挂在「排行」行右侧，与展开箭头一样是独立热区（不能塞进 .side-nav-item —— button 套 button 是非法 HTML）。
 *
 * variant='drawer' 时：根节点挂 .side-nav--drawer（样式在 styles/navDrawer.css），
 * 品牌行多一个关闭按钮，除「来源」副项与 R18 开关（两者都不换页）外的所有动作都先关抽屉再执行
 * —— 选完要能立刻看到结果。
 */
import { useRef } from 'react';
import { useImageSourceId, useVisibleSourceIds, setImageSource } from '../hooks/useImageSource.js';
import { useDownloadJobs } from '../hooks/useDownloadJobs.js';
import { useSourcesExpanded, setSourcesExpanded } from '../hooks/useSourcesExpanded.js';
import { useSectionExpanded, setSectionExpanded } from '../hooks/useSectionExpanded.js';
import { useAppStore } from '../store/useAppStore.js';
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
  following: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="22" y1="11" x2="16" y2="11" />
    </>
  ),
  subscriptions: (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  liked: (
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  ),
  bookmarks: (
    <>
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
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

/**
 * 「排行」行右侧的 R18 开关（独立热区，不参与整行的展开/切页点击）。
 * 三档状态：关（公开）/ 开（R18）/ 不可用（当前档位没有 R18 变体，见 canToggleR18）。
 *
 * 开态靠 class（.side-nav-r18--on）而不是 [aria-checked="true"] 选择器 ——
 * 实测本机 Chromium 下**改 aria-* 属性不会让元素样式失效**：改完属性颜色/滑钮都不动，
 * 得等别的改动顺手触发一次重算才跟上（开关拨了没反应的那种怪 bug）。
 * aria-checked 照旧输出，只是别拿它做样式钩子。
 */
function R18Switch({ on, disabled, onToggle }) {
  return (
    <button
      type="button"
      className={`side-nav-r18${on ? ' side-nav-r18--on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label="R18 内容"
      disabled={disabled}
      title={disabled ? '当前档位没有 R18 变体' : `R18 内容：${on ? '已开启' : '已关闭'}`}
      // 不裹 act()：开关本身不换页，顺手关掉抽屉反而看不见自己刚改了什么
      onClick={onToggle}
    >
      <span aria-hidden="true">R18</span>
      <span className="side-nav-r18-track" aria-hidden="true">
        <span className="side-nav-r18-knob" />
      </span>
    </button>
  );
}

export default function SideNav({
  tabs, active, onChange, onOpenSettings, onSearchNav,
  variant = 'rail', onClose,
}) {
  const isDrawer = variant === 'drawer';
  const sourceId = useImageSourceId(); // 排行/我的子项跟随当前来源
  // 设置页「来源开关」可隐藏部分来源；当前来源即使被隐藏也保留在列表里，
  // 否则展开后没有激活项，收起时也看不出当前在哪一站
  const visibleSourceIds = useVisibleSourceIds();
  const sourceOptions = SOURCE_LIST.filter(s => visibleSourceIds.includes(s.id) || s.id === sourceId);
  const sourcesExpanded = useSourcesExpanded();
  const sectionExpanded = useSectionExpanded();
  const currentSource = getSource(sourceId);
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

  // 「喜欢」是跨来源的本地库（IndexedDB），语义上属全局项 → 从主导航拆出、渲染到底部组，
  // 主导航保持「每一项都跟随当前来源」的纯粹。tab 机制不变：点它同样走 onChange
  const likedTab = tabs.find(t => t.key === 'liked');
  const mainTabs = tabs.filter(t => t.key !== 'liked');

  // 抽屉里点任何一项都先关抽屉再执行 —— 抽屉盖着的正是要看的页面。
  // 例外是「来源」副项与 R18 开关：它们不换页，连换几站/拨开关时不希望每次都要重开抽屉。
  const act = (fn) => () => {
    if (isDrawer) onClose?.();
    fn();
  };

  // 点二级项 = 选中它 + 切到它所属的页面。已经在那一页时不能再调 setActiveTab ——
  // 那会被当成「点当前项 = 刷新」，白白丢掉列表和滚动位置（换档位本来就会重新加载）。
  const pickSub = (tabKey, select) => act(() => {
    select();
    if (active !== tabKey) onChange(tabKey);
  });

  // 哪些章节有二级项可展开（决定要不要给这一行加箭头）。
  // 有箭头与否只看「点开有没有东西」，让「点行先展开」这套手势在所有来源下一致。
  const hasSubs = (key) => key === 'ranking' && rankingModes.length > 0;

  // 二级项显隐 = 用户手动点过箭头就听他的，没点过沿用旧规则（只在当前章节展开）。
  // 常驻铺开的话「排行」8 项会把侧边栏撑满。
  const subsVisible = (key) => sectionExpanded[key] ?? (active === key);

  // 二级项的内容渲染（显隐由上面的 subsVisible 决定）
  const renderSubs = (key) => {
    if (key === 'ranking') {
      return rankingModes.map(m => (
        <NavButton
          key={m.key}
          label={m.label}
          active={m.key === rankingCategory}
          onClick={pickSub('ranking', () => selectRankingCategory(m.key))}
          sub
        />
      ));
    }
    return null;
  };

  // 方向键在导航项之间移动焦点（Home/End 跳首尾）。
  // 按钮本身 Tab 就能到，这里补的是「进入侧边栏后用方向键连续浏览」的预期行为；
  // 焦点在子项上时会跨到下一个主项，因为选择器取的是全部 .side-nav-item。
  // 展开箭头（.side-nav-chevron-btn）与 R18 开关也算一站：它们是独立热区，键盘不该只能 Tab 到它们。
  const navRef = useRef(null);
  const onKeyDown = (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...(navRef.current?.querySelectorAll('.side-nav-item:not(:disabled), .side-nav-chevron-btn, .side-nav-r18:not(:disabled)') || [])];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length
      : e.key === 'ArrowUp' ? (i - 1 + items.length) % items.length
        : e.key === 'Home' ? 0 : items.length - 1;
    items[next].focus();
  };

  return (
    <nav
      className={`side-nav${isDrawer ? ' side-nav--drawer' : ''}`}
      aria-label="侧边栏导航"
      ref={navRef}
      onKeyDown={onKeyDown}
    >
      {/* 抽屉形态的品牌行右侧多一个关闭按钮（桌面常驻栏没有「关闭」这个概念） */}
      <div className="side-nav-brand">
        PixivViewer
        {isDrawer && (
          <button className="side-nav-close-btn" onClick={onClose} aria-label="关闭侧边栏">
            <svg {...svgProps} width={18} height={18}>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* 来源单选：折叠样式同「排行」展开二级项 —— 标题行展开/收起，
          列表里当前来源恒为激活副项（收起时只留一行显示当前来源名）。
          点副项切换来源但不收起列表，方便连换几站对比 */}
      {sourceOptions.length > 1 && (
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
              {sourceOptions.map(s => (
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
        {mainTabs.map(t => {
          // 桌面端「搜索」点开的是悬浮搜索框（不跳页），所以唤起态也算选中
          const isActive = active === t.key || (t.key === 'search' && searchComposerOpen);
          const expandable = hasSubs(t.key);
          const open = expandable && subsVisible(t.key);
          const subs = open ? renderSubs(t.key) : null;
          // booru 来源没有 R18 变体，开关整个不出现
          const showR18 = t.key === 'ranking' && !isBooru;
          return (
            <div key={t.key}>
              {/* 行 + R18 开关 + 箭头三个独立热区：点文字切页签（现有语义不变），
                  点箭头只管展开/收起，点开关只拨 R18。
                  后两者不能塞进 .side-nav-item 里 —— button 套 button 是非法 HTML */}
              <div className={`side-nav-row${showR18 ? ' side-nav-row--r18' : ''}`}>
                <NavButton
                  icon={<svg {...svgProps}>{ICONS[t.key]}</svg>}
                  label={t.label}
                  active={isActive}
                  aria-current={active === t.key ? 'page' : undefined}
                  {...(t.key === 'search' ? { 'data-search-toggle': '' } : null)}
                  // 带二级项的行：点一下先原地展开（只想看看档位/子页签，不该被切走），
                  // 展开着再点才进页面（同时也是「点当前项 = 刷新」那条路）。
                  // 箭头任何时候都只管展开/收起。
                  onClick={expandable && !open
                    ? () => setSectionExpanded(t.key, true)
                    : act(() => (t.key === 'search' && onSearchNav ? onSearchNav() : onChange(t.key)))}
                />
                {showR18 && (
                  <R18Switch
                    on={rankingR18}
                    disabled={!canToggleR18(rankingCategory)}
                    onToggle={toggleRankingR18}
                  />
                )}
                {expandable && (
                  <button
                    className={`side-nav-chevron-btn${open ? ' open' : ''}`}
                    onClick={() => setSectionExpanded(t.key, !open)}
                    aria-expanded={open}
                    aria-label={`${open ? '收起' : '展开'}${t.label}`}
                  >
                    <svg
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
                )}
              </div>
              {subs && <div className="side-nav-subs">{subs}</div>}
            </div>
          );
        })}
      </div>

      <div className="side-nav-footer">
        {likedTab && (
          <NavButton
            icon={<svg {...svgProps}>{ICONS.liked}</svg>}
            label={likedTab.label}
            active={active === 'liked'}
            aria-current={active === 'liked' ? 'page' : undefined}
            onClick={act(() => onChange('liked'))}
          />
        )}
        <button className="side-nav-item" onClick={act(() => setDownloadOpen(true))}>
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
          onClick={act(onOpenSettings)}
        />
      </div>
    </nav>
  );
}
