// Content script 入口 —— 建立全局命名空间 + 小工具 + 各子模块编排。
// content scripts 之间共享同一个 isolated world,通过 window.LCC 通信。
(function () {
  if (window.LCC) return; // 防止重复注入
  const LCC = (window.LCC = {
    state: {
      currentSlug: null,
      currentProblemKey: null,
      sessionStartedAt: null,
      lastResult: null,
    },
    bg: null, // background 消息发送函数,各子模块复用
  });

  // —— 小工具(content script 专用,与 src/utils.js 保持语义一致) ——
  LCC.utils = {
    parseProblemSlug(url) {
      if (!url) return null;
      const m = String(url).match(/\/problems\/([^/?#]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    },
    problemKey(slug) {
      return `lc:${slug}`;
    },
    log(level, tag, ...args) {
      const prefix = `[LCC:${level}][${tag}]`;
      if (level === "error") console.error(prefix, ...args);
      else if (level === "warn") console.warn(prefix, ...args);
      else console.log(prefix, ...args);
    },
  };

  // —— 向 background 发消息(基于 chrome.runtime.sendMessage) ——
  LCC.bg = function sendMessage(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload, from: "content", ts: Date.now() }, (resp) => {
          if (chrome.runtime.lastError) {
            // 后台脚本可能未就绪,吞掉错误
            LCC.utils.log("debug", "bg", "sendMessage error:", chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        LCC.utils.log("warn", "bg", "sendMessage threw:", e);
        resolve(null);
      }
    });
  };

  // —— 主流程编排 ——
  LCC.start = function () {
    LCC.utils.log("info", "content", "LC Scribe content script started");
    // 1. 页面级 fetch 钩子(注入 page context)
    if (LCC.injectPageHook) LCC.injectPageHook();
    // 2. 监听 page context 的 postMessage
    window.addEventListener("message", LCC.onPageMessage);
    // 3. 题目识别 + 路由变化监听
    if (LCC.problemDetector) LCC.problemDetector.start();
    // 4. 计时器
    if (LCC.timerTracker) LCC.timerTracker.start();
    // 5. 提交监听(DOM 兜底)
    if (LCC.submissionWatcher) LCC.submissionWatcher.start();
  };

  // —— 来自 page context 的消息(主要是 fetch 拦截结果) ——
  LCC.onPageMessage = function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "lcc-page-hook") return;
    LCC.utils.log("debug", "content", "page msg:", data.type, data.detail);
    if (data.type === "SUBMIT_REQUEST" && LCC.submissionWatcher && LCC.submissionWatcher.onPageSubmitRequest) {
      LCC.submissionWatcher.onPageSubmitRequest(data.detail);
    } else if (data.type === "SUBMIT_RESULT" && LCC.submissionWatcher && LCC.submissionWatcher.onPageSubmitResult) {
      LCC.submissionWatcher.onPageSubmitResult(data.detail);
    }
  };

  // content_idle 时启动 —— 但必须延迟到所有同级 content script
  // (problem-detector / timer-tracker / submission-watcher) 执行完毕,
  // 否则 LCC.problemDetector 等尚未定义,detector 不会启动,currentSlug 永远为 null。
  // 同级脚本在同一 task 内同步顺序执行,setTimeout(0) 会在它们全部跑完后触发。
  function bootstrap() {
    if (LCC.problemDetector && LCC.timerTracker && LCC.submissionWatcher) {
      LCC.start();
    } else {
      setTimeout(bootstrap, 0);
    }
  }
  bootstrap();
})();
