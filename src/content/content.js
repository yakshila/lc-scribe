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
      // 排除 /problems/<slug>/submissions/<id>/ 这种结果页 —— 它的 slug 段会被
      // 误匹配成 "submissions"。先尝试 /problems/<slug>/submissions/ 模式取第一个段。
      let m = String(url).match(/\/problems\/([^/?#]+)\/submissions\//);
      if (m) return decodeURIComponent(m[1]);
      // 普通题目页 /problems/<slug>/
      m = String(url).match(/\/problems\/([^/?#]+)/);
      // "submissions" 不是合法 slug(那是结果页路径段),排除
      if (m && m[1].toLowerCase() === "submissions") return null;
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
  // 检测 "Extension context invalidated"(插件被 reload 但页面没刷新),
  // 提示用户刷新页面,避免所有提交结果静默丢失。
  let contextInvalidated = false;
  let invalidatedWarnedAt = 0;
  LCC.bg = function sendMessage(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload, from: "content", ts: Date.now() }, (resp) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || "";
            if (/context invalidated/i.test(msg)) {
              contextInvalidated = true;
              // 每 30 秒只警告一次,避免刷屏
              const now = Date.now();
              if (now - invalidatedWarnedAt > 30000) {
                invalidatedWarnedAt = now;
                console.error("[LCC:error][bg] ⚠️ 插件已被重新加载,但本页面仍使用旧 content script。请刷新 LeetCode 页面,否则提交结果无法记录!当前消息丢失:", type);
              }
            } else {
              LCC.utils.log("debug", "bg", "sendMessage error:", msg);
            }
            resolve(null);
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        const msg = String(e && e.message || e);
        if (/context invalidated/i.test(msg)) {
          contextInvalidated = true;
          const now = Date.now();
          if (now - invalidatedWarnedAt > 30000) {
            invalidatedWarnedAt = now;
            console.error("[LCC:error][bg] ⚠️ 插件已被重新加载,但本页面仍使用旧 content script。请刷新 LeetCode 页面,否则提交结果无法记录!");
          }
        } else {
          LCC.utils.log("warn", "bg", "sendMessage threw:", e);
        }
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
    // 6. 监听 background 下发的指令(如 REFRESH_PROBLEM_META)
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === "REFRESH_PROBLEM_META") {
        const slug = (msg.payload && msg.payload.slug) || LCC.state.currentSlug;
        if (slug && LCC.leetcodeApi && LCC.leetcodeApi.fetchQuestion) {
          LCC.leetcodeApi.fetchQuestion(slug).then((problem) => {
            if (problem) LCC.bg("PROBLEM_META", { slug, problem });
            sendResponse({ ok: true, problem });
          }).catch((e) => {
            LCC.utils.log("warn", "content", "REFRESH_PROBLEM_META failed", e);
            sendResponse({ ok: false, error: String(e) });
          });
          return true; // 异步响应
        }
        sendResponse({ ok: false, error: "no slug or leetcodeApi" });
      } else if (msg.type === "SHOW_TOAST") {
        // background 通知系统失败时的兜底:在 LeetCode 页面内弹 toast
        showToast(msg.payload || {});
        sendResponse({ ok: true });
      }
    });
  };

  // —— 页面内 toast(系统通知失败时的兜底,确保用户能看到 AC 等关键提示) ——
  // 支持 id 复用 + 状态更新(loading/success/error/info/warn)+ sticky(常驻,等后续 update)
  // 用于"生成笔记"等耗时操作:点按钮后弹 loading toast,完成/失败时用同 id 更新内容。
  const toastElements = new Map(); // id -> element
  function ensureSpinnerStyle() {
    if (document.getElementById("lcc-toast-style")) return;
    const s = document.createElement("style");
    s.id = "lcc-toast-style";
    s.textContent = "@keyframes lcc-spin{to{transform:rotate(360deg)}}";
    document.documentElement.appendChild(s);
  }
  function removeToast(el, id) {
    if (!el) return;
    if (el._lccTimer) { clearTimeout(el._lccTimer); el._lccTimer = null; }
    if (id) toastElements.delete(id);
    el.style.opacity = "0";
    el.style.transform = "translateX(20px)";
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 300);
  }
  function showToast({ id, title, message, type = "info", state, duration = 6000, sticky = false, buttons }) {
    try {
      ensureSpinnerStyle();
      const colors = {
        success: { bg: "#1a3a2a", border: "#5CC863", icon: "✓" },
        info:    { bg: "#1a2a3a", border: "#4A90D9", icon: "i" },
        warn:    { bg: "#3a2a1a", border: "#FF9F43", icon: "!" },
        error:   { bg: "#3a1a1a", border: "#E74C3C", icon: "✕" },
        loading: { bg: "#1a2a3a", border: "#4A90D9", icon: "…" },
      };
      // state 优先于 type(新调用方用 state,旧调用方用 type,二者择一)
      const st = state || type;
      const c = colors[st] || colors.info;
      const isLoading = st === "loading";
      // loading 默认常驻(不自动消失),除非显式传 sticky=false
      const isSticky = isLoading ? (sticky !== false) : sticky;

      // 同 id 复用:更新现有 toast 内容,不重建元素(保留位置、不闪烁)
      let el;
      if (id && toastElements.has(id)) {
        el = toastElements.get(id);
        el.style.background = c.bg;
        el.style.borderColor = c.border;
      } else {
        el = document.createElement("div");
        el.style.cssText = [
          "position:fixed", "top:20px", "right:20px", "z-index:2147483647",
          "background:" + c.bg, "border:1px solid " + c.border, "border-radius:8px",
          "padding:12px 16px", "max-width:360px", "box-shadow:0 4px 20px rgba(0,0,0,0.4)",
          "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
          "color:#e8e8e8", "font-size:14px", "line-height:1.5",
          "display:flex", "gap:10px", "align-items:flex-start",
          "transition:opacity .3s, transform .3s", "opacity:0", "transform:translateX(20px)",
        ].join(";") + ";";
        if (id) toastElements.set(id, el);
        document.documentElement.appendChild(el);
        requestAnimationFrame(() => {
          el.style.opacity = "1";
          el.style.transform = "translateX(0)";
        });
      }

      // 图标:loading 用 CSS spinner,其他用字符
      const iconHtml = isLoading
        ? '<div style="flex-shrink:0;width:16px;height:16px;margin-top:2px;border:2px solid ' + c.border + ';border-top-color:transparent;border-radius:50%;animation:lcc-spin .8s linear infinite"></div>'
        : '<div style="color:' + c.border + ';font-weight:bold;font-size:16px;flex-shrink:0">' + c.icon + '</div>';

      let html = iconHtml
        + '<div style="flex:1"><div style="font-weight:600;margin-bottom:2px">' + escapeHtml(title || "LC Scribe") + '</div>'
        + (message ? '<div style="opacity:.85;font-size:13px;margin-bottom:8px">' + escapeHtml(message) + '</div>' : '');
      // 按钮(最多2个,模拟系统通知的 buttons 行为)
      if (Array.isArray(buttons) && buttons.length) {
        html += '<div style="display:flex;gap:8px;margin-top:4px">';
        buttons.slice(0, 2).forEach((b, i) => {
          const primary = i === 0;
          const btnBg = primary ? c.border : "transparent";
          const btnColor = primary ? "#1a1a1a" : c.border;
          // 注意:不能用 inline onmouseover/onmouseout,LeetCode CSP 会拦截 inline 事件处理器
          html += '<button data-lcc-btn-idx="' + i + '" style="'
            + 'background:' + btnBg + ';color:' + btnColor + ';'
            + 'border:1px solid ' + c.border + ';border-radius:5px;'
            + 'padding:5px 12px;font-size:13px;font-weight:600;cursor:pointer;'
            + 'font-family:inherit;transition:opacity .15s">'
            + escapeHtml(b.title || "按钮") + '</button>';
        });
        html += '</div>';
      }
      html += '</div>';
      el.innerHTML = html;

      // 绑定按钮事件:click 触发 action + hover 效果(用 addEventListener,避免被 CSP 拦截)
      if (Array.isArray(buttons) && buttons.length) {
        el.querySelectorAll("button[data-lcc-btn-idx]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const idx = Number(btn.getAttribute("data-lcc-btn-idx"));
            const b = buttons[idx];
            if (b && b.action) {
              // 告诉 background 执行这个 action(如 generate-note / view-note)
              LCC.bg("TOAST_BUTTON", { action: b.action, problemKey: b.problemKey, noteId: b.noteId });
            }
            // 点击后立即关闭 toast(查看笔记按钮也关,因为会跳转到笔记页)
            removeToast(el, id);
          });
          btn.addEventListener("mouseover", () => { btn.style.opacity = "0.85"; });
          btn.addEventListener("mouseout", () => { btn.style.opacity = "1"; });
        });
      }

      // 自动消失:非 sticky 时设定时器。更新时先清除旧定时器(避免旧定时器提前关掉更新后的 toast)。
      if (el._lccTimer) { clearTimeout(el._lccTimer); el._lccTimer = null; }
      if (!isSticky) {
        el._lccTimer = setTimeout(() => removeToast(el, id), duration);
      }
    } catch (e) {
      LCC.utils.log("warn", "content", "showToast failed", e);
    }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

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
