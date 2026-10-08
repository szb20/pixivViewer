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

  const activeCount = jobs.filter(j => j.status === 'downloading' || j.status === 'writing').length;
  const failCount = jobs.filter(j => j.status === 'error').length;
  const doneCount = jobs.filter(j => j.status === 'done').length;

  return {
    jobs,
    // 队列里的任务条数。以前这里是「下载方上报的文件总数，没有就退化成任务数」，
    // 但没有任何调用方上报过 —— 现在就是任务数，和弹窗里列出的行数一致
    total: jobs.length,
    activeCount,
    failCount,
    doneCount,
  };
}
