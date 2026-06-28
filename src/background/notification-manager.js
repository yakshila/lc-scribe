// 通知管理:封装 chrome.notifications,统一 id 生成、点击路由、按钮回调。
import { logger } from "../utils.js";

const NOTIF_ID_PREFIX = "lcc-notif-";

// 等待中的按钮回调:notificationId -> { action -> handler }
const pendingActions = new Map();

export async function notify({ id, title, message, iconUrl, buttons, onClick, onButton }) {
  const notifId = id || NOTIF_ID_PREFIX + Date.now();
  const btns = (buttons || []).slice(0, 2).map((b) => ({ title: b.title }));
  const opts = {
    type: "basic",
    iconUrl: iconUrl || "icons/icon128.png",
    title: title || "LC Scribe",
    message: message || "",
    priority: 2,
    requireInteraction: !buttons, // 带按钮的需交互,让用户能点
  };
  if (btns.length) opts.buttons = btns;

  // 记录回调
  pendingActions.set(notifId, { onClick, onButton, buttons });

  return new Promise((resolve) => {
    chrome.notifications.create(notifId, opts, (createdId) => {
      if (chrome.runtime.lastError) {
        // icon 加载失败时,用内联 data URI 兜底(1x1 紫色 PNG),确保通知能弹出
        const fallbackIcon =
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwAEhwH/yfeMqgAAAABJRU5ErkJggg==";
        if (/image|icon/i.test(chrome.runtime.lastError.message)) {
          logger.warn("notif", "icon failed, retry with fallback:", chrome.runtime.lastError.message);
          const retryOpts = { ...opts, iconUrl: fallbackIcon };
          chrome.notifications.create(notifId, retryOpts, (id2) => {
            if (chrome.runtime.lastError) {
              logger.warn("notif", "create error (retry also failed):", chrome.runtime.lastError.message);
            }
            resolve(id2);
          });
        } else {
          logger.warn("notif", "create error:", chrome.runtime.lastError.message);
        }
      } else {
        resolve(createdId);
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
