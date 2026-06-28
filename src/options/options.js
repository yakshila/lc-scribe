// Options 逻辑:加载/保存设置、模型测试、上传器测试、Agent 列表。
import { ensureHostPermission, testConnection } from "../llm/llm-client.js";
import { getAgentRegistry } from "../agents/agent-registry.js";
import { getUploaderRegistry } from "../uploaders/uploader-registry.js";

const $ = (id) => document.getElementById(id);
let settings = null;
let saveTimer = null;

async function sendBg(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (r) => resolve(r && r.ok ? r.data : null));
  });
}

async function load() {
  settings = await sendBg("GET_SETTINGS");
  if (!settings) return;
  // LLM
  $("llmEnabled").checked = !!settings.llm.enabled;
  $("llmBaseURL").value = settings.llm.baseURL || "";
  $("llmModel").value = settings.llm.model || "";
  $("llmApiKey").value = settings.llm.apiKey || "";
  $("llmTemp").value = settings.llm.temperature ?? 0.3;
  $("llmMaxTokens").value = settings.llm.maxTokens ?? 1500;
  $("llmTimeout").value = settings.llm.timeoutMs ?? 30000;
  // 通知
  $("onAccepted").checked = !!settings.notifications.onAccepted;
  $("onStuckEnabled").checked = !!settings.notifications.onStuckEnabled;
  $("onStuckMinutes").value = settings.notifications.onStuckMinutes ?? 15;
  $("onDueReview").checked = !!settings.notifications.onDueReview;
  $("reviewCheckHour").value = settings.notifications.reviewCheckHour ?? 9;
  // 笔记
  $("autoGenerate").checked = !!settings.notes.autoGenerate;
  $("noteLang").value = settings.notes.language || "zh";
  // 复习
  $("enableReminders").checked = !!settings.review.enableReminders;
  $("maxDuePerDay").value = settings.review.maxDuePerDay ?? 5;
  // 上传器
  $("feishuEnabled").checked = !!(settings.uploaders.feishu && settings.uploaders.feishu.enabled);
  $("feishuWebhook").value = (settings.uploaders.feishu && settings.uploaders.feishu.webhook) || "";
  $("feishuBotName").value = (settings.uploaders.feishu && settings.uploaders.feishu.botName) || "LC Scribe";
  $("mdEnabled").checked = !!(settings.uploaders.markdown && settings.uploaders.markdown.enabled);
  $("mdAutoDownload").checked = !!(settings.uploaders.markdown && settings.uploaders.markdown.autoDownload);

  renderAgents();
  bindAutoSave();
}

function renderAgents() {
  const reg = getAgentRegistry();
  const enabled = settings.agents.enabled || [];
  const list = reg.list();
  const box = $("agentList");
  box.innerHTML = "";
  for (const a of list) {
    const cap = a.capabilities[0];
    const on = enabled.includes(cap);
    const item = document.createElement("div");
    item.className = "agent-item";
    item.innerHTML = `
      <div>
        <div class="name">${a.name}</div>
        <div class="desc">${a.description}</div>
        <div class="caps">${a.capabilities.map((c) => `<span class="cap">${c}</span>`).join("")}</div>
      </div>
      <input type="checkbox" ${on ? "checked" : ""} data-cap="${cap}" />
    `;
    item.querySelector("input").addEventListener("change", (e) => {
      const c = e.target.dataset.cap;
      const arr = new Set(settings.agents.enabled || []);
      if (e.target.checked) arr.add(c); else arr.delete(c);
      settings.agents.enabled = Array.from(arr);
      scheduleSave();
    });
    box.appendChild(item);
  }
}

