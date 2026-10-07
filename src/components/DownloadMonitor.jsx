/**
 * DownloadMonitorButton — 下载进度悬浮按钮 + 毛玻璃全屏弹窗。
 *
 * 订阅全局 downloadMonitor（见 utils/downloadMonitor.js），
 * 有进行中任务或失败任务时显示悬浮按钮（角标=下载队列文件总数 + 失败数），
 * 点击展开任务列表；失败任务常驻，可一键重试（也跨会话持久化在 localStorage）。
 */
import { useState, useEffect, useCallback } from 'react';
import { downloadMonitor } from '../utils/downloadMonitor.js';
import { useDownloadJobs } from '../hooks/useDownloadJobs.js';
import { useOverlayFocus } from '../hooks/useOverlayFocus.js';
import { useAppStore } from '../store/useAppStore.js';
import { saveItem } from '../api/index.js';
import '../styles/download.css';

/** 失败重试入口：静图/动图统一走 saveItem，success/cached 视为成功 */
async function retryDownload(meta) {
  const r = await saveItem({
    illustId: meta.illustId,
    _pageIndex: meta.page ?? 0,
    type: meta.type || meta.kind || 'image',
    illustType: meta.illustType,
    originalUrl: meta.originalUrl,
    mediumUrl: meta.mediumUrl,
    thumbnailUrl: meta.thumbnailUrl,
    title: meta.title,
    author: meta.author,
    authorName: meta.authorName,
    authorId: meta.authorId,
    tags: meta.tags,
    _liked: meta._liked,
  });
  return { ok: !!(r?.success || r?.cached), error: r?.error || '' };
}

/** 保存链路内部错误码 → 给用户看的文案；未知错误原样透传 */
const ERR_TEXT = {
  invalid_item: '条目信息不完整',
  no_url: '没有可下载的地址',
  download_failed: '下载失败',
};

/** 字节数格式化（下载行显示用） */
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function DownloadRow({ job, onRetry, retrying }) {
  const pct = job.progress;
  let statusText;
  if (job.status === 'done') statusText = '已完成';
  else if (job.status === 'error' && retrying) statusText = '重试中…';
  else if (job.status === 'error') statusText = job.error || '失败';
  else statusText = job.message || (job.status === 'writing' ? '写入相册' : '下载中');

  // 大小/速度只在**真有字节数**时显示：桌面主进程与安卓原生通道会给，
  // CapacitorHttp 降级路径拿不到，那就只留状态文案（不编数字）
  const bytesText = (() => {
    if (job.status !== 'downloading' || !job.loaded) return '';
    const size = job.total > 0
      ? `${fmtBytes(job.loaded)} / ${fmtBytes(job.total)}`
      : fmtBytes(job.loaded);
    const speed = job.speed > 1024 ? `${fmtBytes(job.speed)}/s` : '';
    return [size, speed].filter(Boolean).join(' · ');
  })();

  // 圆环进度：半径 16，周长 ≈ 100.53
  const r = 16;
  const circumference = 2 * Math.PI * r;
  const offset = pct != null ? circumference * (1 - pct / 100) : circumference;

  return (
    <div className={`download-row download-row--${job.status}${retrying ? ' download-row--retrying' : ''}`}>
      <span className="download-row-title">{job.title || job.illustId}</span>
      <span className="download-row-status">
        {job.kind === 'gif' ? '动图 · ' : ''}{statusText}
        {bytesText && <span className="download-row-bytes">{bytesText}</span>}
      </span>
      {(job.status === 'downloading' || job.status === 'writing') && (
        <span className="download-row-ring">
          <svg width="36" height="36" viewBox="0 0 36 36">
            <circle
              className="download-ring-track"
              cx="18" cy="18" r={r}
              fill="none"
              strokeWidth="2"
            />
            <circle
              className="download-ring-fill"
              cx="18" cy="18" r={r}
              fill="none"
              strokeWidth="2"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
              transform="rotate(-90 18 18)"
            />
          </svg>
          {pct != null && <span className="download-ring-pct">{pct}%</span>}
        </span>
      )}
      {job.status === 'done' && <span className="download-row-done">✓</span>}
      {job.status === 'error' && !retrying && (
        <button
          className="download-row-retry"
          onClick={(e) => { e.stopPropagation(); onRetry?.(job); }}
          aria-label="重试下载"
        >重试</button>
      )}
      {job.status === 'error' && retrying && <span className="download-row-spinner" />}
    </div>
  );
}

