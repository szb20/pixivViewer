/**
 * PixivViewer 桌面壳 — preload。
 *
 * 通过 contextBridge 暴露两个极小的桥：
 *   window.desktopProxy — getPort() / saveFile() / chooseDirectory()
 *   window.desktop      — platform + download（流式下载，带真实字节进度）
 * sandbox: true 下仅用 ipcRenderer.invoke / on。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopProxy', {
  getPort: () => ipcRenderer.invoke('proxy:get-port'),
  saveFile: (payload) => ipcRenderer.invoke('dialog:save-file', payload),
  chooseDirectory: () => ipcRenderer.invoke('dialog:choose-directory'),
});

// 进度监听要做「订阅—退订」配对，而 ipcRenderer.on 包一层后拿不到原始函数，
// 这里用一张表把调用方的回调映射到实际注册的监听器。
const progressHandlers = new Map();

contextBridge.exposeInMainWorld('desktop', {
  platform: 'electron',
  download: {
    image: (payload) => ipcRenderer.invoke('download:image', payload),
    onProgress: (cb) => {
      if (progressHandlers.has(cb)) return;
      const wrapped = (_event, data) => cb(data);
      progressHandlers.set(cb, wrapped);
      ipcRenderer.on('download:progress', wrapped);
    },
    offProgress: (cb) => {
      const wrapped = progressHandlers.get(cb);
      if (!wrapped) return;
      ipcRenderer.removeListener('download:progress', wrapped);
      progressHandlers.delete(cb);
    },
  },
});