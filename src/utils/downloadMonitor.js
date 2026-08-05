/**
 * downloadMonitor — 全局下载进度监视器（单例，框架无关）。
 *
 * 静态图/动图保存时通过 downloadMonitor.start() 登记任务并上报进度；
 * UI 用 useSyncExternalStore 订阅（见 components/DownloadMonitor.jsx）。
 *
 * job 结构：
 *   { key, illustId, page, title, kind: 'image'|'gif',
 *     status: 'downloading'|'writing'|'done'|'error',
 *     progress: number|null, message: string, error: string }
 */

const listeners = new Set();
const jobs = new Map();
// queueTotal：本次下载队列的文件总数（多图批量时=全部页数），由下载方在开始时上报；
// 徽标据此显示"队列里还有多少文件"，而非当前正在下载的个数
let queueTotal = 0;
let snapshot = { jobs: [], queueTotal: 0 };

function emit() {
  snapshot = { jobs: jobs.size ? [...jobs.values()] : [], queueTotal };
  for (const fn of [...listeners]) fn();
}

export const downloadMonitor = {
  /** 上报本次下载队列的文件总数（徽标显示用） */
  setQueueTotal(n) {
    queueTotal = Math.max(0, Number(n) || 0);
    emit();
  },

  /** 登记一个下载任务，返回进度句柄 */
  start(key, meta) {
    jobs.set(key, {
      key,
      illustId: meta.illustId || '',
      page: meta.page ?? 0,
      title: meta.title || '',
      kind: meta.kind || 'image',
      status: 'downloading',
      progress: null,
      message: meta.message || '',
      error: '',
    });
    emit();
    return {
      setProgress(pct) {
        const j = jobs.get(key);
        if (!j || j.status === 'done' || j.status === 'error') return;
        const value = Number(pct);
        if (!Number.isFinite(value)) return;
        // 进度只增不减：模拟进度/真实进度/写相册阶段混用时不回退
        if (j.progress != null && value < j.progress) return;
        j.progress = value;
        emit();
      },
      setStatus(status, message = '') {
        const j = jobs.get(key);
        if (!j || j.status === 'done' || j.status === 'error') return;
        j.status = status;
        if (message) j.message = message;
        emit();
      },
      finish(ok, error = '') {
        const j = jobs.get(key);
        if (!j) return;
        j.status = ok ? 'done' : 'error';
        j.error = ok ? '' : error;
        if (ok) j.progress = 100;
        emit();
        // 完成后保留一小段时间便于查看，之后自动移除
        setTimeout(() => {
          if (jobs.get(key)?.status === 'done' || jobs.get(key)?.status === 'error') {
            jobs.delete(key);
            // 队列清空后重置总数，避免徽标残留旧值
            if (jobs.size === 0) queueTotal = 0;
            emit();
          }
        }, 8000);
      },
    };
  },

  /** 立即清除所有已完成/失败任务 */
  clearFinished() {
    for (const [k, j] of jobs) {
      if (j.status === 'done' || j.status === 'error') jobs.delete(k);
    }
    if (jobs.size === 0) queueTotal = 0;
    emit();
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  getSnapshot() {
    return snapshot;
  },
};
