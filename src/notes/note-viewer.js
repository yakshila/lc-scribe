// note-viewer 逻辑:笔记列表 / 复习 / 详情渲染与操作。
import { noteToMarkdown } from "../storage/schema.js";
import { formatDuration } from "../utils.js";

const $ = (id) => document.getElementById(id);
let currentNote = null;
let allNotes = [];
let batchMode = false;
let selected = new Set(); // noteId 集合(批量管理用)

async function sendBg(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (r) => {
      resolve(r && r.ok ? r.data : null);
    });
  });
}

// —— Tab 切换 ——
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => switchTab(t.dataset.tab));
});
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("viewList").classList.toggle("hidden", name !== "notes" || currentNote);
  $("viewReview").classList.toggle("hidden", name !== "review");
  $("viewDetail").classList.toggle("hidden", true);
  if (name === "review") renderReview();
  history.replaceState(null, "", name === "review" ? "?tab=review" : location.pathname);
}

// —— 列表 ——
async function loadNotes() {
  allNotes = (await sendBg("GET_NOTES")) || [];
  allNotes.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  renderList();
  updateDueBadge();
}

function renderList(filter = "") {
  const box = $("noteList");
  box.innerHTML = "";
  const f = filter.trim().toLowerCase();
  const notes = allNotes.filter((n) => {
    if (!f) return true;
    const m = n.meta || {};
    return (
      String(m.problemId || "").includes(f) ||
      (m.title || "").toLowerCase().includes(f) ||
      (m.titleSlug || "").toLowerCase().includes(f) ||
      (m.tags || []).join(" ").toLowerCase().includes(f)
    );
  });
  if (notes.length === 0) {
    box.innerHTML = `<p class="empty">还没有笔记。在力扣 AC 一道题后,点通知里的"生成笔记"试试。</p>`;
    return;
  }
  for (const n of notes) {
    const m = n.meta || {};
    const card = document.createElement("div");
    card.className = "note-card" + (selected.has(n.id) ? " selected" : "");
    card.dataset.id = n.id;
    const due = n.review && n.review.nextReviewAt && new Date(n.review.nextReviewAt).getTime() <= Date.now();
    const chk = batchMode ? `<input type="checkbox" class="batch-check" ${selected.has(n.id) ? "checked" : ""} />` : "";
    card.innerHTML = `
      ${chk}
      <div class="left">
        <div class="title"><span class="pid">#${m.problemId}</span>${esc(m.title || m.titleSlug)}</div>
        <div class="tags">
          <span class="diff ${m.difficulty || ""}">${m.difficulty || "—"}</span>
          ${(m.tags || []).slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
        </div>
      </div>
      <div class="right">
        <div class="next ${due ? "due" : ""}">${due ? "待复习" : "下次 " + fmtDate(n.review && n.review.nextReviewAt)}</div>
        <div class="next" style="margin-top:2px">${esc((n.createdAt || "").slice(0, 10))}</div>
      </div>
    `;
    if (batchMode) {
      // 批量模式:点卡片或 checkbox 切换选中
      card.addEventListener("click", (e) => {
        if (e.target.classList.contains("batch-check")) return; // checkbox 自己处理
        toggleSelect(n.id);
      });
      const cb = card.querySelector(".batch-check");
      if (cb) cb.addEventListener("change", () => toggleSelect(n.id));
    } else {
      card.addEventListener("click", () => openDetail(n.id));
    }
    box.appendChild(card);
  }
}

function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  updateBatchUI();
}

function updateBatchUI() {
  // 仅更新选中态/计数,避免整列表重渲染丢滚动
  document.querySelectorAll(".note-card").forEach((c) => {
    const id = c.dataset.id;
    const on = selected.has(id);
    c.classList.toggle("selected", on);
    const cb = c.querySelector(".batch-check");
    if (cb) cb.checked = on;
  });
  $("batchCount").textContent = `已选 ${selected.size}`;
  $("chkAll").checked = allNotes.length > 0 && selected.size === allNotes.length;
}

$("searchBox").addEventListener("input", (e) => renderList(e.target.value));

// —— 批量管理 ——
$("btnBatch").addEventListener("click", () => {
  batchMode = !batchMode;
  $("btnBatch").textContent = batchMode ? "退出批量" : "批量管理";
  $("btnBatch").classList.toggle("primary", batchMode);
  $("batchBar").classList.toggle("hidden", !batchMode);
  if (!batchMode) selected.clear();
  renderList($("searchBox").value);
  updateBatchUI();
});

