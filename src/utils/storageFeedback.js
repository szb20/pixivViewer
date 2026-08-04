/**
 * storageFeedback — 存储操作的 UI 反馈（toast）。
 *
 * StorageFacade 已不再混入 toast，调用方按返回值自行决定提示：
 *   import { toastSaveResult } from '../utils/storageFeedback.js';
 *   const result = await storageFacade.save(...);
 *   toastSaveResult(result);
 */
import { showToast } from './toast.js';

const ERROR_MESSAGES = {
  'not_found': '未找到缓存',
  'file_copy_failed': '文件操作失败',
  'invalid_state': '状态异常，请刷新后重试',
  'no_url': '缺少图片地址',
  'download_failed': '图片下载失败',
  'file_write_failed': '文件写入失败',
  'invalid_item': '无法识别作品',
};

function errorMessage(code) {
  if (code?.startsWith('invalid_state:')) {
    return '状态异常，请刷新后重试';
  }
  return ERROR_MESSAGES[code] || '操作失败，请重试';
}

/** 保存到相册后的反馈 */
export function toastSaveResult(result) {
  if (result?.idempotent) { showToast('已在相册中'); return; }
  if (result?.success) { showToast('已保存到相册'); return; }
  showToast(errorMessage(result?.error), { type: 'error' });
}

/** 移回缓存后的反馈 */
export function toastUnsaveResult(result) {
  if (result?.idempotent) { showToast('已在缓存中'); return; }
  if (result?.success) { showToast('已移回缓存'); return; }
  showToast(errorMessage(result?.error), { type: 'error' });
}

/** 删除后的反馈 */
export function toastDeleteResult(result) {
  if (result?.success) showToast('已删除');
}
