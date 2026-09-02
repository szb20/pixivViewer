/**
 * DownloadMonitorButton — 下载进度悬浮按钮 + 毛玻璃全屏弹窗。
 *
 * 订阅全局 downloadMonitor（见 utils/downloadMonitor.js），
 * 有进行中任务或失败任务时显示悬浮按钮（角标=下载队列文件总数 + 失败数），
 * 点击展开任务列表；失败任务常驻，可一键重试（也跨会话持久化在 localStorage）。
 */
import { useState, useSyncExternalStore, useEffect, useCallback } from 'react';
import { downloadMonitor } from '../utils/downloadMonitor.js';
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
  return !!(r?.success || r?.cached);
}

function DownloadRow({ job, onRetry, retrying }) {
  const pct = job.progress;
  let statusText;
  if (job.status === 'done') statusText = '已完成';
  else if (job.status === 'error' && retrying) statusText = '重试中…';
  else if (job.status === 'error') statusText = job.error || '失败';
  else statusText = job.message || (job.status === 'writing' ? '写入相册' : '下载中');

  // 圆环进度：半径 16，周长 ≈ 100.53
  const r = 16;
  const circumference = 2 * Math.PI * r;
  const offset = pct != null ? circumference * (1 - pct / 100) : circumference;

  return (
    <div className={`download-row download-row--${job.status}${retrying ? ' download-row--retrying' : ''}`}>
      <span className="download-row-title">{job.title || job.illustId}</span>
      <span className="download-row-status">{job.kind === 'gif' ? '动图 · ' : ''}{statusText}</span>
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
  const snap = useSyncExternalStore(downloadMonitor.subscribe, downloadMonitor.getSnapshot);
  const jobs = snap.jobs;
  const queueTotal = snap.queueTotal;
  const [open, setOpen] = useState(false);
  const [retryingKeys, setRetryingKeys] = useState(() => new Set());
  // 角标显示下载队列文件总数（下载方上报），无上报时退化为当前任务数
  const total = queueTotal > 0 ? queueTotal : jobs.length;
  const failCount = jobs.filter(j => j.status === 'error').length;

  // 任务全部完成后自动关闭弹窗（进行中任务为 0 时才关；失败任务常驻不触发关闭）
  useEffect(() => {
    if (open && jobs.length > 0 && jobs.every(j => j.status === 'done' || j.status === 'error')) {
      // 失败任务保留在列表，仅当全为 done 时关
      if (jobs.every(j => j.status === 'done')) setOpen(false);
    }
  }, [jobs, open]);

  // 重试：调用下载管理的 retry(key)，随后重新走保存链路
  const handleRetry = useCallback(async (job) => {
    downloadMonitor.retry(job.key, async (meta) => {
      setRetryingKeys(prev => new Set(prev).add(job.key));
      try {
        const ok = await retryDownload(meta);
        if (ok) {
          // 成功：任务本轮已由 retry 移除，这里显式清一下持久化（若 retry 未带 meta 时）
          // 失败：重新登记为该任务（downloadMonitor.start 会新建并覆盖持久化）
          downloadMonitor.clearFinished();
        } else {
          // 再次失败 → 记录失败信息（保留在列表）
          downloadMonitor.recordFailure(job.key, { ...meta, error: '重试失败' });
          downloadMonitor.finish(job.key, false, '重试失败');
        }
      } catch (e) {
        downloadMonitor.recordFailure(job.key, { ...(job.retry || {}), error: e?.message || '重试失败' });
        downloadMonitor.finish(job.key, false, e?.message || '重试失败');
      } finally {
        setRetryingKeys(prev => { const n = new Set(prev); n.delete(job.key); return n; });
      }
    });
  }, []);

  // 没有进行中任务也没有失败任务时不显示悬浮按钮
  const hasActive = jobs.some(j => j.status === 'downloading' || j.status === 'writing');
  if (!jobs.length || (!hasActive && failCount === 0)) return null;

  return (
    <>
      <button
        className="download-fab glass-icon-btn"
        onClick={() => setOpen(o => !o)}
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

      {open && (
        <div className="dialog-overlay" data-variant="download" onClick={() => setOpen(false)}>
          <div className="dialog-panel" onClick={e => e.stopPropagation()}>
            <div className="download-head">
              <span className="download-head-title">下载管理</span>
              <button className="download-head-clear" onClick={() => downloadMonitor.clearFinished()}>清除已完成</button>
            </div>
            {/* 列表 */}
            <div className="download-list">
              {jobs.length === 0 ? (
                <div className="download-empty">暂无下载任务</div>
              ) : (
                jobs
                  .slice()
                  .sort((a, b) => {
                    // 进行中在前，失败在后（常驻），已完成为最后
                    const rank = { downloading: 0, writing: 0, error: 1, done: 2 };
                    return (rank[a.status] ?? 2) - (rank[b.status] ?? 2);
                  })
                  .map(j => (
                    <DownloadRow
                      key={j.key}
                      job={j}
                      onRetry={handleRetry}
                      retrying={retryingKeys.has(j.key)}
                    />
                  ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
