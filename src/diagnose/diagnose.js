// 诊断页逻辑:直接读 chrome.storage,不依赖 content script 是否注入。
const $ = (id) => document.getElementById(id);

async function sendBg(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (r) => resolve(r && r.ok ? r.data : null));
  });
}

async function refresh() {
  // SW 可达性
  try {
    const status = await sendBg("GET_STATUS");
    $("sw").textContent = "在线";
    $("sw").className = "v ok";
    if (status) {
      $("statAc").textContent = (status.stats && status.stats.totalAccepted) || 0;
      $("statNotes").textContent = (status.stats && status.stats.totalNotes) || 0;
      $("statDue").textContent = status.dueCount || 0;
      $("statLLM").textContent = status.hasLLM ? "是 (" + status.model + ")" : "否";
      $("statLLM").className = "v " + (status.hasLLM ? "ok" : "warn");
      if (status.activeSession) {
        const a = status.activeSession;
        $("statActive").textContent = `${a.slug} · ${a.accepted ? "已 AC" : "进行中"} · ${(a.attempts || []).length} 次提交`;
      } else {
        $("statActive").textContent = "无";
      }
    }
  } catch (e) {
    $("sw").textContent = "不可达:" + e.message;
    $("sw").className = "v bad";
  }

  // 直接读 sessions(绕过 SW,看本地存储里有没有会话数据)
  const { sessions } = await chrome.storage.local.get("sessions");
  const box = $("sessions");
  if (!sessions || Object.keys(sessions).length === 0) {
    box.innerHTML = '<span class="bad">没有任何会话记录 — content script 从未把数据写入后台</span>';
    return;
  }
  box.innerHTML = "";
  for (const [key, s] of Object.entries(sessions)) {
    const div = document.createElement("div");
    div.className = "row";
    div.innerHTML = `<span class="k">${s.slug || key}</span><span class="v ${s.accepted ? "ok" : "warn"}">${s.accepted ? "已 AC" : "进行中"} · ${s.startedAt ? s.startedAt.slice(0, 19) : "—"} · ${(s.attempts || []).length} 次提交</span>`;
    box.appendChild(div);
  }
}

$("btnRefresh").addEventListener("click", refresh);
$("btnTriggerReview").addEventListener("click", async () => {
  await sendBg("TRIGGER_REVIEW_CHECK");
  alert("已触发,如果没有到期复习就不会有通知。");
});

refresh();
