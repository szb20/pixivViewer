/**
 * FrameAnimPlayer — 逐帧动画播放器（GifPlayer / UgoiraPlayer 的共享实现）。
 *
 * 原 GifPlayer 与 UgoiraPlayer 是两个几乎相同的 Canvas 逐帧播放器（各 ~400 行），
 * 差异点通过 props 参数化，两者变成薄包装：
 *
 * 差异开关（由包装传入）：
 *   progressBar      'bar' | 'circle'  → 线性进度条 / 环形进度
 *   stallTimeout     GIF 下载停滞超时（毫秒），0 关闭（Ugoira 无停滞检测）
 *   debounceToggle   300ms 防抖（避免 GIF touch+click 双击触发）
 *   handleTouch      轻点 tap 判定（仅 GIF）
 *   pauseHint        播放时显示"点击暂停"提示（仅 Ugoira）
 *   capByMaxHeight   按 maxHeight 约束高度（仅 GIF）
 *   capWidthByCanvas 宽度不超过首帧尺寸（仅 Ugoira）
 *   clearCacheOnError 加载失败后清除下载缓存（仅 Ugoira）
 *   cssPrefix        'gif' | 'ugoira' → 类名前缀
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createLogger } from '../utils/logger.js';
import { fetchUgoiraFrames, getCachedFrames, clearFrameCache } from '../api/gif.js';

const log = createLogger('FrameAnimPlayer');

/** 环形进度条 —— SVG 圆形，白色描边，百分比驱动 */
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
 * 逐帧动画播放器 —— Canvas 逐帧动图。
 * 默认显示首帧静态图；点击后播放动画（循环）。
 */
