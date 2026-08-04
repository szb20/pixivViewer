/**
 * 应用元数据备份 — 把「喜欢/已保存记录 + cookie」导出到系统下载目录，
 * 卸载重装后 IndexedDB / localStorage 被清空，可从备份一键恢复。
 *
 * 依赖原生 GallerySaverPlugin 的 writeMeta / readMeta / deleteMeta：
 * - 文件写入 Download/TeyvatWhisper/{fileName}（MediaStore Downloads）
 * - 卸载应用后文件仍保留在系统中
 */
import { Capacitor } from '@capacitor/core';
import { getAllMeta, putMetaBatch } from './cacheDB.js';
import { getSettingsSync, saveSettings } from './config.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('metaBackup');

/** 备份文件名（原生插件按 DISPLAY_NAME + RELATIVE_PATH 定位，同名写入会先删旧文件） */
const BACKUP_FILE = 'pixivviewer-meta-backup.json';

/** 备份格式版本，恢复时不一致则跳过 */
const BACKUP_VERSION = 1;

/** 变更后的防抖落盘间隔（点赞/保存等高频操作合并为一次写入） */
const SCHEDULE_DELAY = 2000;

let debounceTimer = null;

function isNative() {
  return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.();
}

function getSaver() {
  return Capacitor?.Plugins?.GallerySaver || null;
}

/** 组装备份内容：全量实体记录 + settings 中的 cookie */
async function collectPayload() {
  const records = await getAllMeta();
  const settings = getSettingsSync();
  return {
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    entities: Array.isArray(records) ? records : [],
    settings: {
      pixivCookie: settings.pixivCookie || '',
    },
  };
}

/** 立即写入备份文件（同名覆盖，幂等） */
export async function writeMetaBackupNow() {
  const saver = getSaver();
  if (!isNative() || !saver?.writeMeta) return false;
  try {
    const payload = await collectPayload();
    const data = JSON.stringify(payload);
    await saver.writeMeta({ fileName: BACKUP_FILE, data });
    log.debug('[writeMetaBackupNow] 已写入备份:', data.length, 'bytes');
    return true;
  } catch (e) {
    log.warn('[writeMetaBackupNow] 写入备份失败:', e?.message || e);
    return false;
  }
}

/**
 * 防抖调度备份写入。
 * 保存/取消保存/删除/点赞/回填 tags 后调用，高频操作只触发一次落盘。
 */
export function scheduleMetaBackup(delay = SCHEDULE_DELAY) {
  if (!isNative()) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    writeMetaBackupNow();
  }, delay);
}

/** 已有数据但还没有备份文件 → 立即补一份（升级后无需等下一次点赞/保存） */
export async function ensureMetaBackup() {
  const saver = getSaver();
  if (!isNative() || !saver?.readMeta) return false;
  try {
    const r = await saver.readMeta({ fileName: BACKUP_FILE });
    if (r?.data) return true; // 已有备份，跳过
    return await writeMetaBackupNow();
  } catch (e) {
    log.warn('[ensureMetaBackup] 检查备份失败:', e?.message || e);
    return false;
  }
}

/**
 * 重装后 IndexedDB 为空 → 从系统备份恢复「喜欢/已保存 + cookie」。
 * 本地已有数据时不覆盖，避免误清用户当前状态。
 */
export async function restoreMetaBackupIfNeeded() {
  const saver = getSaver();
  if (!isNative() || !saver?.readMeta) return false;
  try {
    const existing = await getAllMeta();
    if (Array.isArray(existing) && existing.length > 0) return false;

    const r = await saver.readMeta({ fileName: BACKUP_FILE });
    if (!r?.data) return false;

    let payload;
    try {
      payload = JSON.parse(r.data);
    } catch {
      log.warn('[restoreMetaBackupIfNeeded] 备份 JSON 解析失败，跳过');
      return false;
    }
    if (!payload || payload.version !== BACKUP_VERSION) return false;

    const records = Array.isArray(payload.entities) ? payload.entities : [];
    if (records.length > 0) {
      await putMetaBatch(records);
    }

    const cookie = payload.settings?.pixivCookie;
    if (cookie) {
      await saveSettings({ ...getSettingsSync(), pixivCookie: cookie });
    }

    log.info('[restoreMetaBackupIfNeeded] 已恢复:', records.length, '条记录');
    return true;
  } catch (e) {
    log.warn('[restoreMetaBackupIfNeeded] 恢复备份失败:', e?.message || e);
    return false;
  }
}
