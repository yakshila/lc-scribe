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

  // 页面重新可见(切浏览器 tab 回来 / 最小化恢复)时重新检测。
  // SPA 切 tab 不一定触发 history 事件,且页面隐藏期间 SPA 可能已换题。
  function onVisible() {
    if (document.hidden) return;
    // 短延迟,等 SPA 在重新可见后完成可能的渲染
    setTimeout(detect, 150);
    setTimeout(detect, 800);
  }

  async function handleProblemEntered(slug) {
    // 1. 优先从页面全局快速读
    let problem = null;
    try {
      problem = LCC.leetcodeApi.readFromPageGlobal(slug);
    } catch (e) {
      LCC.utils.log("warn", "detector", "page global read failed", e);
    }
    // 1b. 兜底:从页面 DOM 读题目标题和编号(轻量,不依赖 GQL)
    if (!problem) {
      problem = readFromDOM(slug);
    }
    // 2. 告知 background 进入题目(无论是否拿到元数据,先开始计时)
    LCC.bg("PROBLEM_ENTERED", {
      slug,
      problemKey: LCC.utils.problemKey(slug),
      url: location.href,
      problem: problem || null,
    });
    // 3. 后台异步补全/完善题目元数据(GQL)。即使 DOM 兜底给了 partial 数据,也尝试拉全量。
    if (LCC.leetcodeApi && (!problem || problem.partial)) {
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

  // 从 DOM 读题目标题/编号,作为 GQL 失败时的兜底元数据。
  // 不指望拿到 tags/difficulty 等完整字段,只要能让笔记骨架建立即可。
  function readFromDOM(slug) {
    try {
      const titleEl = document.querySelector("h1, [data-cy='question-title'], .css-v3d350, .title__Nq0YI");
      const title = titleEl ? titleEl.textContent.trim() : slug;
      return {
        problemId: 0,
        titleSlug: slug,
        title,
        difficulty: "Unknown",
        tags: [],
        isPaid: false,
        url: `https://leetcode.cn/problems/${slug}/`,
        related: [],
        fetchedAt: new Date().toISOString(),
        key: `lc:${slug}`,
        partial: true, // 标记元数据不完整
      };
    } catch (e) {
      return null;
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
      // 切浏览器 tab 回来 / 最小化恢复:重新检测题目(SPA 可能在隐藏期间已换题)
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", onVisible);
      // 初始检测
      setTimeout(detect, 400);
      setTimeout(detect, 1500); // SPA 首屏较慢,二次兜底
    },
    detect,
  };
})();
