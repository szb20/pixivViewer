import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './api/index.js'
import App from './App.jsx'
import { createLogger } from './utils/logger.js'

// 设置透明状态栏 + 白色文字/图标（适配深色背景）
import { StatusBar, Style } from '@capacitor/status-bar'
StatusBar.setStyle({ style: Style.Light })
StatusBar.setOverlaysWebView({ overlay: true })

const log = createLogger('global')

// 全局兜底：未捕获异常 / 未处理的 Promise rejection 至少留痕，便于排查
window.addEventListener('error', (e) => {
  log.warn('window error:', e?.message || e?.error || e)
})
window.addEventListener('unhandledrejection', (e) => {
  log.warn('unhandledrejection:', e?.reason || e)
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
