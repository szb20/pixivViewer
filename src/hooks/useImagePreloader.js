import { useEffect, useRef } from 'react';
const preloaded = new Set();
const MAX_CACHE = 200;

function preloadImage(url) {
  if (!url || preloaded.has(url)) return;
  if (preloaded.size >= MAX_CACHE) {
    const first = preloaded.keys().next().value;
    if (first) preloaded.delete(first);
  }
  const img = new Image();
  img.src = url;
  preloaded.add(url);
}

export function useImagePreloader(urls, options = {}) {
  const { enabled = true, priority = 'low' } = options;
  const loadedRef = useRef(new Set());

  useEffect(() => {
    if (!enabled || !urls?.length) return;

    const toLoad = urls.filter(u => u && !loadedRef.current.has(u));
    if (toLoad.length === 0) return;

    if (priority === 'low' && 'requestIdleCallback' in window) {
      requestIdleCallback(() => {
        toLoad.forEach((url, i) => {
          setTimeout(() => preloadImage(url), i * 50);
        });
      }, { timeout: 2000 });
    } else {
      toLoad.forEach((url, i) => {
        setTimeout(() => preloadImage(url), i * 50);
      });
    }

    toLoad.forEach(u => loadedRef.current.add(u));
  }, [urls, enabled, priority]);
}

export function preloadImages(urls) {
  urls?.forEach((url, i) => {
    setTimeout(() => preloadImage(url), i * 30);
  });
}