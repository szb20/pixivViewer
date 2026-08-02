import React from 'react';

/**
 * 通用页面标题栏 — 返回按钮 + 居中标题 + 可选右侧内容。
 * ChatHeader / CharStatePanel / SettingsPage 共用。
 */
export default function PageHeader({ title, subtitle, status, onBack, backTitle = '返回', children }) {
  return (
    <div className={`page-header${subtitle || status ? ' has-subtitle' : ''}`}>
      <div className="chat-header-char">
        <button className="chat-back-btn" onClick={onBack} title={backTitle} aria-label="返回" />
        <div className="header-title-wrap">
          <span className="header-title chat-header-name">{title}</span>
          {subtitle && <span className="header-subtitle">{subtitle}</span>}
          {status && <span className="header-status">{status}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}