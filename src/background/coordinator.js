// Coordinator —— 后台核心编排器。
// 职责:路由消息(content / popup / options)、协调存储 / 通知 / 定时器 / Agent / Uploader / 复习。
import { logger, formatDuration, nowISO } from "../utils.js";
import {
  getSettings, saveSettings,
  getSession, saveSession, deleteSession,
  getProblem, saveProblem,
  getNote, listNotes, saveNote, deleteNote,
  getReview, saveReview, listReviews,
  getStats, bumpStats,
  newNoteSkeleton,
} from "../storage/store.js";
import { noteToMarkdown } from "../storage/schema.js";
import { sm2Init, sm2Next, countDue } from "../review/sm2.js";
import { notify, clearNotification } from "./notification-manager.js";
import {
  setStuckAlarm, clearStuckAlarm, ensureDailyReviewAlarm, installAlarmListener,
} from "./alarm-manager.js";
import { getAgentRegistry } from "../agents/agent-registry.js";
import { getUploaderRegistry } from "../uploaders/uploader-registry.js";

// 内存:problemKey -> { tabId, slug },用于向对应 tab 下发指令。SW 重启会丢失,可接受。
const tabMap = new Map(); // problemKey -> tabId
const problemKeyByTab = new Map(); // tabId -> problemKey

function sendToTab(tabId, msg) {
  if (tabId == null) return;
  try { chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError); } catch (e) { /* ignore */ }
}
function sendToProblemTab(problemKey, msg) {
  const tabId = tabMap.get(problemKey);
  sendToTab(tabId, msg);
}

// ============ 事件处理 ============

async function onProblemEntered(payload, sender) {
  const { slug, problemKey, url, problem } = payload;
  if (problem) await saveProblem(problem);
  const tabId = sender && sender.tab && sender.tab.id;
  if (tabId != null) {
    tabMap.set(problemKey, tabId);
    problemKeyByTab.set(tabId, problemKey);
  }

  let session = await getSession(problemKey);
  if (!session || session.accepted) {
    session = {
      problemKey, slug, url,
      startedAt: nowISO(),
      attempts: [],
      accepted: false,
      acceptedAt: null,
      durationSec: 0,
      languagesUsed: [],
    };
    await saveSession(problemKey, session);
    logger.info("coord", `session started: ${slug}`);
  } else {
    logger.debug("coord", `session resumed: ${slug}`);
  }

  const settings = await getSettings();
  if (settings.notifications.onStuckEnabled && !session.accepted) {
    setStuckAlarm(problemKey, settings.notifications.onStuckMinutes);
  }
  sendToProblemTab(problemKey, { type: "TIMER_START" });
  return { ok: true };
}

async function onProblemMeta(payload) {
  const { slug, problem } = payload;
  if (problem) {
    await saveProblem(problem);
    logger.debug("coord", `problem meta cached: ${slug}`);
  }
  return { ok: true };
}

async function onSubmissionResult(payload, sender) {
  const { problemKey, slug, status, statusMsg, runtime, memory, code, lang, accepted, submissionId } = payload;
  if (!problemKey) return { ok: false, error: "no problemKey" };

  let session = await getSession(problemKey);
  if (!session) {
    session = { problemKey, slug, url: payload.url || null, startedAt: nowISO(), attempts: [], accepted: false, languagesUsed: [] };
  }
  session.attempts = session.attempts || [];
  const attempt = { status, statusMsg, runtime, memory, lang, submissionId, ts: nowISO() };
  if (code) attempt.code = code;
  session.attempts.push(attempt);

  session.languagesUsed = session.languagesUsed || [];
  if (lang && !session.languagesUsed.includes(lang)) session.languagesUsed.push(lang);

  let becameAccepted = false;
  if (accepted && !session.accepted) {
    session.accepted = true;
    session.acceptedAt = nowISO();
    session.firstAccepted = session.attempts.length === 1;
    becameAccepted = true;
    if (session.startedAt) {
      session.durationSec = Math.max(0, Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000));
    }
    clearStuckAlarm(problemKey);
    sendToProblemTab(problemKey, { type: "TIMER_STOP" });
  }
  await saveSession(problemKey, session);
  logger.info("coord", `submission: ${slug} -> ${status}${becameAccepted ? " (NEW AC)" : ""}`);

  if (becameAccepted) {
    onAccepted(problemKey, session).catch((e) => logger.error("coord", "onAccepted", e));
  }
  return { ok: true, accepted: becameAccepted };
}

