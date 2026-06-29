// Popup 逻辑:展示状态 + 快捷操作。
import { formatDuration } from "../utils.js";

const $ = (id) => document.getElementById(id);

async function sendBg(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (resp) => {
      resolve(resp && resp.ok ? resp.data : null);
    });
  });
}

async function refresh() {
  const status = await sendBg("GET_STATUS");
  if (!status) return;

  // LLM 状态点
  const dot = $("llmStatus");
  if (status.hasLLM) {
    dot.className = "status ok";
    dot.title = `已配置: ${status.model}`;
    $("hint").textContent = `模型: ${status.model}`;
  } else {
    dot.className = "status warn";
    dot.title = "未配置 LLM";
  }

  // 统计
  const s = status.stats || {};
  $("statAc").textContent = s.totalAccepted || 0;
  $("statNotes").textContent = s.totalNotes || 0;
  $("statDue").textContent = status.dueCount || 0;

  // 当前做题
  const active = status.activeSession;
  if (active && !active.accepted) {
    $("activeCard").classList.remove("hidden");
    $("probSlug").textContent = active.slug || "—";
    $("elapsed").textContent = "用时 " + formatDuration(active.elapsedSec || (active.startedAt ? Math.floor((Date.now() - new Date(active.startedAt).getTime()) / 1000) : 0));
    $("attempts").textContent = `提交 ${(active.attempts || []).length} 次`;
    $("btnGenNote").disabled = false;
    $("btnGenNote").dataset.problemKey = active.problemKey;
    $("btnOpenProblem").dataset.url = active.url || "";
  } else if (active && active.accepted) {
    $("activeCard").classList.remove("hidden");
    $("probSlug").textContent = active.slug + " · 已 AC ✓";
    $("elapsed").textContent = "用时 " + formatDuration(active.durationSec);
    $("attempts").textContent = `提交 ${(active.attempts || []).length} 次`;
    $("btnGenNote").disabled = false;
    $("btnGenNote").dataset.problemKey = active.problemKey;
    $("btnOpenProblem").dataset.url = active.url || "";
  } else {
    $("activeCard").classList.add("hidden");
  }
}

$("btnGenNote").addEventListener("click", async (e) => {
  const pk = e.target.dataset.problemKey;
  if (!pk) return;
  e.target.disabled = true;
  e.target.textContent = "生成中…";
  try {
    const note = await sendBg("GENERATE_NOTE", { problemKey: pk });
    if (note && note.id) {
      chrome.tabs.create({ url: chrome.runtime.getURL(`src/notes/note-viewer.html?id=${note.id}`) });
      window.close();
    } else {
      e.target.textContent = "生成笔记";
      e.target.disabled = false;
      alert("生成失败:可能尚未拿到题目元数据,稍后再试。");
    }
  } catch (err) {
    e.target.textContent = "生成笔记";
    e.target.disabled = false;
    alert("生成失败:" + (err && err.message ? err.message : err));
  }
});

$("btnOpenProblem").addEventListener("click", (e) => {
  const url = e.currentTarget.dataset.url;
  if (url) chrome.tabs.create({ url });
});

$("btnNotes").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/notes/note-viewer.html") });
});

$("btnSettings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// 清空计数(AC 计数 + 复习计数 + 连续天数)。笔记不删,totalNotes 因派生保留。
$("btnClearStats").addEventListener("click", async () => {
  if (!confirm("清空 AC 计数 / 复习计数 / 连续天数?\n(笔记不会被删除,笔记数保留)")) return;
  const s = await sendBg("CLEAR_STATS");
  if (s) {
    $("statAc").textContent = s.totalAccepted || 0;
    $("statNotes").textContent = s.totalNotes || 0;
    $("hint").textContent = "计数已清空";
  }
});

refresh();
// 每秒刷新计时
setInterval(refresh, 1000);