export default function FrameAnimPlayer({
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
  maxHeight: maxHeightProp,
  thumbnailUrl = '',
  src,
  width: widthProp = 0,
  height: heightProp = 0,
  hideLink = false,
  hideInfo = false,
  clickable = true,
  // 差异开关
  progressBar = 'bar',
  stallTimeout = 0,
  debounceToggle = false,
  handleTouch = false,
  pauseHint = true,
  capByMaxHeight = false,
  capWidthByCanvas = true,
  clearCacheOnError = true,
  cssPrefix = 'ugoira',
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
  const startTimeRef = useRef(null);   // rAF 播放开始时间
  const lastFrameTimeRef = useRef(null); // 上一帧切换的时间戳
  const lastProgressRef = useRef(0);

  const totalFrames = frames?.length || 0;
  const needsFetch = _lazy && totalFrames === 0;

  // 卸载标记
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 切换作品时重置状态（仅依赖 illustId：
  // GifPlayer 在 MediaLightbox 里每次渲染都收到新的 frames=[] 引用，不能把 initialFrames 纳入依赖）
  useEffect(() => {
    loadedRef.current = false;
    autoLoadRef.current = false;
    restoringRef.current = false;
    preloadRetriedRef.current = false;
    setFrames(initialFrames);
    setLoaded(false);
    setPlaying(false);
    setLoadProgress(0);
    setError(null);
    cancelAnimationFrame(timerRef.current);
  }, [illustId]); // oxlint-disable-line react-hooks/exhaustive-deps

  // 挂载时检查共享帧缓存：直接恢复帧，跳过 loading 态
  useEffect(() => {
    const cached = getCachedFrames(illustId);
    if (cached?.frames?.length && !loadedRef.current) {
      restoringRef.current = true;
      loadedRef.current = false;
      setFrames(cached.frames);
      setLoadProgress(100);
    }
  }, [illustId]);

  // 灯箱模式：已缓存则自动加载播放，无需手动点击
  useEffect(() => {
    if (!compact && needsFetch && !autoLoadRef.current) {
      autoLoadRef.current = true;
      loadFrames();
    }
  }, [compact, needsFetch]); // oxlint-disable-line react-hooks/exhaustive-deps -- loadFrames 定义在后，靠 autoLoadRef 守护

  // 懒加载：点击时下载完整帧（支持后台下载不中断）
  const loadFrames = async (retry = false) => {
    if (loading || loaded) return;

    setError(null);

    // 已有共享帧缓存 → 直接恢复，不显示加载态（retry 走 fetchUgoiraFrames 的 force 强制刷新）
    const cached = getCachedFrames(illustId);
    if (cached?.frames?.length) {
      restoringRef.current = true;
      loadedRef.current = false;
      setFrames(cached.frames);
      setLoadProgress(100);
      setError(null);
      return;
    }

    setLoading(true);
    setLoadProgress(0);
    setError(null);

    const promise = (async () => {
      if (stallTimeout > 0) {
        // 看门狗：仅在"无任何进度"超过 stallTimeout 时超时；慢速但持续有数据的下载不会被误杀。
        // 超时后底层下载仍会在后台继续并写入缓存，重进灯箱可直接命中。
        let stallTimer = null;
        let rejectStall;
        const stallPromise = new Promise((_, reject) => { rejectStall = reject; });
        const armStall = () => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(() => rejectStall(new Error('GIF 下载停滞超时，请检查网络后重试')), stallTimeout);
        };
        armStall();
        try {
          const result = await Promise.race([
            fetchUgoiraFrames(illustId, (pct) => {
              armStall(); // 有进度 → 重置停滞计时
              if (mountedRef.current) setLoadProgress(pct);
            }, retry ? { force: true } : undefined),
            stallPromise,
          ]);
          return result;
        } finally {
          clearTimeout(stallTimer);
        }
      }
      const result = await fetchUgoiraFrames(illustId, (pct) => {
        if (mountedRef.current) setLoadProgress(pct);
      }, retry ? { force: true } : undefined);
      return result;
    })();

    try {
      const result = await promise;
      if (result.frames?.length) {
        loadedRef.current = false;
        if (mountedRef.current) {
          setFrames(result.frames);
          setError(null);
        }
      } else {
        // 有 result 但没有 frames → 记录错误
        const errMsg = result?.error || '未知错误';
        log.warn('加载失败:', errMsg);
        if (clearCacheOnError) clearFrameCache(illustId);
        if (mountedRef.current) setError(errMsg);
      }
    } catch (e) {
      log.warn('加载失败:', e.message);
      if (clearCacheOnError) clearFrameCache(illustId);
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
  }, [frames, illustId]); // oxlint-disable-line react-hooks/exhaustive-deps -- playFrame 定义在后，frames 变化时自动重建

  // 播放动画 —— 由 rAF + 累计时间驱动，比 setTimeout 更流畅
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

    // 用 elapsed 代替 setTimeout: 当前帧已经显示够 delay 时间了吗？
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
    if (e) { e.preventDefault?.(); e.stopPropagation(); }
    if (!loaded) return;
    if (debounceToggle) {
      const now = Date.now();
      if (now - lastToggleRef.current < 300) return;
      lastToggleRef.current = now;
    }

    setPlaying(prev => {
      const next = !prev;
      if (next) {
        /* 继续播放：调整时间戳避免帧跳帧 */
        lastFrameTimeRef.current = null;
        timerRef.current = requestAnimationFrame(playFrame);
      } else {
        /* 暂停：停 rAF，保留当前帧 */
        cancelAnimationFrame(timerRef.current);
      }
      onTogglePlay?.(next);
      return next;
    });
  }, [loaded, playFrame, onTogglePlay, debounceToggle]);

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
  }, [illustId, frames]); // oxlint-disable-line react-hooks/exhaustive-deps

  // 尺寸计算
  const hasValidSize = canvasSize.width > 0 && canvasSize.height > 0;
  const maxW = maxWidthProp ?? (compact ? 240 : window.innerWidth);
  const maxH = maxHeightProp ?? Math.round(window.innerHeight * 0.75);
  // GIF 优先用宽高 prop；Ugoira 优先用首帧 canvas 尺寸
  const knownRatio = widthProp > 0 && heightProp > 0 ? heightProp / widthProp : null;
  const useCanvasRatio = capWidthByCanvas && hasValidSize;
  const ratio = knownRatio ?? (useCanvasRatio ? canvasSize.height / canvasSize.width : 0.75);
  let displayWidth = (capWidthByCanvas && hasValidSize) ? Math.min(canvasSize.width, maxW) : maxW;
  let displayHeight = Math.round(displayWidth * ratio);
  if (capByMaxHeight && displayHeight > maxH) {
    displayHeight = maxH;
    displayWidth = Math.round(maxH / ratio);
  }

  // 已有 blob URL（网格已加载）→ 直接用原生 <img> 播放，无需 Canvas 重载
  if (src && src.startsWith('blob:')) {
    return (
      <div className={`${cssPrefix}-player native ${className}`} style={{ width: displayWidth, maxWidth: '100%', ...style }}>
        <img src={src} alt={title || 'GIF'} style={{ width: '100%', maxHeight: '75vh', objectFit: 'contain' }} />
        {!hideInfo && !compact && (
          <div className={`${cssPrefix}-info`}>
            <span className={`${cssPrefix}-title`}>{title || 'GIF 动图'}</span>
            {author && <span className={`${cssPrefix}-author`}>{author}</span>}
          {pixivUrl && !hideLink && <a className={`${cssPrefix}-pixiv-link`} href={pixivUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>Pixiv →</a>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`${cssPrefix}-player ${playing ? 'playing' : ''} ${loaded ? 'loaded' : 'loading'} ${compact ? 'compact' : ''} ${className}`}
      style={{ width: displayWidth, maxWidth: '100%', ...style }}
      onClick={clickable ? (e) => {
        e.stopPropagation();
        if (loaded) togglePlay(e); else loadFrames();
      } : undefined}
      onTouchStart={handleTouch ? (e) => { const t = e.touches[0]; touchStartRef.current = { x: t.clientX, y: t.clientY }; } : undefined}
      onTouchEnd={handleTouch ? (e) => {
        const t = e.changedTouches[0];
        const dx = Math.abs(t.clientX - touchStartRef.current.x);
        const dy = Math.abs(t.clientY - touchStartRef.current.y);
        // 只有轻点（移动 <10px）才响应，swipe 不拦截
        if (dx < 10 && dy < 10) {
          e.stopPropagation();
          if (loaded) togglePlay(e); else loadFrames();
        }
      } : undefined}
    >
      <div className={`${cssPrefix}-canvas-wrap`} style={{ width: displayWidth, height: displayHeight }}>
        {/* 缩略图兜底：帧加载完成前始终显示卡片同款缩略图 */}
        {thumbnailUrl && !loaded && (
          <img src={thumbnailUrl} alt="" className={`${cssPrefix}-thumb-fallback`}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
        <canvas
          ref={canvasRef}
          width={canvasSize.width || displayWidth}
          height={canvasSize.height || displayHeight}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          className={`${cssPrefix}-canvas`}
        />

        {/* 播放按钮覆盖层（缓存恢复中隐藏） */}
        {!restoringRef.current && !playing && !loading && (
          <div className={`${cssPrefix}-play-overlay`}>
            <span className={`${cssPrefix}-play-icon`}>▶</span>
          </div>
        )}

        {/* 加载中指示器（缓存恢复时跳过） */}
        {!restoringRef.current && (loading || (!loaded && totalFrames > 0 && !needsFetch)) && (
          <div className={`${cssPrefix}-loading-overlay`}>
            {progressBar === 'circle'
              ? <CircularProgress pct={Math.max(0, loadProgress)} />
              : (
                <>
                  <span className={`${cssPrefix}-loading-spinner`} />
                  <div className={`${cssPrefix}-progress-bar ${cssPrefix}-progress-bar--loading`}>
                    <div className={`${cssPrefix}-progress-fill`} style={{ width: `${Math.max(0, loadProgress)}%`, transition: 'width 0.15s ease' }} />
                  </div>
                </>
              )}
          </div>
        )}

        {/* 错误提示 + 点击重试 */}
        {error && !loading && (
          <div className={`${cssPrefix}-loading-overlay`}
            style={{ flexDirection: 'column', gap: 8, cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); loadFrames(true); }}>
            <span style={{ fontSize: 32 }}>⚠️</span>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', textAlign: 'center', padding: '0 12px', lineHeight: 1.4 }}>{error}</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>点击重试</span>
          </div>
        )}

        {/* 进度条（播放时） */}
        {playing && (
          <div className={`${cssPrefix}-progress-bar`}>
            <div className={`${cssPrefix}-progress-fill`} style={{ width: `${progress}%` }} />
          </div>
        )}

        {/* 暂停提示 */}
        {!hideInfo && pauseHint && playing && (
          <div className={`${cssPrefix}-pause-hint`}>⏸ 点击暂停</div>
        )}
      </div>

      {/* 信息栏（非紧凑模式） */}
      {!hideInfo && !compact && (
        <div className={`${cssPrefix}-info`}>
          <span className={`${cssPrefix}-title`}>{title || (cssPrefix === 'gif' ? 'GIF 动图' : 'Ugoira 动图')}</span>
          {author && <span className={`${cssPrefix}-author`}>{author}</span>}
          {pixivUrl && !hideLink && (
            <a className={`${cssPrefix}-pixiv-link`} href={pixivUrl} target="_blank" rel="noreferrer"
              onClick={e => e.stopPropagation()}>
              Pixiv →
            </a>
          )}
        </div>
      )}
    </div>
  );
}
