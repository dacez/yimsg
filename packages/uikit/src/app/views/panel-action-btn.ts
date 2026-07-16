// 图标式操作按钮：联系人详情页和聊天右侧详情面板共用

export const SVG_CHAT = `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`;
export const SVG_REMARK = `<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>`;
export const SVG_BELL = `<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>`;
export const SVG_BELL_OFF = SVG_BELL + `<line x1="1" y1="1" x2="23" y2="23"/>`;
export const SVG_BAN = `<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>`;
export const SVG_TRASH = `<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>`;
export const SVG_STAR = `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`;
export const SVG_STAR_FILLED = `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor"/>`;

/** 生成单个图标操作按钮的 HTML 字符串 */
export function panelActionBtn(svgPaths: string, iconClass: string, label: string, action: string): string {
  return `<button class="panel-action-btn" data-action="${action}">
    <div class="panel-action-icon ${iconClass}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgPaths}</svg></div>
    <span class="panel-action-label">${label}</span>
  </button>`;
}
