import CookieField from './CookieField.jsx';

/** Pixiv 子页：Cookie（排行 / 关注 / 收藏等账号功能依赖它） */
export default function PixivConfig({ cookie, setCookie, doSave }) {
  return (
    <div className="settings-group">
      <CookieField
        label="登录 Cookie（PHPSESSID）"
        value={cookie}
        onChange={setCookie}
        onBlur={() => doSave({ pixivCookie: cookie.trim() })}
        placeholder="12345678_a1b2c3d4..."
        hint="登录 pixiv.net → F12 → Application → Cookies → 复制 PHPSESSID 的值；排行 / 关注 / 收藏等账号功能依赖它"
      />
    </div>
  );
}
