export const APP_SHELL_HTML = `
<div class="mc-app-shell">
  <section class="mc-size-guard" aria-live="polite">
    <div class="mc-size-guard-card">
      <h2 class="mc-size-guard-title"></h2>
      <p class="mc-size-guard-body"></p>
    </div>
  </section>
  <section id="view-auth" class="view">
    <div class="auth-card">
      <h1>yimsg</h1>
      <div class="tabs">
        <button class="tab active" data-tab="login">登录</button>
        <button class="tab" data-tab="register">注册</button>
      </div>
      <form id="login-form" class="auth-form" autocomplete="on">
        <input class="input" type="text" id="login-username" placeholder="用户名" autocomplete="username" required>
        <input class="input" type="password" id="login-password" placeholder="密码" autocomplete="current-password" required>
        <button type="submit" class="btn btn-primary btn-block">登录</button>
      </form>
      <form id="register-form" class="auth-form hidden" autocomplete="on">
        <input class="input" type="text" id="reg-username" placeholder="用户名" autocomplete="username" required>
        <input class="input" type="password" id="reg-password" placeholder="密码" autocomplete="new-password" required>
        <input class="input" type="text" id="reg-nickname" placeholder="昵称" required>
        <button type="submit" class="btn btn-primary btn-block">注册</button>
      </form>
      <div id="auth-error" class="error-text"></div>
    </div>
  </section>

  <div id="app" class="hidden">
    <nav id="navbar">
      <div class="nav-item active" data-view="chat" title="聊天">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <div class="nav-item" data-view="contacts" title="联系人">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      </div>
      <div class="nav-spacer"></div>
      <div class="nav-item" data-view="settings" title="设置">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </div>
    </nav>

    <div id="main-content">
      <section id="view-chat" class="view">
        <div id="left-panel">
          <div id="left-panel-header">
            <div id="status-bar" class="status-bar hidden"></div>
          </div>
          <div id="conversation-list"></div>
        </div>
        <div id="center-panel">
          <div id="chat-header" class="hidden">
            <h2 id="chat-title"></h2>
            <div class="chat-header-actions">
              <button id="toggle-detail" class="icon-btn" title="详情">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="16" x2="12" y2="12"/>
                  <line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
              </button>
            </div>
          </div>
          <div id="chat-empty" class="empty-state">选择一个会话开始聊天</div>
          <div id="message-list"></div>
          <div id="message-input-area" class="hidden">
            <div class="message-input-row">
              <button class="icon-btn" id="msg-attach" title="附件">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="16"/>
                  <line x1="8" y1="12" x2="16" y2="12"/>
                </svg>
              </button>
              <button class="icon-btn" id="msg-emoji" title="表情">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
                  <line x1="9" y1="9" x2="9.01" y2="9"/>
                  <line x1="15" y1="9" x2="15.01" y2="9"/>
                </svg>
              </button>
              <input class="input" type="text" id="msg-input" placeholder="输入消息...">
              <button class="btn btn-primary" id="msg-send">发送</button>
            </div>
            <input type="file" id="file-picker-image" accept="image/jpeg,image/png,image/gif,image/webp" class="hidden">
            <input type="file" id="file-picker-file" accept="*/*" class="hidden">
          </div>
        </div>
        <div id="right-panel" class="collapsed">
          <button class="detail-mobile-back" id="detail-mobile-back">← 返回</button>
          <div id="detail-panel"></div>
        </div>
      </section>

      <section id="view-contacts" class="view hidden">
        <div class="contacts-left">
          <div class="tabs contacts-tabs">
            <button class="tab active" data-ctab="friends">好友</button>
            <button class="tab" data-ctab="requests">请求</button>
            <button class="tab" data-ctab="search">搜索</button>
          </div>
          <div class="contacts-content">
            <div id="friends-tab"></div>
            <div id="requests-tab" class="hidden">
              <div id="requests-outgoing" class="hidden"></div>
              <div id="requests-incoming"></div>
            </div>
            <div id="search-tab" class="hidden">
              <div class="search-row">
                <input class="input" type="text" id="search-username" placeholder="输入用户名...">
                <button class="btn btn-primary" id="search-btn">搜索</button>
              </div>
              <div id="search-results"></div>
            </div>
          </div>
          <div class="contacts-footer">
            <button class="btn btn-primary btn-block" id="create-group-btn">创建群组</button>
          </div>
        </div>
        <div id="contacts-resizer" class="contacts-resizer" role="separator" aria-orientation="vertical" aria-label="Resize contacts panel"></div>
        <div id="contacts-detail-panel" class="contacts-right"></div>
      </section>

      <section id="view-settings" class="view hidden">
        <div class="settings-page">
          <div class="settings-header">
            <div class="avatar avatar-lg avatar-clickable" id="settings-avatar" title="点击更换头像"></div>
            <input type="file" id="avatar-picker" accept="image/jpeg,image/png,image/webp" class="hidden">
            <h2 id="settings-nickname"></h2>
            <p id="settings-uid"></p>
            <p id="settings-mode"></p>
          </div>
          <div class="settings-card">
            <h3 id="settings-profile-title">个人资料</h3>
            <input class="input" type="text" id="edit-nickname" placeholder="昵称">
            <button class="btn btn-primary btn-block" id="save-profile-btn">保存</button>
          </div>
          <div class="settings-card">
            <h3 id="settings-password-title">密码</h3>
            <input class="input" type="password" id="old-password" placeholder="旧密码">
            <input class="input" type="password" id="new-password" placeholder="新密码">
            <button class="btn btn-primary btn-block" id="change-pwd-btn">修改</button>
          </div>
          <div class="settings-card">
            <h3 id="settings-language-title">语言</h3>
            <div class="lang-select">
              <button class="btn btn-secondary" id="lang-zh-btn">中文</button>
              <button class="btn btn-secondary" id="lang-en-btn">English</button>
            </div>
          </div>
          <div class="settings-card hidden" id="settings-storage-card">
            <h3 id="settings-storage-title">存储</h3>
            <p id="settings-storage-desc" class="settings-card-desc"></p>
            <button class="btn btn-secondary btn-block" id="clear-data-btn">清除数据</button>
          </div>
          <button class="btn btn-danger btn-block" id="logout-btn">退出登录</button>
        </div>
      </section>
    </div>
  </div>
  <div id="modal-overlay" class="modal-overlay hidden">
    <div id="modal-content" class="modal-content"></div>
  </div>

  <div id="toast-container" class="toast-container"></div>
</div>
`;

