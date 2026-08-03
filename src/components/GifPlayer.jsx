import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createLogger } from '../utils/logger.js';

const log = createLogger('GIF');

// 全局下载缓存：illustId → { promise, result, loading }
const downloadCache = new Map();
/** 播放器侧下载缓存上限 — 超限淘汰最旧条目并回收其帧 blob URL */
const MAX_DOWNLOAD_CACHE = 12;

/** 回收帧序列里的 blob URL（幂等，已回收的无副作用） */
function releaseFrames(frames) {
  if (!Array.isArray(frames)) return;
  for (const f of frames) {
    if (f?.path?.startsWith('blob:')) URL.revokeObjectURL(f.path);
  }
}

/** 写入下载缓存（带容量上限，淘汰时回收 blob URL） */
function cacheDownload(id, value) {
  if (downloadCache.has(id)) downloadCache.delete(id);
  downloadCache.set(id, value);
  if (downloadCache.size > MAX_DOWNLOAD_CACHE) {
    const oldestId = downloadCache.keys().next().value;
    const entry = downloadCache.get(oldestId);
    downloadCache.delete(oldestId);
    releaseFrames(entry?.result?.frames);
  }
}

/** 圆环进度条 — SVG 环形，白色描边，百分比驱动 */
function CircularProgress({ pct = 0, size = 56, stroke = 3 }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="rgba(255,255,255,0.2)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="rgba(255,255,255,0.85)" strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 0.3s ease' }} />
      <text x="50%" y="50%" textAnchor="middle" dy="0.35em"
        fill="rgba(255,255,255,0.85)" fontSize={size * 0.22}
        style={{ transform: 'rotate(90deg)', transformOrigin: 'center' }}>
        {Math.round(pct)}%
      </text>
    </svg>
  );
}

/**
 * GIF 动图播放器 — Canvas 逐帧动画。
 * 默认显示首帧静态图；点击后播放动画（循环）。
 */
