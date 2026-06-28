// page context 钩子:在 leetcode.cn 页面主世界包裹 fetch / XHR,捕获提交请求与结果。
// 通过 window.postMessage({source:"lcc-page-hook", ...}) 回传给 content script。
// 注意:本文件运行在页面主世界(非扩展隔离环境),不能使用 chrome.* API。
(function () {
  if (window.__LCC_PAGE_HOOK__) return;
  window.__LCC_PAGE_HOOK__ = true;

  console.log("[LCC:info][page-hook] page-hook loaded in MAIN world @", location.href);

  const SOURCE = "lcc-page-hook";
  function post(type, detail) {
    try {
      window.postMessage({ source: SOURCE, type, detail }, location.origin);
    } catch (e) {
      /* ignore */
    }
  }

  // 提交结果状态码(leetcode.cn)
  // 10 Accepted | 11 Wrong Answer | 12 MLE | 13 OLE | 14 TLE | 15 RE | 16 Internal | 20 Compile Error | 21 Unknown
  function decodeStatus(code, msg) {
    const map = {
      10: "Accepted",
      11: "Wrong Answer",
      12: "Memory Limit Exceeded",
      13: "Output Limit Exceeded",
      14: "Time Limit Exceeded",
      15: "Runtime Error",
      16: "Internal Error",
      20: "Compile Error",
      21: "Unknown Error",
    };
    return map[code] || msg || (code != null ? `Status ${code}` : "Unknown");
  }

  // —— 包装 fetch ——
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    let url = "";
    let reqBody = null;
    try {
      url = typeof input === "string" ? input : input && input.url ? input.url : "";
      if (init && init.body) reqBody = init.body;
    } catch (_) {}

    // 诊断:打印所有包含 submit 的 URL,定位 LeetCode CN 提交接口
    if (url && /submit/i.test(url)) {
      console.log("[LCC:info][page-hook] fetch URL contains 'submit':", url, "hasBody=", !!reqBody);
    }

    const p = _fetch.apply(this, arguments);
    // 拦截提交请求体
    maybeCaptureSubmitRequest(url, reqBody);
    // 拦截结果响应
    p.then((resp) => {
      try {
        const u = url.toLowerCase();
        if (u.includes("/submissions/detail/") && u.includes("/check")) {
          // 结果轮询响应
          resp.clone().json().then((data) => {
            postResultFromCheck(data);
          }).catch(() => {});
        } else if (u.includes("/graphql") || u.includes("/problems/") && u.includes("/submit")) {
          resp.clone().text().then((txt) => {
            maybePostFromGraphQL(url, txt);
          }).catch(() => {});
        }
      } catch (_) {}
    }).catch(() => {});
    return p;
  };

  // —— 包装 XHR ——
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__lcc_url = url || "";
    this.__lcc_method = method;
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    maybeCaptureSubmitRequest(this.__lcc_url, body);
    this.addEventListener("load", () => {
      try {
        const u = (this.__lcc_url || "").toLowerCase();
        if (u.includes("/submissions/detail/") && u.includes("/check")) {
          postResultFromCheck(JSON.parse(this.responseText));
        } else if (u.includes("/graphql") || (u.includes("/problems/") && u.includes("/submit"))) {
          maybePostFromGraphQL(this.__lcc_url, this.responseText);
        }
      } catch (_) {}
    });
    return _send.apply(this, arguments);
  };

  // —— 解析逻辑 ——
  function maybeCaptureSubmitRequest(url, body) {
    if (!url) return;
    const u = url.toLowerCase();
    let isSubmit = false;
    let payload = null;

    if (u.includes("/graphql")) {
      payload = parseBody(body);
      const op = payload && (payload.operationName || (payload.query && /mutation\s+\w*submit/i.test(payload.query)));
      // 放宽匹配:任何 query/mutation 含 submit 字样都视为提交
      if (payload && (op === "submit" || op === "submitSolution" || op === "submission" ||
          (payload.query && /submitSolution|submit|submission/i.test(payload.query)))) {
        isSubmit = true;
      }
      // 诊断:打印所有 GraphQL operationName
      if (payload && payload.operationName) {
        console.log("[LCC:debug][page-hook] graphql op:", payload.operationName);
      }
    } else if (u.includes("/problems/") && u.includes("/submit")) {
      isSubmit = true;
      payload = parseBody(body);
    }

    if (!isSubmit) return;
    console.log("[LCC:info][page-hook] submit request detected, url=", url, "payload keys=", payload ? Object.keys(payload) : "null");

    if (!payload) return;

    const vars = payload.variables || payload;
    // 放宽字段名匹配,兼容 LeetCode CN 不同版本
    const typedCode = vars.typedCode || vars.typed_code || vars.code ||
      (vars.data && (vars.data.typedCode || vars.data.typed_code || vars.data.code)) || "";
    const lang = vars.lang || vars.langSlug || vars.language ||
      (vars.data && (vars.data.lang || vars.data.langSlug || vars.data.language)) || "";
    const questionId = vars.questionId || vars.question_id ||
      (vars.data && (vars.data.questionId || vars.data.question_id)) || "";
    console.log("[LCC:info][page-hook] submit payload: typedCode.len=", typedCode.length, "lang=", lang, "questionId=", questionId);
    if (typedCode || lang) {
      post("SUBMIT_REQUEST", { typedCode, lang, questionId, url });
    } else {
      // 诊断:提交被识别但没拿到 code/lang,打印完整 variables 结构
      console.log("[LCC:warn][page-hook] submit detected but no typedCode/lang. vars keys=", vars ? Object.keys(vars) : "null", "vars=", JSON.stringify(vars).slice(0, 500));
    }
  }

  function parseBody(body) {
    if (!body) return null;
    if (typeof body === "string") {
      try { return JSON.parse(body); } catch { return null; }
    }
    if (body instanceof URLSearchParams) {
      const o = {};
      body.forEach((v, k) => (o[k] = v));
      return o;
    }
    try { return JSON.parse(JSON.stringify(body)); } catch { return null; }
  }

  function postResultFromCheck(data) {
    if (!data) return;
    // 轮询中间态:status_code 还没出来(题目仍在跑),跳过,不当作结果上报
    if (data.status_code == null) {
      console.log("[LCC:debug][page-hook] result check pending (no status_code yet), skip");
      return;
    }
    // /submissions/detail/<id>/check/ 响应
    const status = decodeStatus(data.status_code, data.status_msg);
    console.log("[LCC:info][page-hook] result check captured:", status, "code=", data.status_code);
    post("SUBMIT_RESULT", {
      status,
      statusMsg: data.status_msg,
      runtime: data.runtime != null ? data.runtime : data.run_time,
      memory: data.memory != null ? data.memory : data.memory_bytes,
      submissionId: data.submission_id,
    });
  }

  function maybePostFromGraphQL(url, text) {
    if (!text) return;
    let data;
    try { data = JSON.parse(text); } catch { return; }
    const u = (url || "").toLowerCase();
    // GraphQL submit 响应可能直接包含 submissionId
    if (u.includes("/graphql")) {
      const d = data.data || {};
      const sub = d.submitSolution || d.submit || d;
      if (sub && (sub.submissionId || sub.submission_id)) {
        post("SUBMIT_RESULT", {
          status: "Pending",
          statusMsg: "submitted",
          submissionId: sub.submissionId || sub.submission_id,
        });
      }
    }
  }
})();
