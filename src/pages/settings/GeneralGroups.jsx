import { SOURCE_LIST } from '../../sources/registry.js';
import { getToggleableTabs } from '../../hooks/useVisibleTabs.js';
import { getToggleableGridBadges } from '../../hooks/useGridBadges.js';
import { Pill, PillWall } from './PillGroup.jsx';

const THEME_OPTIONS = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

const LAYOUT_OPTIONS = [
  { value: 'waterfall', label: '瀑布流' },
  { value: 'grid', label: '方形宫格' },
];

/**
 * 主页通用分组：外观 / 页面 / 来源 / 网络 / 保存（桌面壳才有保存组）。
 * 全部受控组件 —— 状态与 doSave 都在 SettingsPage 壳里；
 * 来源 / 页面 / 标记 / 分级开关走各自单例（立即广播 + 自行持久化）。
 */
export default function GeneralGroups({
  // 外观
  themeMode, onThemeChange,
  gridLayout, onGridLayoutChange,
  hiddenGridBadges, onGridBadgeToggle,
  // 页面
  hiddenTabKeys, onTabToggle,
  // 来源
  visibleSourceIds, onSourceToggle, safeOnly, onSafeOnlyChange,
  // 网络
  proxyUrl, onProxyChange,
  // 备份（安卓原生壳）
  backupAvailable, allFilesAccess, onRequestAllFilesAccess, onBackupNow, onRestoreBackup,
  // 保存（仅桌面壳）
  isDesktop, saveDirectory, onChooseDir, onResetDir, askEachTime, onAskEachTimeChange,
}) {
  const hiddenSources = SOURCE_LIST.filter(s => !visibleSourceIds.includes(s.id)).map(s => s.id);

  return (
    <>
      {/* ── 外观：视觉类合并 ── */}
      <div className="settings-group">
        <div className="settings-group-label">外观</div>
        <div className="settings-row">
          <div className="settings-row-label">主题</div>
          <div className="settings-pill-group">
            {THEME_OPTIONS.map(opt => (
              <Pill key={opt.value} active={themeMode === opt.value} onClick={() => onThemeChange(opt.value)}>
                {opt.label}
              </Pill>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">网格样式</div>
          <div className="settings-pill-group">
            {LAYOUT_OPTIONS.map(opt => (
              <Pill key={opt.value} active={gridLayout === opt.value} onClick={() => onGridLayoutChange(opt.value)}>
                {opt.label}
              </Pill>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">卡片标记</div>
        </div>
        <PillWall
          items={getToggleableGridBadges()}
          hidden={hiddenGridBadges}
          onToggle={onGridBadgeToggle}
        />
      </div>

      {/* ── 页面 ── */}
      <div className="settings-group">
        <div className="settings-group-label">页面</div>
        <div className="settings-row">
          <div className="settings-row-label">显示的页面</div>
        </div>
        <PillWall
          items={getToggleableTabs()}
          hidden={hiddenTabKeys}
          onToggle={onTabToggle}
        />
      </div>

      {/* ── 来源 ── */}
      <div className="settings-group">
        <div className="settings-group-label">来源</div>
        <div className="settings-row">
          <div className="settings-row-label">显示的来源</div>
        </div>
        <PillWall
          items={SOURCE_LIST.map(s => ({ key: s.id, label: s.shortLabel || s.label }))}
          hidden={hiddenSources}
          onToggle={onSourceToggle}
        />
        <div className="settings-row">
          <div>
            <div className="settings-row-label">分级过滤</div>
            <div className="settings-row-hint">仅图库类来源生效</div>
          </div>
          <div className="settings-pill-group">
            <Pill active={!safeOnly} onClick={() => onSafeOnlyChange(false)}>全部</Pill>
            <Pill active={safeOnly} onClick={() => onSafeOnlyChange(true)}>仅安全</Pill>
          </div>
        </div>
      </div>

      {/* ── 网络 ── */}
      <div className="settings-group">
        <div className="settings-group-label">网络</div>
        <div className="settings-field">
          <div className="settings-field-label">代理地址</div>
          <input
            className="settings-input"
            type="text"
            value={proxyUrl}
            placeholder="http://127.0.0.1:7890"
            onChange={e => onProxyChange(e.target.value)}
          />
        </div>
      </div>

      {/* ── 备份：仅安卓原生壳 ── */}
      {backupAvailable && (
        <div className="settings-group">
          <div className="settings-group-label">备份</div>
          <div className="settings-row">
            <div style={{ minWidth: 0 }}>
              <div className="settings-row-label">所有文件访问</div>
              <div className="settings-row-hint">
                {allFilesAccess
                  ? '已开启 — 备份自动写入 Download/Prism/pixiv_meta.json'
                  : '开启后备份自动写入 Download/Prism（纯 JSON，不再进相册）；重装后重开一次即可恢复'}
              </div>
            </div>
            <div className="settings-pill-group">
              <button className="settings-pill" onClick={onRequestAllFilesAccess}>
                {allFilesAccess ? '查看' : '去开启'}
              </button>
            </div>
          </div>
          <div className="settings-row">
            <div style={{ minWidth: 0 }}>
              <div className="settings-row-label">立即备份</div>
              <div className="settings-row-hint">把当前 喜欢/已保存 记录写一份到备份位置</div>
            </div>
            <div className="settings-pill-group">
              <button className="settings-pill" onClick={onBackupNow}>备份</button>
            </div>
          </div>
          <div className="settings-row">
            <div style={{ minWidth: 0 }}>
              <div className="settings-row-label">从备份恢复</div>
              <div className="settings-row-hint">重装后先重开「所有文件访问」，再点恢复</div>
            </div>
            <div className="settings-pill-group">
              <button className="settings-pill" onClick={onRestoreBackup}>恢复</button>
            </div>
          </div>
        </div>
      )}

      {/* ── 保存：仅桌面壳 ── */}
      {isDesktop && (
        <div className="settings-group">
          <div className="settings-group-label">保存</div>
          <div className="settings-row">
            <div style={{ minWidth: 0 }}>
              <div className="settings-row-label">图片保存目录</div>
              <div className="settings-row-hint" style={{ wordBreak: 'break-all' }}>{saveDirectory || '系统「图片」文件夹'}</div>
            </div>
            <div className="settings-pill-group">
              <button className="settings-pill" onClick={onChooseDir}>选择文件夹</button>
              {saveDirectory && (
                <button className="settings-pill" onClick={onResetDir}>恢复默认</button>
              )}
            </div>
          </div>
          <div className="settings-row">
            <div style={{ minWidth: 0 }}>
              <div className="settings-row-label">保存方式</div>
              <div className="settings-row-hint">
                {!saveDirectory
                  ? '未指定目录，保存时会弹「另存为」'
                  : (askEachTime ? '每次保存都弹「另存为」' : '直接存进上面的目录，不再打断')}
              </div>
            </div>
            <div className="settings-pill-group">
              <Pill active={!askEachTime} onClick={() => onAskEachTimeChange(false)}>直接保存</Pill>
              <Pill active={askEachTime} onClick={() => onAskEachTimeChange(true)}>每次询问</Pill>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
