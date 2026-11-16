import CookieField from './CookieField.jsx';

/** 微博子页：登录 Cookie（解锁翻页）+ UID 关注名单 */
export default function WeiboConfig({
  weiboUsers, setWeiboUsers,
  weiboCookie, setWeiboCookie,
  doSave,
}) {
  return (
    <div className="settings-group">
      <CookieField
        label="登录 Cookie（可选）"
        value={weiboCookie}
        onChange={setWeiboCookie}
        onBlur={() => doSave({ weiboCookie: weiboCookie.trim() })}
        placeholder="SUB=xxx; SUBP=xxx; ... （整段粘贴）"
        hint="登录 m.weibo.cn → F12 → Network → 任意请求 → 复制整段 Cookie 请求头。配置后解锁翻页（匿名只能看每列第 1 页）；找博主：搜索框输 @昵称，或从博主主页链接里的数字拿 UID"
      />

      <div className="settings-field">
        <div className="settings-field-label">关注名单</div>
        <textarea
          className="settings-textarea"
          value={weiboUsers}
          placeholder={'1192515960\nweibo.com/u/1195142852'}
          onChange={e => setWeiboUsers(e.target.value)}
          onBlur={() => doSave({ weiboUsers })}
        />
      </div>
    </div>
  );
}
