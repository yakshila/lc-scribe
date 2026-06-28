// 题目识别:监听 URL 变化(SPA 路由),识别当前题目,通知 background。
// leetcode.cn 是 SPA,需要 hook history.pushState/replaceState + popstate。
(function () {
  const LCC = window.LCC;
  if (!LCC) return;

  let lastSlug = null;

  function detect() {
    const slug = LCC.utils.parseProblemSlug(location.href);
    if (slug === lastSlug) return;
    lastSlug = slug;
    if (!slug) {
      LCC.state.currentSlug = null;
      LCC.state.currentProblemKey = null;
      return;
    }
    LCC.state.currentSlug = slug;
    LCC.state.currentProblemKey = LCC.utils.problemKey(slug);
    LCC.utils.log("info", "detector", "problem entered:", slug);
    handleProblemEntered(slug);
  }

  async function handleProblemEntered(slug) {
    // 1. 优先从页面全局快速读
    let problem = null;
    try {
      problem = LCC.leetcodeApi.readFromPageGlobal(slug);
    } catch (e) {
      LCC.utils.log("warn", "detector", "page global read failed", e);
    }
    // 2. 告知 background 进入题目(无论是否拿到元数据,先开始计时)
    LCC.bg("PROBLEM_ENTERED", {
      slug,
      problemKey: LCC.utils.problemKey(slug),
      url: location.href,
      problem: problem || null,
    });
    // 3. 后台异步补全题目元数据(GQL)
    if (!problem && LCC.leetcodeApi) {
      try {
        const full = await LCC.leetcodeApi.fetchQuestion(slug);
        if (full) {
          LCC.bg("PROBLEM_META", { slug, problem: full });
        }
      } catch (e) {
        LCC.utils.log("warn", "detector", "fetchQuestion failed", e);
      }
    }
  }

  // —— SPA 路由 hook ——
  function wrapHistoryMethod(method) {
    const orig = history[method];
    history[method] = function (...args) {
      const ret = orig.apply(this, args);
      // 异步等待 SPA 渲染
      setTimeout(detect, 300);
      setTimeout(detect, 1200);
      return ret;
    };
  }

  LCC.problemDetector = {
    start() {
      wrapHistoryMethod("pushState");
      wrapHistoryMethod("replaceState");
      window.addEventListener("popstate", () => setTimeout(detect, 300));
      // 初始检测
      setTimeout(detect, 400);
      setTimeout(detect, 1500); // SPA 首屏较慢,二次兜底
    },
    detect,
  };
})();
