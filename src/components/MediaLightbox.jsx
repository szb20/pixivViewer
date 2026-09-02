import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import GifPlayer from './GifPlayer.jsx';
import { useTouchGesture } from '../hooks/useTouchGesture.js';
import { createLogger } from '../utils/logger.js';
import '../styles/lightbox.css';

const log = createLogger('Lightbox');

/** 图片加载失败的最大重试次数，超过后停止自动重试并显示占位 */
const MAX_IMG_RETRY = 3;

/**
 * 统一媒体灯箱 — 支持图片、Ugoira 动图、视频（抖音/iwara/B站/通用嵌入）。
 *
 * 触摸手势引擎由 useTouchGesture hook 统一管理，
 * 根据媒体类型自动启用/禁用缩放手势（图片可缩放，视频/动图仅滑动翻页）。
 *
 * Props:
 *   items        — { type, src?, title?, author?, ... }[]
 *                   type: 'image' | 'gif' | 'douyin' | 'iwara' | 'bilibili' | 'video'
 *   initialIndex — 初始显示的媒体索引
 *   onClose      — () => void
 *   onIndexChange— (index) => void
 *   disableZoom  — 强制禁用缩放手势（默认根据 type 自动判断）
 *   zIndex       — 自定义 z-index（默认 10000）
 */
/** 视频播放器 — controls 播放 2s 后自动渐隐，点击画面重新显示 */
function VideoPlayer({ src, poster, isCurrent, onRef }) {
  const [showControls, setShowControls] = useState(true);
  const hideTimer = useRef(null);
  const elRef = useRef(null);

  const scheduleHide = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowControls(false), 2000);
  }, []);

  const handlePlay = () => scheduleHide();
  const handlePause = () => { clearTimeout(hideTimer.current); setShowControls(true); };
  const handleClick = (e) => {
    e.stopPropagation();
    if (!showControls) {
      setShowControls(true);
      scheduleHide();
    }
  };

  useEffect(() => {
    onRef(elRef.current);
    return () => onRef(null);
  }, [onRef]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  return (
    <div className="video-player-wrapper" key={src}>
      <video
        ref={elRef}
        className="video-direct-player"
        src={src}
        poster={poster}
        autoPlay={isCurrent}
        playsInline
        controls={showControls}
        onPlay={handlePlay}
        onPause={handlePause}
        onClick={handleClick}
      />
    </div>
  );
}