export default function DownloadMonitorButton() {
  const { jobs, total, activeCount, failCount, doneCount } = useDownloadJobs();
  const open = useAppStore(s => s.downloadOpen);
  const setDownloadOpen = useAppStore(s => s.setDownloadOpen);
  const [retryingKeys, setRetryingKeys] = useState(() => new Set());
  // 打开时把焦点移进抽屉、关闭时还给侧边栏那个入口；Esc 关闭
  const overlayRef = useOverlayFocus(open, () => setDownloadOpen(false));

  // 任务全部完成后自动关闭弹窗（失败任务常驻，不触发关闭）
  useEffect(() => {
    if (open && jobs.length > 0 && jobs.every(j => j.status === 'done')) setDownloadOpen(false);
  }, [jobs, open, setDownloadOpen]);

  // 重试：调用下载管理的 retry(key)，随后重新走保存链路。
  // 返回 promise —— 「全部重试」靠 await 它才能真串行。
  const handleRetry = useCallback((job) => {
    return Promise.resolve(downloadMonitor.retry(job.key, async (meta) => {
      setRetryingKeys(prev => new Set(prev).add(job.key));
      const failMsg = (err) => ERR_TEXT[err] || err || '重试失败';
      // retry() 已把任务从列表移除；失败时要显式重建，
      // 否则 saveItem 走的早退分支（无 URL / 条目不完整）不会调 start，这条会凭空消失
      const recreateFailed = (msg) => {
        // 保存链路自己也会 start/finish 同一个 key（`${illustId}_${page}`）：
        // 它已经登记过就保留它写的文案，别覆盖成这里传进来的原始错误码。
        // 只有链路根本没碰 monitor 时才补建 —— no_url / invalid_item 这类早退分支
        // 不补建的话，这条失败记录会从列表里凭空消失（重试入口也一起没了）。
        if (downloadMonitor.getSnapshot().jobs.some(j => j.key === job.key)) return;
        // 用 start() 的句柄收尾：单例上没有 finish（历史上这里写成 downloadMonitor.finish，
        // 重试失败时必抛 TypeError，任务被 retry() 先删掉又没能重建，行直接消失）
        const h = downloadMonitor.start(job.key, {
          illustId: meta.illustId,
          page: meta.page,
          title: meta.title,
          kind: meta.kind,
          message: '重试中',
        });
        h.recordFailure({ ...meta, error: msg });
        h.finish(false, msg);
      };
      try {
        const r = await retryDownload(meta);
        if (r.ok) {
          // 成功：只清掉这一条 —— clearFinished 会把其他等待重试的失败记录一并抹掉
          downloadMonitor.dismiss(job.key);
        } else {
          recreateFailed(failMsg(r.error));
        }
      } catch (e) {
        recreateFailed(failMsg(e?.message));
      } finally {
        setRetryingKeys(prev => { const n = new Set(prev); n.delete(job.key); return n; });
      }
    }));
  }, []);

  // 全部重试：串行，避免同时打一堆请求
  const handleRetryAll = useCallback(async () => {
    for (const job of jobs.filter(j => j.status === 'error')) {
      await handleRetry(job);
    }
  }, [jobs, handleRetry]);

  // 悬浮按钮只在真有进行中/失败任务时出现；弹窗不依赖它，无任务时也能从侧边栏打开
  const showFab = jobs.length > 0 && (activeCount > 0 || failCount > 0);

  const active = jobs.filter(j => j.status === 'downloading' || j.status === 'writing');
  const failed = jobs.filter(j => j.status === 'error');
  const done = jobs.filter(j => j.status === 'done');
  const summary = [
    activeCount && `进行中 ${activeCount}`,
    failCount && `失败 ${failCount}`,
    doneCount && `已完成 ${doneCount}`,
  ].filter(Boolean).join(' · ');

  const renderGroup = (label, list) => (
    list.length > 0 && (
      <section className="download-group" key={label}>
        <div className="download-group-head">
          <span>{label}</span>
          <span className="download-group-count">{list.length}</span>
        </div>
        {list.map(j => (
          <DownloadRow key={j.key} job={j} onRetry={handleRetry} retrying={retryingKeys.has(j.key)} />
        ))}
      </section>
    )
  );

  return (
    <>
      {showFab && (
        <button
          className="download-fab glass-icon-btn"
          onClick={() => setDownloadOpen(!open)}
          aria-label="下载进度"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          {total > 0 && <span className="download-fab-badge">{total}</span>}
          {failCount > 0 && <span className="download-fab-badge download-fab-badge--fail">{failCount}</span>}
        </button>
      )}

      {open && (
        <div
          className="dialog-overlay"
          data-variant="download"
          ref={overlayRef}
          tabIndex={-1}
          onClick={() => setDownloadOpen(false)}
        >
          <div
            className="dialog-panel"
            role="dialog"
            aria-modal="true"
            aria-label="下载管理"
            onClick={e => e.stopPropagation()}
          >
            <div className="download-head">
              <div className="download-head-text">
                <span className="download-head-title">下载管理</span>
                {summary && <span className="download-head-summary">{summary}</span>}
              </div>
              <div className="download-head-actions">
                {failCount > 1 && (
                  <button className="download-head-btn" onClick={handleRetryAll}>全部重试</button>
                )}
                {doneCount > 0 && (
                  <button className="download-head-btn" onClick={() => downloadMonitor.clearFinished()}>清除已完成</button>
                )}
              </div>
            </div>

            <div className="download-list">
              {jobs.length === 0 ? (
                <div className="download-empty">
                  暂无下载任务
                  <span>在详情页点「下载」，或长按图片保存</span>
                </div>
              ) : (
                <>
                  {renderGroup('进行中', active)}
                  {renderGroup('失败', failed)}
                  {renderGroup('已完成', done)}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
