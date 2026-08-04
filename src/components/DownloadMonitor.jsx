/**
 * DownloadMonitorButton — 下载进度悬浮按钮 + 毛玻璃全屏弹窗。
 *
 * 订阅全局 downloadMonitor（见 utils/downloadMonitor.js），
 * 有下载任务时显示悬浮按钮（角标=进行中数量），点击展开全屏毛玻璃任务列表。
 */
import { useState, useSyncExternalStore } from 'react';
import { downloadMonitor } from '../utils/downloadMonitor.js';
import '../styles/download.css';

function DownloadRow({ job }) {
  const pct = job.progress;
  let statusText;
  if (job.status === 'done') statusText = '已完成';
  else if (job.status === 'error') statusText = job.error || '失败';
  else statusText = job.message || (job.status === 'writing' ? '写入相册' : '下载中');

  return (
    <div className={`download-row download-row--${job.status}`}>
      <div className="download-row-main">
        <div className="download-row-top">
          <span className="download-row-title">{job.title || job.illustId}</span>
          <span className="download-row-status">{job.kind === 'gif' ? '动图 · ' : ''}{statusText}</span>
          {job.status === 'done' && <span className="download-row-done">✓</span>}
          {job.status === 'error' && <span className="download-row-err">✕</span>}
        </div>
        {(job.status === 'downloading' || job.status === 'writing') && (
          <div className="download-row-progress">
            <div className="download-bar">
              <div
                className={`download-bar-fill${pct == null ? ' download-bar-indeterminate' : ''}`}
                style={pct != null ? { width: `${pct}%` } : undefined}
              />
            </div>
            {pct != null && <span className="download-pct">{pct}%</span>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function DownloadMonitorButton() {
  const jobs = useSyncExternalStore(downloadMonitor.subscribe, downloadMonitor.getSnapshot);
  const [open, setOpen] = useState(false);
  const active = jobs.filter(j => j.status === 'downloading' || j.status === 'writing').length;

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
        {active > 0 && <span className="download-fab-badge">{active}</span>}
      </button>

      {open && (
        <div className="download-overlay" onClick={() => setOpen(false)}>
          <div className="download-sheet" onClick={e => e.stopPropagation()}>
            {/* 顶部抓取条 */}
            <div className="download-sheet-handle" />
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
