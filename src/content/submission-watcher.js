// 提交监听:两条路径互补,确保捕获到提交的代码、语言与结果。
//  1) page-hook.js 在 page context 包裹 fetch,捕获 submit 请求体(typedCode/lang)
//     与 result 响应(status_msg/runtime/memory)。通过 postMessage 回传。
//  2) DOM MutationObserver 兜底监听结果面板文本("Accepted"/"解答成功" 等)。
(function () {
  const LCC = window.LCC;
  if (!LCC) return;

  // 当前提交的"代码+语言"上下文(由 page-hook 的 SUBMIT_REQUEST 设置,等 result 时合并)
  let pendingSubmit = null; // { code, lang, questionId, ts }

  // 已上报的 submission 结果去重(同一次提交 result 响应 + DOM 可能都触发)
  let lastReportedKey = null;

  function reportResult({ status, statusMsg, runtime, memory, code, lang, langSlug, submissionId }) {
    const slug = LCC.state.currentSlug;
    const problemKey = LCC.state.currentProblemKey;
    if (!slug || !problemKey) return;
    const key = `${problemKey}:${submissionId || ""}:${status}:${Date.now().toString().slice(0, -3)}`;
    // 同秒内同状态去重
    if (lastReportedKey && lastReportedKey.startsWith(`${problemKey}:${submissionId || ""}:${status}:`)) {
      // 允许覆盖以补充 code/lang
    }
    lastReportedKey = key;

    const isAccepted = /accepted|解答成功|通过/i.test(status + " " + (statusMsg || ""));
    LCC.bg("SUBMISSION_RESULT", {
      slug,
      problemKey,
      status,
      statusMsg: statusMsg || status,
      runtime,
      memory,
      code: code || (pendingSubmit && pendingSubmit.code) || "",
      lang: lang || langSlug || (pendingSubmit && pendingSubmit.lang) || "",
      submissionId: submissionId || null,
      accepted: isAccepted,
      ts: Date.now(),
    });
    pendingSubmit = null;
  }

  // —— page-hook 回调 ——
  LCC.submissionWatcher = {
    onPageSubmitRequest(detail) {
      // 记录代码上下文,等 result 响应到来时合并
      pendingSubmit = {
        code: detail.typedCode || detail.code || "",
        lang: detail.lang || detail.langSlug || "",
        questionId: detail.questionId || null,
        ts: Date.now(),
      };
      LCC.utils.log("info", "submit", "submit request captured, lang=", pendingSubmit.lang, "codeLen=", pendingSubmit.code.length);
    },
    onPageSubmitResult(detail) {
      reportResult({
        status: detail.status,
        statusMsg: detail.statusMsg || detail.status,
        runtime: detail.runtime,
        memory: detail.memory,
        submissionId: detail.submissionId,
        code: pendingSubmit && pendingSubmit.code,
        lang: pendingSubmit && pendingSubmit.lang,
      });
    },
    start() {
      injectPageHook();
      observeResultDOM();
    },
  };

  // —— 注入 page context 钩子 ——
  function injectPageHook() {
    try {
      const url = chrome.runtime.getURL("src/content/page-hook.js");
      const s = document.createElement("script");
      s.src = url;
      s.async = false;
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
      LCC.utils.log("info", "submit", "page-hook injected");
    } catch (e) {
      LCC.utils.log("error", "submit", "inject page-hook failed", e);
    }
  }

  // —— DOM 兜底:监听结果文本 ——
  function observeResultDOM() {
    const ACCEPT_RE = /accepted|解答成功|通过/i;
    const WA_RE = /wrong answer|解答失败|错误/i;
    const mo = new MutationObserver(() => {
      // 多种可能的选择器(leetcode.cn 不同版本)
      const sels = [
        "[data-e2e='submission-result']",
        ".success__3Ai7g",
        ".error__2ixPJ",
        ".result-container",
        ".submission-wrapper",
        "#result",
      ];
      let node = null;
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.textContent && el.textContent.trim().length > 0) {
          node = el;
          break;
        }
      }
      if (!node) return;
      const text = node.textContent || "";
      if (ACCEPT_RE.test(text)) {
        reportResult({ status: "Accepted", statusMsg: "Accepted (dom)" });
      } else if (WA_RE.test(text)) {
        // 解析可能的细节(runtime/memory 通常 DOM 不全,留给 page-hook 补充)
        reportResult({ status: "Wrong Answer", statusMsg: text.slice(0, 120) });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    // 5 分钟后停止观察(避免长期开销)
    setTimeout(() => mo.disconnect(), 5 * 60 * 1000);
  }
})();
