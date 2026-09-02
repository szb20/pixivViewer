/**
 * 系统相册导出 — 通过原生 GallerySaver 插件走 MediaStore（无需存储权限）。
 * 尽力而为：失败只记日志，不影响应用内保存主流程。
 *
 * 桌面（Electron 壳）：无 MediaStore，改由 window.desktopProxy.saveFile 弹系统
 * 保存对话框写文件（main 进程 IPC），保持 FileStore/gif.js 调用点不变。
 */
import { Capacitor } from '@capacitor/core';
import { createLogger } from '../../utils/logger.js';
import { getGallerySaver } from '../../utils/platform.js';

const log = createLogger('gallery');

const MIME_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function mimeFor(fileName) {
  const ext = (fileName || '').split('.').pop()?.toLowerCase();
  return MIME_MAP[ext] || 'image/jpeg';
}

/** 桌面壳：electron/preload.cjs 注入的 window.desktopProxy */
function isDesktop() {
  return typeof window !== 'undefined' && !!window.desktopProxy;
}

/** 确保系统存储权限（Android ≤10 会弹系统申请框；10+ 直接放行） */
export async function ensureGalleryPermission() {
  try {
    const saver = Capacitor?.Plugins?.GallerySaver;
    if (!saver) return true;
    const r = await saver.ensurePermission();
    return r?.granted !== false;
  } catch (e) {
    log.warn('申请存储权限失败:', e?.message || e);
    return false;
  }
}

/** 确保读取相册权限（Android 13+ READ_MEDIA_IMAGES / 旧版 READ_EXTERNAL_STORAGE） */
export async function ensureGalleryReadPermission() {
  try {
    const saver = Capacitor?.Plugins?.GallerySaver;
    if (!saver) return true;
    const r = await saver.ensureReadPermission();
    return r?.granted !== false;
  } catch (e) {
    log.warn('申请相册读取权限失败:', e?.message || e);
    return false;
  }
}

/** 从系统相册按文件名读取图片（返回 base64，找不到返回 null） */
export async function loadFromGallery(fileName) {
  try {
    const saver = Capacitor?.Plugins?.GallerySaver;
    if (!saver || !fileName) return null;
    const granted = await ensureGalleryReadPermission();
    if (!granted) return null;
    const r = await saver.read({ fileName });
    return r?.data || null;
  } catch (e) {
    log.debug('读取相册失败:', e?.message || e);
    return null;
  }
}

/** 查询系统相册是否已存在同名文件（只查索引，不读内容，轻量） */
export async function galleryHasFile(fileName) {
  try {
    const saver = Capacitor?.Plugins?.GallerySaver;
    if (!saver || !fileName) return false;
    const r = await saver.exists({ fileName });
    return r?.exists === true;
  } catch (e) {
    log.debug('查询相册同名文件失败:', e?.message || e);
    return false;
  }
}

/** 导出到系统相册（MediaStore / Pictures/PixivViewer；桌面 = 保存对话框） */
export async function exportToGallery(data, fileName, mimeType = mimeFor(fileName)) {
  try {
    // 桌面壳：弹系统保存对话框写文件
    if (isDesktop()) {
      try {
        const ok = await window.desktopProxy.saveFile({ data, fileName, mimeType });
        if (!ok) log.warn('桌面保存被取消或失败:', fileName);
        return !!ok;
      } catch (e) {
        log.warn('桌面保存失败:', e?.message || e);
        return false;
      }
    }
    const saver = Capacitor?.Plugins?.GallerySaver;
    if (!saver) {
      log.debug('GallerySaver 插件不可用（非原生环境）');
      return false;
    }
    const granted = await ensureGalleryPermission();
    if (!granted) {
      log.warn('存储权限未授予，跳过相册导出');
      return false;
    }
    await saver.save({ data, fileName, mimeType });
    return true;
  } catch (e) {
    log.warn('导出系统相册失败:', e?.message || e);
    return false;
  }
}

/** 从系统相册删除副本（幂等） */
export async function deleteFromGallery(fileName) {
  try {
    const saver = Capacitor?.Plugins?.GallerySaver;
    if (!saver) return false;
    await saver.delete({ fileName });
    return true;
  } catch (e) {
    log.debug('删除相册副本失败:', e?.message || e);
    return false;
  }
}