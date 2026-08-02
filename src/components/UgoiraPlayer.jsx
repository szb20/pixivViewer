import React, { useState, useRef, useEffect, useCallback } from 'react';

// 全局下载缓存：illustId → { promise, result, loading }
const downloadCache = new Map();

/**
 * Ugoira 动图播放器 — Canvas 逐帧动画。
 * 默认显示首帧静态图；点击后播放动画（循环）。
 */
export default function UgoiraPlayer({
  frames: initialFrames,
  title,
  author,
  illustId,
  pixivUrl,
  className = '',
  style,
  compact = false,
  onTogglePlay,
  _lazy = false,
  maxWidth: maxWidthProp,
  thumbnailUrl = '',
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const imagesRef = useRef([]);
  const frameIdxRef = useRef(0);
  const timerRef = useRef(null);
  const loadedRef = useRef(false);
  const mountedRef = useRef(true);

  const [frames, setFrames] = useState(initialFrames);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [progress, setProgress] = useState(0);
  const [loadProgress, setLoadProgress] = useState(0);
  const restoringRef = useRef(false); // 缓存恢复中，跳过加载态
  const autoLoadRef = useRef(false);   // 防止重复自动加载
  const startTimeRef = useRef(null);   // rAF 播放起始时间
  const lastFrameTimeRef = useRef(null); // 上一帧切换的时间戳

  const totalFrames = frames?.length || 0;
  const needsFetch = _lazy && totalFrames === 0;

  // 卸载标记
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 挂载时检查缓存：直接恢复帧，跳过 loading 态
  useEffect(() => {
    const cached = downloadCache.get(illustId);
    if (cached?.result?.frames?.length && !loadedRef.current) {
      restoringRef.current = true;
      loadedRef.current = false;
      setFrames(cached.result.frames);
      setLoadProgress(100);
    }
  }, [illustId]);

  // 灯箱模式：已缓存则自动加载播放，无需手动点击
  useEffect(() => {
    if (!compact && needsFetch && !autoLoadRef.current) {
      autoLoadRef.current = true;
      loadFrames();
    }
  }, [compact, needsFetch]);

  // 懒加载：点击时下载完整 Ugoira 帧（支持后台下载不中断）
  const loadFrames = async () => {
    if (loading || loaded) return;

    // 已有缓存结果 → 直接恢复，不显示加载态
    const cached = downloadCache.get(illustId);
    if (cached?.result) {
      if (cached.result.frames?.length) {
        restoringRef.current = true;
        loadedRef.current = false;
        setFrames(cached.result.frames);
        setLoadProgress(100);
      }
      return;
    }

    // 已有进行中的下载 → 等它完成
    if (cached?.promise) {
      setLoading(true);
      try { await cached.promise; } catch {}
      if (mountedRef.current) setLoading(false);
      const updated = downloadCache.get(illustId);
      if (updated?.result?.frames?.length) {
        restoringRef.current = true;
        loadedRef.current = false;
        if (mountedRef.current) {
          setFrames(updated.result.frames);
          setLoadProgress(100);
        }
      }
      return;
    }

    setLoading(true);
    setLoadProgress(0);

    const promise = (async () => {
      const result = await window.api.fetchUgoira(illustId, (pct) => {
        if (mountedRef.current) setLoadProgress(pct);
      });
      downloadCache.set(illustId, { result });
      return result;
    })();

    downloadCache.set(illustId, { promise });

    try {
      const result = await promise;
      if (result.frames?.length) {
        loadedRef.current = false;
        if (mountedRef.current) {
          setFrames(result.frames);
        }
      }
    } catch (e) {
      console.warn('[Ugoira] 加载失败:', e.message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  // 预加载所有帧
  useEffect(() => {
    if (!frames || frames.length === 0) return;
    if (loadedRef.current) return;

    let cancelled = false;
    const images = [];
    let loadedCount = 0;

    frames.forEach((frame, i) => {
      const img = new Image();
      img.src = frame.path;
      img.onload = () => {
        if (cancelled) return;
        loadedCount++;
        images[i] = img;
        if (loadedCount === 1) {
          // 首帧加载完成 → 设置 canvas 尺寸并立即渲染
          setCanvasSize({
            width: img.naturalWidth,
            height: img.naturalHeight,
          });
          if (canvasRef.current) {
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          }
        }
        if (loadedCount >= frames.length) {
          imagesRef.current = images;
          loadedRef.current = true;
          restoringRef.current = false;
          setLoaded(true);
          // 自动播放
          frameIdxRef.current = 0;
          startTimeRef.current = null;
          lastFrameTimeRef.current = null;
          lastProgressRef.current = 0;
          setProgress(0);
          setPlaying(true);
          timerRef.current = requestAnimationFrame(playFrame);
        }
      };
      img.onerror = () => {
        if (cancelled) return;
        loadedCount++;
        if (loadedCount >= frames.length) {
          requestAnimationFrame(() => setLoaded(true));
        }
      };
    });

    return () => { cancelled = true; };
  }, [frames, illustId]);

  // 播放动画 — 用 rAF + 累计时间驱动，比 setTimeout 更流畅
  const lastProgressRef = useRef(0);
  const playFrame = useCallback((timestamp) => {
    if (!canvasRef.current) return;
    if (!startTimeRef.current) startTimeRef.current = timestamp;
    if (!lastFrameTimeRef.current) lastFrameTimeRef.current = timestamp;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const images = imagesRef.current;
    const frameCount = frames.length;

    const currentIdx = frameIdxRef.current;
    const frame = frames[currentIdx];
    const img = images[currentIdx];

    // 用 elapsed 替代 setTimeout: 当前帧已经显示够 delay 时间了吗？
    const elapsed = timestamp - lastFrameTimeRef.current;
    if (elapsed >= (frame.delay || 80)) {
      // 推进到下一帧
      lastFrameTimeRef.current = timestamp;

      if (img && img.complete) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }

      frameIdxRef.current = (currentIdx + 1) % frameCount;

      // 进度条降低更新频率（~200ms 一次），减少无意义的 React 重渲染
      if (timestamp - lastProgressRef.current > 200) {
        lastProgressRef.current = timestamp;
        setProgress(Math.round(((currentIdx + 1) / frameCount) * 100));
      }
    }

    timerRef.current = requestAnimationFrame(playFrame);
  }, [frames]);

  // 暂停/继续播放（保留当前帧）
  const togglePlay = useCallback((e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!loaded) return;

    setPlaying(prev => {
      const next = !prev;
      if (next) {
        /* 继续播放：调整时间戳避免帧跳跃 */
        lastFrameTimeRef.current = null;
        timerRef.current = requestAnimationFrame(playFrame);
      } else {
        /* 暂停：停 rAF，保留当前帧 */
        cancelAnimationFrame(timerRef.current);
      }
      onTogglePlay?.(next);
      return next;
    });
  }, [loaded, playFrame, onTogglePlay]);

  // 组件卸载时清理
  useEffect(() => {
    return () => cancelAnimationFrame(timerRef.current);
  }, []);

  // 首帧渲染（frames 变化时重置）
  useEffect(() => {
    if (!loadedRef.current && frames?.length > 0) {
      // preload useEffect 会处理
      return;
    }
    // 重置
    frameIdxRef.current = 0;
    cancelAnimationFrame(timerRef.current);
    setPlaying(false);
    setProgress(0);

    // 重渲染首帧
    if (canvasRef.current && imagesRef.current[0]?.complete) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(imagesRef.current[0], 0, 0, canvas.width, canvas.height);
    }
  }, [illustId]);

  const hasValidSize = canvasSize.width > 0 && canvasSize.height > 0;
  const maxW = maxWidthProp ?? (compact ? 240 : window.innerWidth);
  const displayWidth = hasValidSize ? Math.min(canvasSize.width, maxW) : maxW;
  const displayHeight = hasValidSize
    ? Math.round(displayWidth * (canvasSize.height / canvasSize.width))
    : Math.round(displayWidth * 0.75);

  return (
    <div
      ref={containerRef}
      className={`ugoira-player ${playing ? 'playing' : ''} ${loaded ? 'loaded' : 'loading'} ${compact ? 'compact' : ''} ${className}`}
      style={{ width: displayWidth, maxWidth: '100%', ...style }}
      onClick={loaded ? togglePlay : loadFrames}
    >
      <div className="ugoira-canvas-wrap" style={{ width: displayWidth, height: displayHeight }}>
        {/* 缩略图兜底：帧加载完成前始终显示卡片同款缩略图 */}
        {thumbnailUrl && !loaded && (
          <img src={thumbnailUrl} alt="" className="ugoira-thumb-fallback"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
        <canvas
          ref={canvasRef}
          width={canvasSize.width || displayWidth}
          height={canvasSize.height || displayHeight}
          style={{ width: displayWidth, height: displayHeight }}
          className="ugoira-canvas"
        />

        {/* 播放按钮覆盖层（缓存恢复中隐藏） */}
        {!restoringRef.current && !playing && !loading && (
          <div className="ugoira-play-overlay">
            <span className="ugoira-play-icon">▶</span>
          </div>
        )}

        {/* 加载中指示器（缓存恢复时跳过） */}
        {!restoringRef.current && (loading || (!loaded && totalFrames > 0 && !needsFetch)) && (
          <div className="ugoira-loading-overlay">
            <span className="ugoira-loading-spinner" />
            <div className="ugoira-progress-bar ugoira-progress-bar--loading">
              <div className="ugoira-progress-fill" style={{ width: `${Math.max(0, loadProgress)}%`, transition: 'width 0.15s ease' }} />
            </div>
          </div>
        )}

        {/* 进度条（播放时） */}
        {playing && (
          <div className="ugoira-progress-bar">
            <div className="ugoira-progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}

        {/* 暂停指示 */}
        {playing && (
          <div className="ugoira-pause-hint">⏸ 点击暂停</div>
        )}
      </div>

      {/* 信息栏（非紧凑模式） */}
      {!compact && (
        <div className="ugoira-info">
          <span className="ugoira-title">{title || 'Ugoira 动图'}</span>
          {author && <span className="ugoira-author">@{author}</span>}
          {pixivUrl && (
            <a className="ugoira-pixiv-link" href={pixivUrl} target="_blank"
              onClick={e => e.stopPropagation()}>
              Pixiv →
            </a>
          )}
        </div>
      )}
    </div>
  );
}
