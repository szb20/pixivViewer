import CookieField from './CookieField.jsx';

/** Instagram 子页：登录 Cookie（无匿名通道，必填）+ 用户名关注名单（主页流失败时的兜底） */
export default function InstagramConfig({
  instagramUsers, setInstagramUsers,
  instagramCookie, setInstagramCookie,
  doSave,
}) {
  return (
    <div className="settings-group">
      <CookieField
        label="登录 Cookie（必填）"
        value={instagramCookie}
        onChange={setInstagramCookie}
        onBlur={() => doSave({ instagramCookie: instagramCookie.trim() })}
        placeholder="sessionid=xxx; ds_user_id=123; ... （整段粘贴）"
        hint="登录 www.instagram.com → F12 → Network → 任意请求 → 复制整段 Cookie 请求头（须含 sessionid 与 ds_user_id）。配好后「推荐」直接显示你账号的真实主页时间线。手机须开 VPN 才能加载；请求过快会被限流约 10 分钟，等一会儿再刷新"
      />

      <div className="settings-field">
        <div className="settings-field-label">关注名单（备用）</div>
        <textarea
          className="settings-textarea"
          value={instagramUsers}
          placeholder={'natgeo\ninstagram.com/instagram'}
          onChange={e => setInstagramUsers(e.target.value)}
          onBlur={() => doSave({ instagramUsers })}
        />
        <div className="settings-expand-hint">
          主页时间线失败或为空时改用这份名单合并流；搜索页查博主也用它补历史
        </div>
      </div>
    </div>
  );
}
