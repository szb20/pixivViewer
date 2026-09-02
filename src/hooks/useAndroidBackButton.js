/**
 * useAndroidBackButton — 注册 Capacitor 安卓返回键。
 *
 * 优先级：已注册的返回处理器（灯箱/详情/弹窗等）→ WebView history 回退 → 退出 App。
 * 非原生平台（浏览器 dev）不注册。
 */
import { useEffect } from 'react';
import { runBackHandlers } from '../utils/backHandler.js';

export function useAndroidBackButton() {
    useEffect(() => {
        if (!window.Capacitor?.isNativePlatform?.()) return;
        let cancelled = false;
        let listener;
        (async () => {
            try {
                const { App } = await import('@capacitor/app');
                if (cancelled) return;
                listener = await App.addListener('backButton', (event) => {
                    try { event.preventDefault(); } catch { }
                    if (runBackHandlers()) return;
                    if (event.canGoBack) {
                        window.history.back();
                    } else {
                        App.exitApp();
                    }
                });
            } catch { /* 非原生环境 */ }
        })();
        return () => {
            cancelled = true;
            listener?.remove?.();
        };
    }, []);
}