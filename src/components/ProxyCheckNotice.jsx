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
    <div className="dialog-overlay" data-variant="card">
      <div className="dialog-panel">
        <div className="proxy-check-icon" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="64" height="64">
            <defs>
              <linearGradient id="proxyWarnGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="rgba(255, 255, 255, 0.92)" />
                <stop offset="100%" stopColor="rgba(255, 255, 255, 0.46)" />
              </linearGradient>
            </defs>
            <circle
              cx="32"
              cy="32"
              r="29"
              fill="rgba(255, 255, 255, 0.06)"
              stroke="rgba(255, 255, 255, 0.12)"
              strokeWidth="1.5"
            />
            <circle
              cx="32"
              cy="32"
              r="25"
              fill="none"
              stroke="url(#proxyWarnGrad)"
              strokeOpacity="0.45"
              strokeWidth="1.5"
              strokeDasharray="3 6"
              strokeLinecap="round"
            />
            <path
              d="M32 20 L45 44 H19 Z"
              fill="rgba(255, 255, 255, 0.08)"
              stroke="url(#proxyWarnGrad)"
              strokeWidth="3"
              strokeLinejoin="round"
            />
            <line
              x1="32"
              y1="28.5"
              x2="32"
              y2="37"
              stroke="url(#proxyWarnGrad)"
              strokeWidth="3.5"
              strokeLinecap="round"
            />
            <circle cx="32" cy="42" r="2.4" fill="url(#proxyWarnGrad)" />
          </svg>
        </div>
        <h3 className="proxy-check-title">代理连接失败</h3>
        <p className="proxy-check-url">{proxyUrl || 'http://127.0.0.1:7890'}</p>
        <p className="proxy-check-hint">
          无法连接到代理服务器，请检查 Clash 或其他代理是否运行，或在设置中修改代理地址。
        </p>
        <div className="proxy-check-actions">
          <button
            className="btn"
            onClick={handleGoSettings}
          >
            去设置
          </button>
          <button
            className="btn btn-primary"
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