async function onAccepted(problemKey, session) {
  const settings = await getSettings();
  // 统计
  const stats = await getStats();
  await bumpStats({
    totalAccepted: (stats.totalAccepted || 0) + 1,
    lastActiveDate: new Date().toISOString().slice(0, 10),
  });

  if (settings.notifications.onAccepted) {
    await notify({
      id: `lcc-accept-${problemKey}-${Date.now()}`,
      title: "Accepted!",
      message: `${session.slug} · 用时 ${formatDuration(session.durationSec)} · ${session.attempts.length} 次提交`,
      buttons: [
        { title: "生成笔记", action: "generate-note" },
        { title: "稍后", action: "later" },
      ],
      onButton: (action) => {
        if (action === "generate-note") {
          generateNoteFor(problemKey).catch((e) => logger.error("coord", "gen-note from notif", e));
        }
      },
    });
  }
  if (settings.notes.autoGenerate) {
    await generateNoteFor(problemKey);
  }
}

// ============ 笔记生成 ============

export async function generateNoteFor(problemKey) {
  const session = await getSession(problemKey);
  const problem = await getProblem(problemKey);
  if (!session) throw new Error(`no session for ${problemKey}`);
  if (!problem) throw new Error(`no problem meta for ${problemKey}`);

  const settings = await getSettings();
  const note = newNoteSkeleton(problem);
  note.solving.startedAt = session.startedAt;
  note.solving.acceptedAt = session.acceptedAt;
  note.solving.durationSec = session.durationSec || 0;
  note.solving.attemptCount = (session.attempts || []).length;
  note.solving.firstAccepted = !!session.firstAccepted;
  note.solving.languagesUsed = session.languagesUsed || [];

  const acceptedAttempt = [...(session.attempts || [])].reverse().find((a) => /accepted/i.test(a.status));
  if (acceptedAttempt) {
    note.code.language = acceptedAttempt.lang || "";
    note.code.solution = acceptedAttempt.code || "";
  }
  // 把失败尝试摘要给 agent 参考
  const failedAttempts = (session.attempts || []).filter((a) => !/accepted/i.test(a.status));

  const ctx = { note, session, problem, settings, failedAttempts };

  const registry = getAgentRegistry();
  const enabled = settings.agents.enabled || [];

  if (enabled.includes("code-analysis")) {
    try {
      await registry.runCapability("code-analysis", ctx);
      logger.info("coord", "agent code-analysis done");
    } catch (e) {
      logger.error("coord", "agent code-analysis failed", e);
    }
  }
  if (enabled.includes("note-generation") && settings.llm.enabled) {
    try {
      await registry.runCapability("note-generation", ctx);
      logger.info("coord", "agent note-generation done");
    } catch (e) {
      logger.error("coord", "agent note-generation failed", e);
    }
  } else if (enabled.includes("note-generation") && !settings.llm.enabled) {
    // 没配模型:只写骨架,标记 AI 部分空缺
    note.aiGenerated.summary = "(未配置 LLM,跳过 AI 生成。可在设置中配置模型后重新生成。)";
  }

  if (enabled.includes("review-scheduler")) {
    try {
      await registry.runCapability("review-scheduler", ctx);
    } catch (e) {
      logger.error("coord", "agent review-scheduler failed", e);
      note.review = sm2Init(); // 兜底
    }
  }

  await saveNote(note);
  if (note.review) await saveReview(note.id, note.review);
  const s = await getStats();
  await bumpStats({ totalNotes: (s.totalNotes || 0) + 1 });

  await maybeAutoUpload(note);

  logger.info("coord", `note generated: ${note.id} for ${problemKey}`);
  return note;
}

async function maybeAutoUpload(note) {
  const settings = await getSettings();
  const reg = getUploaderRegistry();
  for (const [name, cfg] of Object.entries(settings.uploaders || {})) {
    if (cfg && cfg.enabled && cfg.autoDownload) {
      try {
        await reg.upload(name, note, { settings });
      } catch (e) {
        logger.warn("coord", `auto upload ${name} failed`, e);
      }
    }
  }
}

// ============ 复习 ============

export async function reviewNote(noteId, grade) {
  const review = (await getReview(noteId)) || sm2Init();
  const next = sm2Next(review, grade);
  await saveReview(noteId, next);
  const note = await getNote(noteId);
  if (note) {
    note.review = next;
    await saveNote(note);
  }
  const s = await getStats();
  await bumpStats({ totalReviewsDone: (s.totalReviewsDone || 0) + 1, lastActiveDate: new Date().toISOString().slice(0, 10) });
  return next;
}

export async function getDueReviews(now = Date.now()) {
  const reviews = await listReviews();
  const due = reviews.filter((r) => r.nextReviewAt && new Date(r.nextReviewAt).getTime() <= now);
  const notes = await listNotes();
  const noteMap = new Map(notes.map((n) => [n.id, n]));
  return due
    .map((r) => ({ review: r, note: noteMap.get(r.noteId || r.id) }))
    .filter((x) => x.note);
}

async function runDailyReviewCheck() {
  const settings = await getSettings();
  if (!settings.review.enableReminders || !settings.notifications.onDueReview) return;
  const due = await getDueReviews();
  if (due.length === 0) return;
  const max = settings.review.maxDuePerDay || 5;
  await notify({
    title: "今日复习提醒",
    message: `有 ${due.length} 道题到期复习${due.length > max ? `(建议先做 ${max} 道)` : ""}。点击查看。`,
    onClick: () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/notes/note-viewer.html?tab=review") });
    },
  });
}