$("chkAll").addEventListener("change", (e) => {
  if (e.target.checked) allNotes.forEach((n) => selected.add(n.id));
  else selected.clear();
  updateBatchUI();
});

$("btnBatchDelete").addEventListener("click", async () => {
  const ids = [...selected];
  if (ids.length === 0) return;
  if (!confirm(`确定删除选中的 ${ids.length} 篇笔记?此操作不可撤销。`)) return;
  const r = await sendBg("DELETE_NOTES", { noteIds: ids });
  selected.clear();
  await loadNotes();
  alert(`已删除 ${r && r.count ? r.count : 0} 篇笔记。`);
});

$("btnBatchExport").addEventListener("click", async () => {
  const ids = [...selected];
  if (ids.length === 0) return;
  // 逐篇触发 Markdown 下载(markdown uploader 走 chrome.downloads)
  let ok = 0;
  for (const id of ids) {
    const r = await sendBg("UPLOAD_NOTE", { noteId: id, uploader: "markdown" });
    if (r && r.success) ok++;
  }
  alert(`导出完成:成功 ${ok}/${ids.length}。`);
});

$("btnBatchFeishu").addEventListener("click", async () => {
  const ids = [...selected];
  if (ids.length === 0) return;
  if (!confirm(`将选中的 ${ids.length} 篇笔记上传到飞书,继续?`)) return;
  const r = await sendBg("BATCH_UPLOAD", { noteIds: ids, uploader: "feishu" });
  if (r) alert(`上传完成:成功 ${r.success}/${r.total}${r.failed ? `,失败 ${r.failed}` : ""}。`);
});

// —— 复习 ——
async function renderReview() {
  const due = (await sendBg("GET_DUE_REVIEWS")) || [];
  const box = $("reviewList");
  box.innerHTML = "";
  if (due.length === 0) {
    $("reviewEmpty").classList.remove("hidden");
    return;
  }
  $("reviewEmpty").classList.add("hidden");
  for (const { note } of due) {
    const m = note.meta || {};
    const card = document.createElement("div");
    card.className = "note-card";
    card.innerHTML = `
      <div class="left">
        <div class="title"><span class="pid">#${m.problemId}</span>${esc(m.title || m.titleSlug)}</div>
        <div class="tags"><span class="diff ${m.difficulty || ""}">${m.difficulty || "—"}</span>
          <span class="tag">到期 ${fmtDate(note.review && note.review.nextReviewAt)}</span></div>
      </div>
      <div class="right">
        <button class="grade g4" data-act="open">去复习</button>
      </div>
    `;
    card.querySelector("button").addEventListener("click", (e) => {
      e.stopPropagation();
      openDetail(note.id);
    });
    box.appendChild(card);
  }
}

async function updateDueBadge() {
  const due = (await sendBg("GET_DUE_REVIEWS")) || [];
  const b = $("dueBadge");
  if (due.length > 0) {
    b.textContent = due.length;
    b.classList.remove("hidden");
  } else {
    b.classList.add("hidden");
  }
}

// —— 详情 ——
async function openDetail(noteId) {
  const note = await sendBg("GET_NOTE", { noteId });
  if (!note) {
    $("detailHint").textContent = "笔记不存在";
    return;
  }
  currentNote = note;
  $("viewList").classList.add("hidden");
  $("viewReview").classList.add("hidden");
  $("viewDetail").classList.remove("hidden");
  const md = noteToMarkdown(note);
  $("noteDetail").innerHTML = renderMarkdown(md);
  $("detailHint").textContent = "";
  // 代码块语法高亮(highlight.js 已在 html 中 defer 引入)
  highlightCodeBlocks($("noteDetail"));
  // 滚动到顶部
  window.scrollTo(0, 0);
}

