// 通知管理:封装 chrome.notifications,统一 id 生成、点击路由、按钮回调。
import { logger } from "../utils.js";

const NOTIF_ID_PREFIX = "lcc-notif-";

// 等待中的按钮回调:notificationId -> { action -> handler }
const pendingActions = new Map();

export async function notify({ id, title, message, iconUrl, buttons, onClick, onButton }) {
  const notifId = id || NOTIF_ID_PREFIX + Date.now();
  const btns = (buttons || []).slice(0, 2).map((b) => ({ title: b.title }));
  // MV3:iconUrl 用相对路径(相对 manifest 根),notifications 系统会解析为扩展内资源。
  // 不要用 chrome.runtime.getURL() 绝对 URL,某些 Chrome 版本会报 "Unable to download"。
  // 不要用 data URI,notifications 系统不接受。
  const opts = {
    type: "basic",
    iconUrl: "icons/icon48.png",
    title: title || "LC Scribe",
    message: message || "",
    priority: 2,
    requireInteraction: false,
  };
  if (btns.length) {
    opts.buttons = btns;
    // 带按钮的通知用更长的显示时间,但不用 requireInteraction(它有时导致渲染问题)
  }

  // 记录回调
  pendingActions.set(notifId, { onClick, onButton, buttons });

  return new Promise((resolve) => {
    chrome.notifications.create(notifId, opts, (createdId) => {
      if (chrome.runtime.lastError) {
        logger.warn("notif", "create error:", chrome.runtime.lastError.message);
        resolve({ ok: false, id: null });
      } else {
        resolve({ ok: true, id: createdId });
      }
    });
  });
}

export function clearNotification(id) {
  pendingActions.delete(id);
  return new Promise((r) => chrome.notifications.clear(id, r));
}

export function installNotificationListeners() {
  chrome.notifications.onClicked.addListener((notifId) => {
    const entry = pendingActions.get(notifId);
    if (entry && entry.onClick) {
      try { entry.onClick(); } catch (e) { logger.error("notif", "onClick handler error", e); }
    }
    clearNotification(notifId);
  });
  chrome.notifications.onButtonClicked.addListener((notifId, buttonIndex) => {
    const entry = pendingActions.get(notifId);
    if (entry && entry.onButton && entry.buttons && entry.buttons[buttonIndex]) {
      try { entry.onButton(entry.buttons[buttonIndex].action, buttonIndex); } catch (e) { logger.error("notif", "onButton error", e); }
    }
    clearNotification(notifId);
  });
  chrome.notifications.onClosed.addListener((notifId) => {
    pendingActions.delete(notifId);
  });
}
