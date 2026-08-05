import { useState } from 'react';
import { checkProxyReachable } from '../utils/proxyCheck.js';

/**
 * 代理连接失败弹窗。
 *
 * 启动时代理不可达时弹出模态遮罩，引导用户检查代理设置或重试。
 *
 * Props:
 *   proxyUrl          — 当前代理地址（展示用）
 *   onOpenSettings    — 点击「去设置」回调
 *   onDismiss         — 探测成功后关闭弹窗的回调
 */
export default function ProxyCheckNotice({ proxyUrl, onOpenSettings, onDismiss }) {
  const [checking, setChecking] = useState(false);

  const handleRetry = async () => {
    setChecking(true);
    try {
      const { reachable } = await checkProxyReachable(3000);
      if (reachable) {
        onDismiss();
      }
    } finally {
      setChecking(false);
    }
  };

  const handleGoSettings = () => {
    onDismiss();       // 先关掉自己
    onOpenSettings();  // 再打开设置弹窗
  };

  return (
    <div className="proxy-check-overlay">
      <div className="proxy-check-card frosted">
        <div className="proxy-check-icon">⚠️</div>
        <h3 className="proxy-check-title">代理连接失败</h3>
        <p className="proxy-check-url">{proxyUrl || 'http://127.0.0.1:7890'}</p>
        <p className="proxy-check-hint">
          无法连接到代理服务器，请检查 Clash 或其他代理是否运行，或在设置中修改代理地址。
        </p>
        <div className="proxy-check-actions">
          <button
            className="proxy-check-btn proxy-check-btn-secondary"
            onClick={handleGoSettings}
          >
            去设置
          </button>
          <button
            className="proxy-check-btn proxy-check-btn-primary"
            onClick={handleRetry}
            disabled={checking}
          >
            {checking ? '检查中...' : '重试'}
          </button>
        </div>
      </div>
    </div>
  );
}