// 用 highlight.js 高亮容器内所有 <pre><code> 块。
// LeetCode 的语言名(python3/golang 等)需要映射到 hljs 的语言名。
function highlightCodeBlocks(container) {
  if (!container || typeof hljs === "undefined") return;
  const LANG_MAP = {
    python3: "python", python: "python",
    golang: "go", go: "go",
    cpp: "cpp", "c++": "cpp", c: "c",
    java: "java", javascript: "javascript", js: "javascript",
    typescript: "typescript", ts: "typescript",
    rust: "rust", mysql: "sql", sql: "sql", sqlserver: "sql",
    csharp: "csharp", "c#": "csharp", kotlin: "kotlin", swift: "swift",
    ruby: "ruby", php: "php", scala: "scala", bash: "bash", shell: "bash",
  };
  container.querySelectorAll("pre code").forEach((block) => {
    // 从 class="lang-xxx" 取语言
    const m = /lang-(\S+)/.exec(block.className || "");
    const lang = m ? m[1].toLowerCase() : "";
    if (lang && LANG_MAP[lang]) {
      block.className = "language-" + LANG_MAP[lang];
    }
    try { hljs.highlightElement(block); } catch (_) {}
  });
}

$("btnBack").addEventListener("click", () => {
  currentNote = null;
  $("viewDetail").classList.add("hidden");
  const activeTab = document.querySelector(".tab.active").dataset.tab;
  if (activeTab === "review") {
    $("viewReview").classList.remove("hidden");
    renderReview();
  } else {
    $("viewList").classList.remove("hidden");
  }
});

// 复习评分
document.querySelectorAll(".grade[data-grade]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!currentNote) return;
    const grade = parseInt(btn.dataset.grade, 10);
    const next = await sendBg("REVIEW_GRADE", { noteId: currentNote.id, grade });
    if (next) {
      const days = next.interval;
      setHint(`已记录 ✓ 下次复习:${fmtDate(next.nextReviewAt)} (${days} 天后)`, "ok");
      currentNote.review = next;
    }
  });
});

// 导出 Markdown
$("btnExportMd").addEventListener("click", async () => {
  if (!currentNote) return;
  const r = await sendBg("UPLOAD_NOTE", { noteId: currentNote.id, uploader: "markdown" });
  setHint(r && r.success ? `已导出:${r.message || ""}` : "导出失败", r && r.success ? "ok" : "err");
});

// 上传飞书
$("btnUploadFeishu").addEventListener("click", async () => {
  if (!currentNote) return;
  setHint("上传中…");
  const r = await sendBg("UPLOAD_NOTE", { noteId: currentNote.id, uploader: "feishu" });
  setHint(r && r.success ? (r.message || "已上传 ✓") : ("上传失败:" + (r && r.message) || ""), r && r.success ? "ok" : "err");
});

// 删除
$("btnDelete").addEventListener("click", async () => {
  if (!currentNote) return;
  if (!confirm("确定删除该笔记?此操作不可撤销。")) return;
  await sendBg("DELETE_NOTE", { noteId: currentNote.id });
  await loadNotes();
  $("btnBack").click();
});

function setHint(msg, type) {
  const h = $("detailHint");
  h.textContent = msg;
  h.className = "hint" + (type ? " " + type : "");
}

// —— 极简 Markdown 渲染(先转义,再按块/行处理) ——
function renderMarkdown(md) {
  if (!md) return "";
  const lines = esc(md).split("\n");
  const out = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listType = null; // 'ul' | 'ol'

  const flushList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // 代码围栏
    if (/^```/.test(line)) {
      if (!inCode) {
        flushList();
        inCode = true;
        codeLang = line.replace(/^```/, "").trim();
        codeBuf = [];
      } else {
        out.push(`<pre><code${codeLang ? ` class="lang-${codeLang}"` : ""}>${codeBuf.join("\n")}</code></pre>`);
        inCode = false;
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    // 引用块
    if (/^&gt;\s?/.test(line)) {
      flushList();
      out.push(`<blockquote>${line.replace(/^&gt;\s?/, "")}</blockquote>`);
      continue;
    }
    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushList();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    // 无序列表
    if (/^[-*]\s+/.test(line)) {
      if (listType !== "ul") { flushList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    // 有序列表
    if (/^\d+\.\s+/.test(line)) {
      if (listType !== "ol") { flushList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${inline(line.replace(/^\d+\.\s+/, ""))}</li>`);
      continue;
    }
    // 空行
    if (line.trim() === "") { flushList(); continue; }
    // 普通段落
    flushList();
    out.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  if (inCode) out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`);
  return out.join("\n");
}

function inline(s) {
  // 行内代码 `..`
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // 粗体 **..**
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 链接 [t](u)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// —— 启动 ——
(async function init() {
  await loadNotes();
  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  const tab = params.get("tab");
  if (id) openDetail(id);
  else if (tab === "review") switchTab("review");
})();
