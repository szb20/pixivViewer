/**
 * DownloadMonitorButton — 下载进度悬浮按钮 + 毛玻璃全屏弹窗。
 *
 * 订阅全局 downloadMonitor（见 utils/downloadMonitor.js），
 * 有下载任务时显示悬浮按钮（角标=下载队列文件总数），点击展开全屏毛玻璃任务列表。
 */
import { useState, useSyncExternalStore, useEffect } from 'react';
import { downloadMonitor } from '../utils/downloadMonitor.js';
import '../styles/download.css';

function DownloadRow({ job }) {
  const pct = job.progress;
  let statusText;
  if (job.status === 'done') statusText = '已完成';
  else if (job.status === 'error') statusText = job.error || '失败';
  else statusText = job.message || (job.status === 'writing' ? '写入相册' : '下载中');

  // 圆环进度：半径 16，周长 ≈ 100.53
  const r = 16;
  const circumference = 2 * Math.PI * r;
  const offset = pct != null ? circumference * (1 - pct / 100) : circumference;

  return (
    <div className={`download-row download-row--${job.status}`}>
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
      {job.status === 'error' && <span className="download-row-err">✕</span>}
    </div>
  );
}

export default function DownloadMonitorButton() {
  const snap = useSyncExternalStore(downloadMonitor.subscribe, downloadMonitor.getSnapshot);
  const jobs = snap.jobs;
  const queueTotal = snap.queueTotal;
  const [open, setOpen] = useState(false);
  // 角标显示下载队列文件总数（下载方上报），无上报时退化为当前任务数
  const total = queueTotal > 0 ? queueTotal : jobs.length;

  // 任务全部完成后自动关闭弹窗
  useEffect(() => {
    if (open && jobs.length > 0 && jobs.every(j => j.status === 'done' || j.status === 'error')) {
      setOpen(false);
    }
  }, [jobs, open]);

  // 没有任务时不显示悬浮按钮
  if (!jobs.length) return null;

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
      </button>

      {open && (
        <div className="dialog-overlay" data-variant="download" onClick={() => setOpen(false)}>
          <div className="dialog-panel" onClick={e => e.stopPropagation()}>
            {/* 列表 */}
            <div className="download-list">
              {jobs.length === 0 ? (
                <div className="download-empty">暂无下载任务</div>
              ) : (
                jobs.map(j => <DownloadRow key={j.key} job={j} />)
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
