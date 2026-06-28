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
    let method = "GET";
    let reqBody = null;
    try {
      url = typeof input === "string" ? input : input && input.url ? input.url : "";
      method = (init && init.method) || (input && input.method) || "GET";
      if (init && init.body) reqBody = init.body;
    } catch (_) {}

    // catch-all:打印所有 POST 请求(非 GET),帮助定位真正的提交端点
    if (method !== "GET" && method !== "HEAD" && url) {
      const u = url.toLowerCase();
      // 排除明显的非提交 POST(数据分析、埋点等),减少噪音
      const isNoise = u.includes("/graphql") === false && (u.includes("/event") || u.includes("/track") || u.includes("/log") || u.includes("/monitor"));
      if (!isNoise) {
        console.log("[LCC:info][page-hook] POST", method, url, "hasBody=", !!reqBody);
      }
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
    // catch-all:打印所有 POST XHR,帮助定位真正的提交端点
    try {
      const m = (this.__lcc_method || "").toUpperCase();
      const u = (this.__lcc_url || "").toLowerCase();
      if (m !== "GET" && m !== "HEAD" && u) {
        const isNoise = u.includes("/graphql") === false && (u.includes("/event") || u.includes("/track") || u.includes("/log") || u.includes("/monitor"));
        if (!isNoise) {
          console.log("[LCC:info][page-hook] XHR POST", m, u, "hasBody=", !!body);
        }
      }
    } catch (_) {}
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
      const op = payload && payload.operationName;
      // 收紧匹配:只认真正的提交操作(operationName 严格匹配 submit / submitSolution),
      // 或 mutation 中显式声明 submitSolution。
      // 排除 submissionAnalysisAvailable / submissionList 这类查询(它们只是只读查询)。
      if (op === "submit" || op === "submitSolution" ||
          (payload.query && /mutation\s+submitSolution\s*[\(\{]/i.test(payload.query)) ||
          (payload.query && /mutation\s+submit\s*[\(\{]/i.test(payload.query))) {
        isSubmit = true;
      }
      // 诊断:打印所有 GraphQL operationName
      if (payload && payload.operationName) {
        console.log("[LCC:debug][page-hook] graphql op:", payload.operationName);
      }
    } else if (u.includes("/problems/") && u.includes("/submit")) {
      // REST 提交端点 /problems/<slug>/submit/
      isSubmit = true;
      payload = parseBody(body);
    } else if (u.includes("/problems/") && u.includes("/interpret_solution")) {
      // 运行代码端点 /problems/<slug>/interpret_solution/
      // 用户点"运行"而非"提交"时走这个,请求体里同样带 typedCode/lang,
      // 必须拦截,否则运行结果永远拿不到代码。
      isSubmit = true;
      payload = parseBody(body);
      console.log("[LCC:info][page-hook] interpret_solution (run code) detected, capturing code");
    } else if (u.includes("/submissions/") && u.includes("/submit")) {
      // 备用:/submissions/.../submit
      isSubmit = true;
      payload = parseBody(body);
    }

    if (!isSubmit) return;
    console.log("[LCC:info][page-hook] submit request detected, url=", url, "payload keys=", payload ? Object.keys(payload) : "null");

    if (!payload) return;

    const vars = payload.variables || payload;
    // LeetCode CN 的 interpret_solution 有时把 code/lang 包在 data_json(JSON 字符串)里
    let dataJson = null;
    if (typeof vars.data_json === "string" && vars.data_json.trim().startsWith("{")) {
      try { dataJson = JSON.parse(vars.data_json); } catch (_) {}
    }
    const src = [vars, dataJson, vars.data].filter(Boolean);
    const pick = (keys) => {
      for (const s of src) {
        for (const k of keys) {
          if (s[k] != null && s[k] !== "") return s[k];
        }
      }
      return "";
    };
    const typedCode = pick(["typedCode", "typed_code", "code"]);
    const lang = pick(["lang", "langSlug", "language"]);
    const questionId = pick(["questionId", "question_id"]);
    console.log("[LCC:info][page-hook] submit payload: typedCode.len=", typedCode.length, "lang=", lang, "questionId=", questionId, "dataJson=", !!dataJson);
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

    // 判断是否为运行代码(interpret_solution):submissionId 以 runcode_ 开头
    const isRunCode = data.submission_id && String(data.submission_id).startsWith("runcode_");

    // /submissions/detail/<id>/check/ 响应
    let status = decodeStatus(data.status_code, data.status_msg);

    // 对运行代码(runcode),status_code=10 只表示"运行完成",不代表全部用例通过。
    // 需要额外检查 compare_result 字段(逐用例 1=通过 0=失败)。
    // 如果有任一用例失败,改为 "Wrong Answer (run)" 让用户知道。
    if (isRunCode && data.status_code === 10) {
      const compareResult = data.compare_result;
      if (typeof compareResult === "string" && /0/.test(compareResult)) {
        const total = compareResult.split(",").length;
        const passed = compareResult.split(",").filter((x) => x.trim() === "1").length;
        status = `Wrong Answer (run ${passed}/${total})`;
        console.log("[LCC:warn][page-hook] runcode has failing cases:", compareResult, `-> ${status}`);
      }
    }

    // LeetCode CN 字段名:runtime 用 status_runtime 或 display_runtime(字符串如 "40 ms"),
    // memory 用 status_memory(字符串如 "6.2 MB")或 memory(字节数)。
    // 兼容多种字段名,优先取数值型的。
    const runtime = pickRuntime(data);
    const memory = pickMemory(data);

    // 诊断:打印完整响应字段,帮助定位字段名差异
    console.log("[LCC:info][page-hook] result check captured:", status, "code=", data.status_code,
      "| isRunCode=", isRunCode,
      "| fields=", Object.keys(data).join(","),
      "| compare_result=", data.compare_result,
      "| runtime=", runtime, "memory=", memory);

    post("SUBMIT_RESULT", {
      status,
      statusMsg: data.status_msg,
      runtime,
      memory,
      submissionId: data.submission_id,
    });
  }

  // 从 check 响应里提取 runtime(毫秒,数值)
  // LeetCode CN: status_runtime 是 "40 ms" 字符串,display_runtime 是 "40" 字符串,
  // runtime/run_time 在部分接口存在(数值),统一取数值。
  function pickRuntime(data) {
    const candidates = [data.runtime, data.run_time, data.display_runtime, data.status_runtime];
    for (const c of candidates) {
      if (c == null) continue;
      const n = typeof c === "number" ? c : parseInt(String(c).replace(/[^\d]/g, ""), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  }

  // 从 check 响应里提取 memory(字节数,数值)
  // LeetCode CN: status_memory 是 "6.2 MB" 字符串,memory 是字节数,统一转成字节。
  function pickMemory(data) {
    if (data.memory != null && typeof data.memory === "number") return data.memory;
    if (data.memory_bytes != null && typeof data.memory_bytes === "number") return data.memory_bytes;
    // 从 status_memory 字符串解析 "6.2 MB" / "4268 KB"
    const sm = data.status_memory;
    if (typeof sm === "string") {
      const m = sm.match(/([\d.]+)\s*(KB|MB|GB)/i);
      if (m) {
        const v = parseFloat(m[1]);
        const unit = m[2].toUpperCase();
        if (unit === "KB") return Math.round(v * 1024);
        if (unit === "MB") return Math.round(v * 1024 * 1024);
        if (unit === "GB") return Math.round(v * 1024 * 1024 * 1024);
      }
    }
    return undefined;
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
