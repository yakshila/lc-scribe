// Service worker 入口(MV3)。
// 职责:装配消息监听、通知监听,委托给 coordinator 处理逻辑。
import { handleMessage, initCoordinator } from "./coordinator.js";
import { installNotificationListeners } from "./notification-manager.js";
import { logger } from "../utils.js";

// —— 消息路由:统一交给 coordinator ——
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((resp) => sendResponse({ ok: true, data: resp }))
    .catch((err) => {
      logger.error("sw", "handle error", err);
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
  return true; // 异步响应
});

// —— 通知点击/按钮监听 ——
installNotificationListeners();

// —— 安装/更新:打开选项页引导配置模型 ——
chrome.runtime.onInstalled.addListener((details) => {
  logger.info("sw", "installed/updated", details.reason);
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
  initCoordinator().catch((e) => logger.error("sw", "init", e));
});

// —— SW 唤醒时也要初始化(防止重启后 coordinator 未装配) ——
initCoordinator().catch((e) => logger.error("sw", "init on wake", e));

logger.info("sw", "service worker loaded");
