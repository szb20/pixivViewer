/**
 * useChromeAutoHide — 监听滚动容器，向下滚动隐藏底部 TabBar + 系统状态栏，
 * 向上滚动或回到顶部时恢复。返回当前是否隐藏。
 *
 * 可选传入自定义滚动元素选择器（默认 '.app-content'），方便在详情页等复用。
 *
 * @param {string} [selector='.app-content']  滚动容器的 CSS 选择器
 * @returns {[boolean]} [chromeHidden]
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { StatusBar } from '@capacitor/status-bar';

export function useChromeAutoHide(selector = '.app-content') {
    // 初始值：挂载时读取滚动位置，避免刷新后状态错位
    const [chromeHidden, setChromeHidden] = useState(() => {
        if (typeof document === 'undefined') return false;
        const el = document.querySelector(selector);
        return el ? (el.scrollTop || 0) >= 24 : false;
    });
    const lastTopRef = useRef(0);

    const hideStatusBar = useCallback(() => {
        try { StatusBar.hide().catch(() => { }); } catch (_) { }
    }, []);

    const showStatusBar = useCallback(() => {
        try { StatusBar.show().catch(() => { }); } catch (_) { }
    }, []);

    useEffect(() => {
        const el = document.querySelector(selector);
        if (!el) return;
        lastTopRef.current = el.scrollTop || 0;
        // 初始同步：根据当前滚动位置设置状态栏
        if (lastTopRef.current >= 24) {
            hideStatusBar();
        } else {
            showStatusBar();
        }
        let ticking = false;

        const applyHidden = (hidden) => {
            setChromeHidden(hidden);
            if (hidden) hideStatusBar();
            else showStatusBar();
        };

        const onScroll = () => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                const top = el.scrollTop || 0;
                const delta = top - lastTopRef.current;
                if (top < 24) {
                    applyHidden(false);
                } else if (Math.abs(delta) > 6) {
                    applyHidden(delta > 0);
                }
                lastTopRef.current = top;
                ticking = false;
            });
        };

        el.addEventListener('scroll', onScroll, { passive: true });

        // 卸载时恢复状态栏（若当前处于隐藏状态）
        return () => {
            el.removeEventListener('scroll', onScroll);
            showStatusBar();
        };
    }, [selector, hideStatusBar, showStatusBar]);

    return [chromeHidden];
}