export default function GifPlayer({
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
  src,
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const imagesRef = useRef([]);
  const frameIdxRef = useRef(0);
  const timerRef = useRef(null);
  const loadedRef = useRef(false);
  const mountedRef = useRef(true);
  const lastToggleRef = useRef(0);
  const touchStartRef = useRef({ x: 0, y: 0 });
  const preloadRetriedRef = useRef(false); // 帧加载失败自动重拉一次，避免死循环

  const [frames, setFrames] = useState(initialFrames);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [progress, setProgress] = useState(0);
  const [loadProgress, setLoadProgress] = useState(0);
  const [error, setError] = useState(null);
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

  // 切换作品时重置预加载重试标记
  useEffect(() => {
    preloadRetriedRef.current = false;
  }, [illustId]);

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
  }, [compact, needsFetch]); // eslint-disable-line react-hooks/exhaustive-deps -- loadFrames 定义在后，靠 autoLoadRef 守卫

  // 懒加载：点击时下载完整 GIF 帧（支持后台下载不中断）
  const loadFrames = async (retry = false) => {
    if (loading || loaded) return;

    // 重试时清除失败缓存
    if (retry) downloadCache.delete(illustId);

    // 已有缓存结果 → 直接恢复，不显示加载态
    const cached = downloadCache.get(illustId);
    if (cached?.result) {
      if (cached.result.frames?.length) {
        restoringRef.current = true;
        loadedRef.current = false;
        setFrames(cached.result.frames);
        setLoadProgress(100);
        setError(null);
        return;
      }
      // 缓存了错误结果 → 清除并重试
      if (cached.result.error) {
        downloadCache.delete(illustId);
      }
    }

    // 已有进行中的下载 → 等它完成
    if (cached?.promise) {
      setLoading(true);
      setError(null);
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
    setError(null);

    const promise = (async () => {
      const result = await window.api.fetchGif(illustId, (pct) => {
        if (mountedRef.current) setLoadProgress(pct);
      }, retry ? { force: true } : undefined);
      cacheDownload(illustId, { result });
      return result;
    })();

    cacheDownload(illustId, { promise });

    try {
      const result = await promise;
      if (result.frames?.length) {
        loadedRef.current = false;
        if (mountedRef.current) {
          setFrames(result.frames);
          setError(null);
        }
      } else {
        // 有 result 但没有 frames → 设置错误信息
        const errMsg = result?.error || '未知错误';
        log.warn('加载失败:', errMsg);
        if (mountedRef.current) setError(errMsg);
      }
    } catch (e) {
      log.warn('加载失败:', e.message);
      if (mountedRef.current) setError(e.message);
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
    let failedCount = 0;

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
          // 有帧加载失败：可能是缓存里的 blob URL 已被回收 → 自动重拉一次
          if (failedCount > 0 && !preloadRetriedRef.current) {
            preloadRetriedRef.current = true;
            loadFrames(true);
            return;
          }
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
        failedCount++;
        if (loadedCount >= frames.length) {
          // 有帧加载失败：可能是缓存里的 blob URL 已被回收 → 自动重拉一次
          if (failedCount > 0 && !preloadRetriedRef.current) {
            preloadRetriedRef.current = true;
            loadFrames(true);
            return;
          }
          requestAnimationFrame(() => setLoaded(true));
        }
      };
    });

    return () => { cancelled = true; };
  }, [frames, illustId]); // eslint-disable-line react-hooks/exhaustive-deps -- playFrame 定义在后，frames 变化时自动重建

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

  // 暂停/继续播放（保留当前帧），300ms 防抖避免 touch+click 双击穿
  const togglePlay = useCallback((e) => {
    if (e) { e.stopPropagation(); }
    if (!loaded) return;
    const now = Date.now();
    if (now - lastToggleRef.current < 300) return;
    lastToggleRef.current = now;

    setPlaying(prev => {
      const next = !prev;
      if (next) {
        lastFrameTimeRef.current = null;
        timerRef.current = requestAnimationFrame(playFrame);
      } else {
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
  }, [illustId, frames]);

  const hasValidSize = canvasSize.width > 0 && canvasSize.height > 0;
  const maxW = maxWidthProp ?? (compact ? 240 : window.innerWidth);
  const displayWidth = hasValidSize ? Math.min(canvasSize.width, maxW) : maxW;
  const displayHeight = hasValidSize
    ? Math.round(displayWidth * (canvasSize.height / canvasSize.width))
    : Math.round(displayWidth * 0.75);

  // 已有 blob URL（网格已加载）→ 直接用原生 <img> 播放，无需 Canvas 重载
  if (src && src.startsWith('blob:')) {
    return (
      <div className={`gif-player native ${className}`} style={{ width: displayWidth, maxWidth: '100%', ...style }}>
        <img src={src} alt={title || 'GIF'} style={{ width: '100%', maxHeight: '75vh', objectFit: 'contain' }} />
        {!compact && (
          <div className="gif-info">
            <span className="gif-title">{title || 'GIF 动图'}</span>
            {author && <span className="gif-author">@{author}</span>}
            {pixivUrl && <a className="gif-pixiv-link" href={pixivUrl} target="_blank" onClick={e => e.stopPropagation()}>Pixiv →</a>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`gif-player ${playing ? 'playing' : ''} ${loaded ? 'loaded' : 'loading'} ${compact ? 'compact' : ''} ${className}`}
      style={{ width: displayWidth, maxWidth: '100%', ...style }}
      onClick={(e) => {
        e.stopPropagation();
        if (loaded) togglePlay(e); else loadFrames();
      }}
      onTouchStart={(e) => { const t = e.touches[0]; touchStartRef.current = { x: t.clientX, y: t.clientY }; }}
      onTouchEnd={(e) => {
        const t = e.changedTouches[0];
        const dx = Math.abs(t.clientX - touchStartRef.current.x);
        const dy = Math.abs(t.clientY - touchStartRef.current.y);
        // 只有轻点（移动<10px）才响应，swipe 不拦截
        if (dx < 10 && dy < 10) {
          e.stopPropagation();
          if (loaded) togglePlay(e); else loadFrames();
        }
      }}
    >
      <div className="gif-canvas-wrap" style={{ width: displayWidth, height: displayHeight }}>
        {/* 缩略图兜底：帧加载完成前始终显示卡片同款缩略图 */}
        {thumbnailUrl && !loaded && (
          <img src={thumbnailUrl} alt="" className="gif-thumb-fallback"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
        <canvas
          ref={canvasRef}
          width={canvasSize.width || displayWidth}
          height={canvasSize.height || displayHeight}
          style={{ width: displayWidth, height: displayHeight }}
          className="gif-canvas"
        />

        {/* 播放按钮覆盖层（缓存恢复中隐藏） */}
        {!restoringRef.current && !playing && !loading && (
          <div className="gif-play-overlay">
            <span className="gif-play-icon">▶</span>
          </div>
        )}

        {/* 加载中指示器 — 圆环进度条 */}
        {!restoringRef.current && (loading || (!loaded && totalFrames > 0 && !needsFetch)) && (
          <div className="gif-loading-overlay">
            <CircularProgress pct={Math.max(0, loadProgress)} />
          </div>
        )}

        {/* 播放时的轻量进度条 */}
        {playing && (
          <div className="gif-progress-bar">
            <div className="gif-progress-fill" style={{ width: `${progress}%` }} />
          </div>
        )}

        {/* 错误提示 + 重试 */}
        {error && !loading && (
          <div className="gif-loading-overlay" style={{ flexDirection: 'column', gap: 8, cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); loadFrames(true); }}>
            <span style={{ fontSize: 32 }}>⚠️</span>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', textAlign: 'center', padding: '0 12px', lineHeight: 1.4 }}>{error}</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>点击重试</span>
          </div>
        )}

      </div>

      {/* 信息栏（非紧凑模式） */}
      {!compact && (
        <div className="gif-info">
          <span className="gif-title">{title || 'GIF 动图'}</span>
          {author && <span className="gif-author">@{author}</span>}
          {pixivUrl && (
            <a className="gif-pixiv-link" href={pixivUrl} target="_blank"
              onClick={e => e.stopPropagation()}>
              Pixiv →
            </a>
          )}
        </div>
      )}
    </div>
  );
}
