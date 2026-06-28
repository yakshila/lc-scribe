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

  function reportResult({ status, statusMsg, runtime, memory, code, lang, langSlug, submissionId, fromDOM }) {
    const slug = LCC.state.currentSlug;
    const problemKey = LCC.state.currentProblemKey;
    if (!slug || !problemKey) {
      LCC.utils.log("warn", "submit", "reportResult bailed: slug not set (detector 未识别题目). url=", location.href, "slug=", slug);
      return;
    }
    // 合并 pendingSubmit 中的 code/lang(如果当前 report 缺失)
    const mergedCode = code || (pendingSubmit && pendingSubmit.code) || "";
    const mergedLang = lang || langSlug || (pendingSubmit && pendingSubmit.lang) || "";
    LCC.utils.log("info", "submit", "reportResult:", status, "| slug=", slug, "| fromDOM=", !!fromDOM, "| hasCode=", !!mergedCode, "| hasLang=", !!mergedLang, "| pendingSubmit=", !!pendingSubmit, "| accepted=", /accepted|解答成功|通过/i.test(status + " " + (statusMsg || "")));

    const isAccepted = /accepted|解答成功|通过/i.test(status + " " + (statusMsg || ""));
    LCC.bg("SUBMISSION_RESULT", {
      slug,
      problemKey,
      status,
      statusMsg: statusMsg || status,
      runtime,
      memory,
      code: mergedCode,
      lang: mergedLang,
      submissionId: submissionId || null,
      accepted: isAccepted,
      ts: Date.now(),
    });
    // 只在拿到完整数据(page-hook 路径,有 submissionId 或 runtime)时才清 pendingSubmit,
    // DOM 兜底报告不清,留给后续 page-hook 补充 code/lang
    if (!fromDOM) {
      pendingSubmit = null;
    }
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
      // page-hook 现由 manifest 以 world:MAIN + document_start 注入,无需手动注入
      LCC.utils.log("info", "submit", "submission-watcher started (page-hook via manifest world:MAIN)");
      observeResultDOM();
    },
  };

  // —— 注入 page context 钩子(已废弃,改由 manifest world:MAIN 注入;保留为兜底) ——
  function injectPageHook() {
    if (window.__LCC_PAGE_HOOK__) return; // manifest 已注入
    try {
      const url = chrome.runtime.getURL("src/content/page-hook.js");
      const s = document.createElement("script");
      s.src = url;
      s.async = false;
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
      LCC.utils.log("info", "submit", "page-hook injected (fallback script-tag)");
    } catch (e) {
      LCC.utils.log("error", "submit", "inject page-hook failed", e);
    }
  }

  // —— DOM 兜底:监听结果文本 ——
  // 注意:不能用全文扫描找 "Accepted",因为题目页统计区本身就有 "Accepted: 1.2M" 字样,
  // 会在页面加载时误触发。只用结果容器选择器 + 短文本匹配。
  let lastDomReportTs = 0;
  let lastDomReportStatus = null;
  function observeResultDOM() {
    const STATUS_PATTERNS = [
      { re: /accepted|解答成功/i, status: "Accepted" },
      { re: /wrong\s*answer|解答失败|答案错误/i, status: "Wrong Answer" },
      { re: /compile\s*error|编译错误|编译失败/i, status: "Compile Error" },
      { re: /runtime\s*error|执行出错|运行错误/i, status: "Runtime Error" },
      { re: /time\s*limit|超时/i, status: "Time Limit Exceeded" },
      { re: /memory\s*limit|内存超限/i, status: "Memory Limit Exceeded" },
    ];
    const mo = new MutationObserver(() => {
      // 只看结果容器内的文本(避免命中题目统计区的 "Accepted: 1.2M")
      const sels = [
        "[data-e2e='submission-result']",
        "[data-e2e='run-code-result']",
        ".success__3Ai7g",
        ".error__2ixPJ",
        ".result-container",
        ".submission-wrapper",
        "#result",
        "[class*='submission-result']",
        "[class*='run-result']",
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
      const text = (node.textContent || "").slice(0, 300);
      for (const p of STATUS_PATTERNS) {
        if (p.re.test(text)) {
          // 去重:同状态 3 秒内不重复报
          const now = Date.now();
          if (p.status === lastDomReportStatus && now - lastDomReportTs < 3000) return;
          lastDomReportStatus = p.status;
          lastDomReportTs = now;
          LCC.utils.log("info", "submit", "DOM observer detected:", p.status, "| text=", text.slice(0, 80));
          reportResult({ status: p.status, statusMsg: p.status + " (dom)", fromDOM: true });
          return;
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(() => mo.disconnect(), 10 * 60 * 1000);
  }
})();