// 卡壳提醒
async function onStuck(problemKey) {
  const session = await getSession(problemKey);
  if (!session || session.accepted) return; // 已 AC 则忽略
  const settings = await getSettings();
  if (!settings.notifications.onStuckEnabled) return;
  await notify({
    title: "卡住了?",
    message: `${session.slug} 已做 ${settings.notifications.onStuckMinutes} 分钟未 AC。要不要看一眼提示,或休息一下?`,
    buttons: [
      { title: "查看笔记/提示", action: "view" },
      { title: "继续", action: "later" },
    ],
    onButton: (action) => {
      if (action === "view") {
        chrome.tabs.create({ url: chrome.runtime.getURL("src/notes/note-viewer.html") });
      }
    },
  });
}

// ============ 消息路由 ============

export async function handleMessage(msg, sender) {
  if (!msg || !msg.type) return null;
  const { type, payload } = msg;
  logger.debug("coord", `msg: ${type}`);

  switch (type) {
    case "PROBLEM_ENTERED": return await onProblemEntered(payload || {}, sender);
    case "PROBLEM_META": return await onProblemMeta(payload || {});
    case "SUBMISSION_RESULT": return await onSubmissionResult(payload || {}, sender);
    case "TIMER_TICK": {
      // 更新 session elapsed(供 popup 实时显示)
      if (payload && payload.problemKey) {
        const s = await getSession(payload.problemKey);
        if (s && !s.accepted) {
          s.elapsedSec = payload.elapsedSec;
          await saveSession(payload.problemKey, s);
        }
      }
      return { ok: true };
    }
    case "TIMER_FINAL": {
      if (payload && payload.problemKey) {
        const s = await getSession(payload.problemKey);
        if (s) { s.elapsedSec = payload.elapsedSec; await saveSession(payload.problemKey, s); }
      }
      return { ok: true };
    }
    // —— UI 请求 ——
    case "GET_STATUS": return await getStatus();
    case "GET_NOTES": return await listNotes();
    case "GET_NOTE": return await getNote(payload.noteId);
    case "GET_DUE_REVIEWS": return await getDueReviews();
    case "GET_SETTINGS": return await getSettings();
    case "SAVE_SETTINGS": {
      const next = await saveSettings(payload || {});
      ensureDailyReviewAlarm(next.notifications.reviewCheckHour);
      return next;
    }
    case "GET_STATS": return await getStats();
    case "GENERATE_NOTE": return await generateNoteFor(payload.problemKey);
    case "REVIEW_GRADE": return await reviewNote(payload.noteId, payload.grade);
    case "DELETE_NOTE": await deleteNote(payload.noteId); return { ok: true };
    case "UPLOAD_NOTE": {
      const note = await getNote(payload.noteId);
      if (!note) return { ok: false, error: "note not found" };
      const reg = getUploaderRegistry();
      return await reg.upload(payload.uploader, note, { settings: await getSettings() });
    }
    case "GET_NOTE_MARKDOWN": {
      const note = await getNote(payload.noteId);
      return { markdown: note ? noteToMarkdown(note) : "" };
    }
    case "TRIGGER_REVIEW_CHECK": await runDailyReviewCheck(); return { ok: true };
    default:
      logger.warn("coord", `unknown message type: ${type}`);
      return null;
  }
}

async function getStatus() {
  const settings = await getSettings();
  const stats = await getStats();
  const due = await getDueReviews();
  // 找当前进行中的 session(取一个未 AC 的)
  const sessions = await chrome.storage.local.get("sessions").then((r) => r.sessions || {});
  const active = Object.values(sessions).find((s) => s && !s.accepted);
  return {
    hasLLM: !!(settings.llm.enabled && settings.llm.apiKey && settings.llm.baseURL),
    model: settings.llm.model,
    dueCount: due.length,
    stats,
    activeSession: active || null,
  };
}

// ============ 生命周期 ============

export async function initCoordinator() {
  const settings = await getSettings();
  if (settings.review.enableReminders) {
    ensureDailyReviewAlarm(settings.notifications.reviewCheckHour);
  }
  installAlarmListener(onStuck, runDailyReviewCheck);

  // 启动后立即检查一次今日到期复习(若跨天了)
  setTimeout(() => runDailyReviewCheck().catch((e) => logger.error("coord", "daily check", e)), 5000);

  // tab 关闭清理
  chrome.tabs.onRemoved.addListener((tabId) => {
    const pk = problemKeyByTab.get(tabId);
    if (pk) {
      problemKeyByTab.delete(tabId);
      tabMap.delete(pk);
    }
  });

  logger.info("coord", "coordinator initialized");
}
