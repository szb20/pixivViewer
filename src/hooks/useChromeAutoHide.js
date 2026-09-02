/**
 * useChromeAutoHide — 监听主滚动容器，向下滚动隐藏底部 TabBar / 下拉把手，
 * 向上滚动或回到顶部时恢复。返回当前是否隐藏。
 *
 * @returns {[boolean]} [chromeHidden]
 */
import { useEffect, useState } from 'react';

export function useChromeAutoHide() {
    const [chromeHidden, setChromeHidden] = useState(false);

    useEffect(() => {
        const el = document.querySelector('.app-content');
        if (!el) return;
        let lastTop = el.scrollTop || 0;
        let ticking = false;
        const onScroll = () => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                const top = el.scrollTop || 0;
                const delta = top - lastTop;
                if (top < 24) {
                    setChromeHidden(false);
                } else if (Math.abs(delta) > 6) {
                    setChromeHidden(delta > 0);
                }
                lastTop = top;
                ticking = false;
            });
        };
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => el.removeEventListener('scroll', onScroll);
    }, []);

    return [chromeHidden];
}