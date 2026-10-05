/**
 * useDownloadJobs — 订阅全局下载队列，给出各状态的数量。
 *
 * 悬浮按钮（DownloadMonitor）与侧边栏下载入口都要显示同样的角标，
 * 抽出来避免两处各算一遍导致数字对不上。
 */
import { useSyncExternalStore } from 'react';
import { downloadMonitor } from '../utils/downloadMonitor.js';

export function useDownloadJobs() {
  const snap = useSyncExternalStore(downloadMonitor.subscribe, downloadMonitor.getSnapshot);
  const jobs = snap.jobs;
  const queueTotal = snap.queueTotal;

  const activeCount = jobs.filter(j => j.status === 'downloading' || j.status === 'writing').length;
  const failCount = jobs.filter(j => j.status === 'error').length;
  const doneCount = jobs.filter(j => j.status === 'done').length;

  return {
    jobs,
    // 角标优先用下载方上报的队列文件总数（多图作品的页数），无上报时退化为任务数
    total: queueTotal > 0 ? queueTotal : jobs.length,
    activeCount,
    failCount,
    doneCount,
  };
}
