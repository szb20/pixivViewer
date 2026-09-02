/**
 * PixivViewer 桌面壳 — preload。
 *
 * 通过 contextBridge 暴露极小的桌面桥（window.desktopProxy）：
 *   getPort()  → 内嵌代理服务实际端口（renderer 构建 API 基址）
 *   saveFile() → 弹系统保存对话框并写文件（替代 Android MediaStore）
 * sandbox: true 下仅用 ipcRenderer.invoke。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopProxy', {
  getPort: () => ipcRenderer.invoke('proxy:get-port'),
  saveFile: (payload) => ipcRenderer.invoke('dialog:save-file', payload),
});