export function rewriteAppStylesForShadow(appCss: string): string {
  const shadowCss = appCss
    .replace(/:root/g, '.mc-app-shell')
    .replace(/html,body/g, '.mc-app-shell')
    .replace(/body\[data-layout="([^"]+)"\]/g, '.mc-app-shell[data-layout="$1"]')
    .replace(/\bbody\b/g, '.mc-app-shell')
    .replace(/\bhtml\b/g, '.mc-app-shell');

  return `${shadowCss}

.mc-app-shell {
  height: 100%;
  min-height: 0;
}

.mc-app-shell .mc-size-guard {
  display: none;
  height: 100%;
  min-height: 100%;
  padding: 16px;
  align-items: center;
  justify-content: center;
  background: var(--bg-page);
}

.mc-app-shell .mc-size-guard-card {
  width: min(100%, 320px);
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-panel);
  box-shadow: var(--shadow-md);
  text-align: center;
}

.mc-app-shell .mc-size-guard-title {
  font-size: 18px;
  line-height: 24px;
  margin-bottom: 8px;
}

.mc-app-shell .mc-size-guard-body {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 20px;
}

.mc-app-shell[data-size-state="too-small"] > :not(.mc-size-guard) {
  display: none !important;
}

.mc-app-shell[data-size-state="too-small"] .mc-size-guard {
  display: flex;
}

.mc-app-shell #app {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: 100%;
  margin: 0;
  border: none;
  border-radius: 0;
  box-shadow: none;
}

.mc-app-shell #view-auth {
  height: 100%;
  min-height: 100%;
  padding: 12px;
  overflow: auto;
}

.mc-app-shell .auth-card {
  width: min(100%, 360px);
  max-width: 100%;
  padding: var(--space-xl) var(--space-xl) var(--space-lg);
}

.mc-app-shell .auth-card h1 {
  font-size: 22px;
  margin-bottom: var(--space-lg);
}

.mc-app-shell .auth-form {
  gap: var(--space-sm);
}

.mc-app-shell .auth-form .input,
.mc-app-shell .auth-form .btn {
  height: 40px;
}

.mc-app-shell .auth-form .btn {
  margin-top: 0;
}

.mc-app-shell[data-layout="mobile"] #app {
  height: 100%;
  min-height: 100%;
  max-width: 100%;
}

.mc-app-shell[data-layout="mobile"] #view-auth {
  height: 100%;
  min-height: 100%;
  padding: 12px;
}

.mc-app-shell[data-layout="mobile"] .auth-card {
  width: min(100%, 360px);
  max-width: 100%;
  min-height: 0;
  border-radius: 12px;
  box-shadow: var(--shadow-lg);
  padding: var(--space-xl);
}

@media (min-width: 1280px) {
  .mc-app-shell #app {
    height: 100%;
    max-height: 100%;
    margin: 0;
    border: none;
    border-radius: 0;
    box-shadow: none;
  }
}
`;
}
