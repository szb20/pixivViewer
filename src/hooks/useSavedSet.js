import { useEffect, useState } from 'react';
import { storageFacade } from '../pixiv-assistant/index.js';

/** 已保存到相册的作品集合（`${illustId}_${page}`） */
export default function useSavedSet() {
  const [saved, setSaved] = useState(() => new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await storageFacade.getAll();
        if (cancelled || !Array.isArray(all)) return;
        setSaved(new Set(
          all
            .filter(e => e?.isSaved)
            .map(e => `${e.illustId}_${e.pageIndex ?? 0}`)
        ));
      } catch { /* 忽略 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  return saved;
}