export default function MediaLightbox({
  items,
  initialIndex = 0,
  onClose,
  onIndexChange,
  disableZoom: forceDisableZoom,
  zIndex = 10000,
}) {
  const [retryMap, setRetryMap] = useState({});
  const videoRefs = useRef({});
  const [iwaraQuality, setIwaraQuality] = useState('Source');

  const {
    overlayRef, trackRef, slideRefs,
    index, closing,
    swipeOff, pinchScale, pinchPan, zoomTrans,
    cur, isGif,
    handleTouchStart, handleTouchMove, handleTouchEnd,
    handleMouseDown, handleMouseMove, handleMouseUp,
    handleWheel, handleDoubleClick,
    handleClose,
  } = useTouchGesture({
    images: items,
    initialIndex,
    onClose,
    onIndexChange,
    disableZoom: forceDisableZoom,
  });

  const isVideoType = (t) => t === 'douyin' || t === 'iwara' || t === 'bilibili' || t === 'video';
  const isVideo = isVideoType(cur?.type);

  // ── 切换 slide 时暂停非当前视频 ──
  useEffect(() => {
    Object.entries(videoRefs.current).forEach(([i, el]) => {
      if (Number(i) !== index && el && !el.paused) el.pause();
    });
  }, [index]);

  // ── Body 滚动锁定（防止灯箱内触控影响背景页面） ──
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // ── 切换 iwara 视频时重置画质选择 ──
  useEffect(() => {
    if (cur?.type === 'iwara') {
      const t = setTimeout(() => setIwaraQuality(cur.selectedQuality || 'Source'), 0);
      return () => clearTimeout(t);
    }
  }, [index]); // oxlint-disable-line react-hooks/exhaustive-deps

  // ── 主动预加载相邻图片（浏览器缓存预热，避免滑动时等待） ──
  useEffect(() => {
    for (let d = -2; d <= 2; d++) {
      const idx = index + d;
      if (idx < 0 || idx >= items.length) continue;
      const item = items[idx];
      if (item.type !== 'image') continue;
      // 预热候选链首选项（本地 blob → 日期路径原图 → master1200 …）
      const preSrc = item.candidates?.[0] || item.src;
      // 本地/缓存 URL 无需预热
      if (preSrc?.startsWith('blob:') || preSrc?.startsWith('file:')) continue;
      const img = new Image();
      img.src = preSrc;
    }
  }, [index, items]);

  if (!cur) return null;

  const trackStyle = {
    transform: `translateX(calc(-${index * 100}% + ${swipeOff}px))`,
    transition: swipeOff !== 0
      ? 'none'
      : 'transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)',
  };

  /** 渲染视频类内容（抖音 / iwara / B站 / 通用） */
  function renderVideoContent(item, idx, isCurrent) {
    switch (item.type) {
      // ── 抖音视频 ──
      case 'douyin': {
        const vidSrc = item.localUrl || item.downloadUrl || item.url;
        return <VideoPlayer src={vidSrc} poster={item.coverUrl || item.thumbnailUrl || ''} isCurrent={isCurrent} onRef={el => { if (el) videoRefs.current[idx] = el; else delete videoRefs.current[idx]; }} />;
      }

      // ── iwara 视频 ──
      case 'iwara':
        if (item.noDirectDownload && item.embedUrl) {
          return isCurrent ? (
            <iframe
              className="video-embed-iframe"
              src={item.embedUrl}
              title={item.title}
              frameBorder="0"
              allow="autoplay; encrypted-media; fullscreen"
              allowFullScreen
              style={{ width: '100%', height: Math.min(450, window.innerHeight * 0.7) }}
            />
          ) : <div className="lightbox-slide-placeholder" />;
        }
        {
          const qualities = item.availableQualities;
          const qName = iwaraQuality;
          const q = Array.isArray(qualities) ? qualities.find(qo => qo.name === qName) : null;
          const vidSrc = (qName === 'Source' && item.localUrl)
            ? item.localUrl
            : (q?.view || item.localUrl || item.downloadUrl || item.url);
          return (
            <div className="iwara-video-wrapper">
              <VideoPlayer src={vidSrc} poster={item.coverUrl || item.thumbnailUrl || ''} isCurrent={isCurrent} onRef={el => { if (el) videoRefs.current[idx] = el; else delete videoRefs.current[idx]; }} />
              {qualities?.length > 1 && (
                <div className="quality-selector">
                  {qualities.map(qo => (
                    <button key={qo.name}
                      className={'quality-btn' + (qo.name === qName ? ' active' : '')}
                      onClick={e => { e.stopPropagation(); setIwaraQuality(qo.name); }}
                    >
                      {qo.name === 'Source' ? '原画' : qo.name + 'p'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        }

      // ── Bilibili 视频 ──
      case 'bilibili': {
        // 优先本地缓存 blob URL（Capacitor 下载），其次 streamUrl（Electron 自定义协议），
        // 再其次 playUrl（CDN 直链），最后 iframe 嵌入
        if (item.localUrl) {
          return <VideoPlayer src={item.localUrl} poster={item.coverUrl || item.thumbnailUrl || ''} isCurrent={isCurrent} onRef={el => { if (el) videoRefs.current[idx] = el; else delete videoRefs.current[idx]; }} />;
        }
        if (item.streamUrl) {
          return <VideoPlayer src={item.streamUrl} poster={item.coverUrl || item.thumbnailUrl || ''} isCurrent={isCurrent} onRef={el => { if (el) videoRefs.current[idx] = el; else delete videoRefs.current[idx]; }} />;
        }
        if (item.playUrl) {
          return <VideoPlayer src={item.playUrl} poster={item.coverUrl || item.thumbnailUrl || ''} isCurrent={isCurrent} onRef={el => { if (el) videoRefs.current[idx] = el; else delete videoRefs.current[idx]; }} />;
        }
        if (item.embedUrl) {
          return isCurrent ? (
            <iframe
              className="video-embed-iframe"
              src={item.embedUrl}
              title={item.title}
              frameBorder="0"
              allow="autoplay; encrypted-media; fullscreen"
              allowFullScreen
              style={{ width: '100%', height: Math.min(450, window.innerHeight * 0.7) }}
            />
          ) : <div className="lightbox-slide-placeholder" />;
        }
        return <div className="lightbox-slide-placeholder">B站视频</div>;
      }

      // ── 通用视频（YouTube 或其他嵌入） ──
      case 'video':
      default: {
        if (item.embedUrl) {
          return isCurrent ? (
            <iframe
              className="video-embed-iframe"
              src={item.embedUrl}
              title={item.title}
              frameBorder="0"
              allow="autoplay; encrypted-media; fullscreen"
              allowFullScreen
              style={{ width: '100%', height: Math.min(450, window.innerHeight * 0.7) }}
            />
          ) : <div className="lightbox-slide-placeholder" />;
        }
        {
          const vidSrc = item.url;
          return <VideoPlayer src={vidSrc} poster={item.coverUrl || item.thumbnailUrl || ''} isCurrent={isCurrent} onRef={el => { if (el) videoRefs.current[idx] = el; else delete videoRefs.current[idx]; }} />;
        }
      }
    }
  }

  /** 根据 type 渲染当前 slide 的内容 — 按图片类 / 视频类归类 */
  function renderSlideContent(item, idx) {
    const isCurrent = idx === index;

    // 只渲染当前及前后各两张，其余用占位符避免带宽竞争
    const loadable = Math.abs(idx - index) <= 2;
    if (!loadable) {
      return <div className="lightbox-slide-placeholder" />;
    }

    // ── 图片类 ──
    if (item.type === 'image') {
      // 候选 URL 链逐个降级（本地 → 日期路径原图 → master1200 → 短链 …）：
      // 每个候选先各试一次，落到最后一个候选后再带缓存穿透参数重试 MAX_IMG_RETRY 次。
      const candidates = (item.candidates?.length ? item.candidates : [item.src]).filter(Boolean);
      const errCount = retryMap[idx] || 0;
      const lastIdx = Math.max(0, candidates.length - 1);
      const candIdx = Math.min(errCount, lastIdx);
      const attempt = errCount - candIdx; // 当前候选的第几次尝试（0 = 首次）
      const activeSrc = candidates[candIdx] || '';
      const failed = !candidates.length
        || (candIdx === lastIdx && attempt >= MAX_IMG_RETRY);
      if (failed) {
        return (
          <div
            ref={el => slideRefs.current[idx] = el}
            className="lightbox-slide-placeholder"
            onClick={(e) => {
              e.stopPropagation();
              setRetryMap(prev => ({ ...prev, [idx]: 0 }));
            }}
          >
            图片加载失败，点击重试
          </div>
        );
      }
      return (
        // 缩放/平移只作用在容器上：两张图随容器整体运动，天然对齐、单图层合成更流畅
        <div
          ref={el => slideRefs.current[idx] = el}
          className="lightbox-img-wrap"
          style={idx === index && zoomTrans
            ? {
              transform: `scale(${pinchScale}) translate(${pinchPan.x / pinchScale}px, ${pinchPan.y / pinchScale}px)`,
              willChange: 'transform',
            }
            : undefined}
        >
          {/* sharp small 图托底：原图逐行渲染时，底部未渲染区域先由同比例 small 图垫着 */}
          {(item.previewUrl || item.thumbnailUrl) && (
            <img className="lightbox-img-underlay" src={item.previewUrl || item.thumbnailUrl} alt="" />
          )}
          <img
            className="lightbox-img-full"
            src={attempt > 0 && !/^(blob:|file:|content:)/.test(activeSrc) ? `${activeSrc}?r=${attempt}` : activeSrc}
            alt={item.title || ''}
            draggable={false}
            onError={() => {
              const next = errCount + 1;
              if (candIdx < lastIdx) {
                log.warn('灯箱图片加载失败，切换下一个候选:', activeSrc, '→', candidates[candIdx + 1]);
              } else if (attempt >= MAX_IMG_RETRY) {
                log.warn('灯箱图片所有候选均加载失败:', activeSrc);
              }
              setRetryMap(prev => ({ ...prev, [idx]: next }));
            }}
            loading={idx === index ? 'eager' : Math.abs(idx - index) <= 1 ? 'eager' : 'lazy'}
            fetchPriority={idx === index ? 'high' : 'auto'}
            style={{
              width: '100%',
              maxHeight: '75vh',
              objectFit: 'contain',
            }}
          />
        </div>
      );
    }

    if (item.type === 'gif') {
      return (
        <div
          ref={el => slideRefs.current[idx] = el}
          style={{
            width: '100%',
            maxHeight: '75vh',
            display: 'flex',
            justifyContent: 'center',
            ...(idx === index && zoomTrans
              ? {
                transform: `scale(${pinchScale}) translate(${pinchPan.x / pinchScale}px, ${pinchPan.y / pinchScale}px)`,
              }
              : {}),
          }}
        >
          <GifPlayer
            key={item.illustId || idx}
            frames={item.frames || []}
            _lazy={item._lazy}
            illustId={item.illustId}
            title={item.title}
            author={item.author}
            src={item.src}
            thumbnailUrl={item.thumbnailUrl || item.mediumUrl}
            width={item.width}
            height={item.height}
            style={{ width: '100%', maxHeight: '75vh', objectFit: 'contain' }}
          />
        </div>
      );
    }

    // ── 视频类 ──
    if (isVideoType(item.type)) {
      return renderVideoContent(item, idx, isCurrent);
    }

    return <div className="lightbox-slide-placeholder" />;
  }

  const overlay = (
    <div
      ref={overlayRef}
      className={`lightbox-overlay${isGif ? ' lightbox-overlay--gif' : ''}${isVideo ? ' video-lightbox-overlay' : ''}${closing ? ' closing' : ''}`}
      onClick={handleClose}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
      style={{ zIndex }}
    >
      <div className="lightbox-stage-wrap" onClick={e => e.stopPropagation()}>
        <div ref={trackRef} className="lightbox-track" style={trackStyle}>
          {items.map((item, idx) => (
            <div
              key={idx}
              className={`lightbox-slide${item.type === 'gif' ? ' lightbox-slide--ugoira' : ''}`}
            >
              {renderSlideContent(item, idx)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}