function collectForm() {
  return {
    llm: {
      enabled: $("llmEnabled").checked,
      baseURL: $("llmBaseURL").value.trim(),
      apiKey: $("llmApiKey").value.trim(),
      model: $("llmModel").value.trim(),
      temperature: parseFloat($("llmTemp").value),
      maxTokens: parseInt($("llmMaxTokens").value, 10),
      timeoutMs: parseInt($("llmTimeout").value, 10),
    },
    notifications: {
      onAccepted: $("onAccepted").checked,
      onStuckEnabled: $("onStuckEnabled").checked,
      onStuckMinutes: parseInt($("onStuckMinutes").value, 10),
      onDueReview: $("onDueReview").checked,
      reviewCheckHour: parseInt($("reviewCheckHour").value, 10),
    },
    notes: {
      autoGenerate: $("autoGenerate").checked,
      language: $("noteLang").value,
    },
    review: {
      enableReminders: $("enableReminders").checked,
      maxDuePerDay: parseInt($("maxDuePerDay").value, 10),
    },
    agents: settings.agents,
    uploaders: {
      feishu: {
        enabled: $("feishuEnabled").checked,
        webhook: $("feishuWebhook").value.trim(),
        botName: $("feishuBotName").value.trim() || "LC Scribe",
      },
      markdown: {
        enabled: $("mdEnabled").checked,
        autoDownload: $("mdAutoDownload").checked,
      },
    },
  };
}

function bindAutoSave() {
  const ids = ["llmEnabled","llmBaseURL","llmModel","llmApiKey","llmTemp","llmMaxTokens","llmTimeout",
    "onAccepted","onStuckEnabled","onStuckMinutes","onDueReview","reviewCheckHour",
    "autoGenerate","noteLang","enableReminders","maxDuePerDay",
    "feishuEnabled","feishuWebhook","feishuBotName","mdEnabled","mdAutoDownload"];
  ids.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", () => {
      Object.assign(settings, collectForm());
      scheduleSave();
    });
  });
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    settings = await sendBg("SAVE_SETTINGS", settings);
    const h = $("savedHint");
    h.textContent = "已保存 ✓";
    h.classList.add("show");
    setTimeout(() => h.classList.remove("show"), 1200);
  }, 400);
}

function setHint(id, msg, type) {
  const el = $(id);
  el.textContent = msg;
  el.className = "hint" + (type ? " " + type : "");
}

// —— LLM 授权 / 测试 ——
$("btnAuthorize").addEventListener("click", async () => {
  const base = $("llmBaseURL").value.trim();
  if (!base) return setHint("llmHint", "请先填 Base URL", "err");
  const ok = await ensureHostPermission(base).catch(() => false);
  setHint("llmHint", ok ? "已授权" : "未授权(被拒绝)", ok ? "ok" : "err");
});

$("btnTestLLM").addEventListener("click", async () => {
  Object.assign(settings, collectForm());
  const llm = settings.llm;
  if (!llm.baseURL || !llm.apiKey) return setHint("llmHint", "请填 Base URL 与 API Key", "err");
  await ensureHostPermission(llm.baseURL).catch(() => {});
  setHint("llmHint", "测试中…");
  try {
    const ok = await testConnection(llm);
    setHint("llmHint", ok ? "连接成功 ✓" : "连接异常(回复非 ok)", ok ? "ok" : "err");
  } catch (e) {
    setHint("llmHint", "失败:" + e.message, "err");
  }
});

// —— 飞书授权 / 测试 ——
$("btnAuthFeishu").addEventListener("click", async () => {
  const ok = await ensureHostPermission("https://open.feishu.cn").catch(() => false);
  setHint("feishuHint", ok ? "已授权飞书域名" : "未授权", ok ? "ok" : "err");
});

$("btnTestFeishu").addEventListener("click", async () => {
  Object.assign(settings, collectForm());
  const reg = getUploaderRegistry();
  setHint("feishuHint", "测试中…");
  try {
    const r = await reg.test("feishu", { settings });
    setHint("feishuHint", r.message || (r.success ? "成功" : "失败"), r.success ? "ok" : "err");
  } catch (e) {
    setHint("feishuHint", "失败:" + e.message, "err");
  }
});

// —— 立即检查复习 ——
$("btnTriggerReview").addEventListener("click", async () => {
  await sendBg("TRIGGER_REVIEW_CHECK");
  const h = $("savedHint");
  h.textContent = "已触发复习检查 ✓";
  h.classList.add("show");
  setTimeout(() => h.classList.remove("show"), 1500);
});

load();
