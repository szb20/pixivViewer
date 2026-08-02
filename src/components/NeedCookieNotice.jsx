/** 需要 Cookie 时的引导条 — 点击"去设置"打开设置弹窗 */
export default function NeedCookieNotice({ onOpenSettings }) {
  return (
    <div className="cookie-notice">
      <span>该功能需要 Pixiv Cookie（PHPSESSID）</span>
      <button onClick={onOpenSettings}>去设置</button>
    </div>
  );
}
