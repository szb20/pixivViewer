import { SOURCES } from '../../sources/registry.js';

/** 有专属配置（Cookie / 名单）的来源；booru 类无配置项，不进墙避免空点击 */
const CONFIGURABLE = ['pixiv', 'twitter', 'weibo', 'instagram'];

/** 图源配置入口：点击胶囊进入该来源的二级子页（不依赖全局当前来源） */
export default function SourceConfigPicker({ onOpen }) {
  return (
    <div className="settings-group">
      <div className="settings-group-label">图源配置</div>
      <div className="settings-pill-group settings-pill-group--wrap">
        {CONFIGURABLE.map(id => (
          <button
            key={id}
            type="button"
            className="settings-pill settings-entry-pill"
            onClick={() => onOpen(id)}
          >
            {SOURCES[id].label}
            <span className="settings-entry-chevron">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
