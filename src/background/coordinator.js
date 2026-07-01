// Coordinator —— 后台核心编排器。
// 职责:路由消息(content / popup / options)、协调存储 / 通知 / 定时器 / Agent / Uploader / 复习。
import { logger, formatDuration, nowISO, parseProblemSlug } from "../utils.js";
import {
  getSettings, saveSettings,
  getSession, saveSession, deleteSession,
  getProblem, saveProblem,
  getNote, listNotes, saveNote, deleteNote, deleteNotes, findNoteByProblemKey,
  getReview, saveReview, listReviews,
  getStats, bumpStats, markAccepted, clearStats,
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
import { chatComplete } from "../llm/llm-client.js";
import { buildExplanationPrompt, parseExplanationResult } from "../llm/prompts.js";

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
  const { problemKey, slug, status, statusMsg, runtime, memory, code, lang, accepted, submissionId, kind, url } = payload;
  if (!problemKey) return { ok: false, error: "no problemKey" };

  let session = await getSession(problemKey);
  if (!session) {
    session = { problemKey, slug, url: payload.url || null, startedAt: nowISO(), attempts: [], accepted: false, languagesUsed: [] };
  }
  session.attempts = session.attempts || [];

  // 区分运行(run)和提交(submit),两种都记入 session,形成完整做题轨迹。
  // run: 点"运行" -> interpret_solution,通常没 submissionId(用 runcode_xxx)
  // submit: 点"提交" -> /submit/,有正式 submissionId
  const isRun = kind === "run" || (submissionId && String(submissionId).startsWith("runcode_"));
  const attempt = {
    kind: isRun ? "run" : "submit",
    status, statusMsg,
    runtime, memory, lang,
    submissionId, ts: nowISO(),
  };
  if (code) attempt.code = code;
  if (url) attempt.url = url;
  session.attempts.push(attempt);

  session.languagesUsed = session.languagesUsed || [];
  if (lang && !session.languagesUsed.includes(lang)) session.languagesUsed.push(lang);

  let becameAccepted = false;
  // 只有 submit 且 accepted 才算真正 AC(runs 不算)
  if (accepted && !isRun && !session.accepted) {
    session.accepted = true;
    session.acceptedAt = nowISO();
    // firstAccepted: 提交(非 run)里第一次 AC
    session.firstAccepted = session.attempts.filter((a) => a.kind !== "run").length === 1;
    becameAccepted = true;
    if (session.startedAt) {
      // 优先用 timer-tracker 上报的有效活跃时长(elapsedSec,已扣除切走 tab / 失焦的时间),
      // 这样切换 tab 期间不计入做题用时。elapsedSec 由 TIMER_TICK 每 30s 上报,
      // 切走时 visibilitychange 暂停累加,切回恢复 —— 真正反映"盯着这道题的时间"。
      // 兜底:若 timer 从未上报(如刚进入就立刻 AC),用墙上时钟差值。
      const wall = Math.max(0, Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000));
      session.durationSec = (session.elapsedSec && session.elapsedSec > 0) ? session.elapsedSec : wall;
    }
    clearStuckAlarm(problemKey);
    sendToProblemTab(problemKey, { type: "TIMER_STOP" });
  }
  await saveSession(problemKey, session);
  logger.info("coord", `${isRun ? "run" : "submission"}: ${slug} -> ${status}${becameAccepted ? " (NEW AC)" : ""} | attempts=${session.attempts.length}`);

  if (becameAccepted) {
    logger.info("coord", `AC detected for ${problemKey}, triggering onAccepted`);
    onAccepted(problemKey, session).catch((e) => logger.error("coord", "onAccepted", e));
  }
  return { ok: true, accepted: becameAccepted };
}

async function onAccepted(problemKey, session) {
  const settings = await getSettings();
  // 统计:按 problemKey 去重记录 AC(markAccepted 幂等,同题多次 AC 只算一次)
  await markAccepted(problemKey);

  if (settings.notifications.onAccepted) {
    const result = await notify({
      id: `lcc-accept-${problemKey}-${Date.now()}`,
      title: "Accepted!",
      message: `${session.slug} · 用时 ${formatDuration(session.durationSec)} · ${session.attempts.length} 次提交`,
      buttons: [
        { title: "生成笔记", action: "generate-note" },
        { title: "稍后", action: "later" },
      ],
      onButton: (action) => {
        if (action === "generate-note") {
          runNoteGenerationWithProgress(problemKey).catch((e) => logger.error("coord", "gen-note from notif", e));
        }
      },
    });
    // 系统通知失败时,在 LeetCode 页面内弹 toast 兜底,确保用户能看到 AC 提示
    if (!result || !result.ok) {
      sendToastToActiveTab({
        title: "Accepted!",
        message: `${session.slug} · 用时 ${formatDuration(session.durationSec)} · ${session.attempts.length} 次提交`,
        type: "success",
        duration: 30000, // 带按钮的 toast 保留 30 秒,给用户时间点
        buttons: [
          { title: "生成笔记", action: "generate-note", problemKey },
          { title: "稍后", action: "later" },
        ],
      });
    }
  }
  if (settings.notes.autoGenerate) {
    await runNoteGenerationWithProgress(problemKey);
  }
}

// ============ 笔记生成 ============

export async function generateNoteFor(problemKey) {
  const session = await getSession(problemKey);
  const problem = await getProblem(problemKey);
  if (!session) throw new Error(`no session for ${problemKey}`);

  // 即使 GQL 失败导致 problem 元数据缺失,也用 session 里的 slug 构造兜底骨架,
  // 让 agent 链路能继续执行(否则用户看不到任何 prompt 日志,无法诊断)。
  let problemMeta = problem;
  // 如果 problem meta 缺失或 partial,尝试向 content script 同步拉取一次(GQL),
  // 解决"进入题目时 GQL 还没回来就 AC 了"的竞态。
  if (!problemMeta || problemMeta.partial) {
    const slug = (session && session.slug) || (problemKey && problemKey.startsWith("lc:") ? problemKey.slice(3) : problemKey);
    const tabId = tabMap.get(problemKey);
    if (tabId != null) {
      logger.info("coord", `problem meta missing/partial for ${problemKey}, requesting REFRESH_PROBLEM_META from tab ${tabId}`);
      try {
        const resp = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { type: "REFRESH_PROBLEM_META", payload: { slug } }, (r) => {
            if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
            else resolve(r);
          });
        });
        if (resp && resp.ok && resp.problem) {
          problemMeta = resp.problem;
          await saveProblem(problemMeta);
          logger.info("coord", `REFRESH_PROBLEM_META success: id=${problemMeta.problemId} title=${problemMeta.title}`);
        } else {
          logger.warn("coord", `REFRESH_PROBLEM_META failed:`, resp && resp.error);
        }
      } catch (e) {
        logger.warn("coord", `REFRESH_PROBLEM_META exception:`, e);
      }
    }
  }
  if (!problemMeta) {
    const slug = (session && session.slug) || (problemKey && problemKey.startsWith("lc:") ? problemKey.slice(3) : problemKey);
    problemMeta = {
      problemId: 0,
      titleSlug: slug,
      title: slug,
      difficulty: "Unknown",
      tags: [],
      isPaid: false,
      url: (session && session.url) || `https://leetcode.cn/problems/${slug}/`,
      related: [],
      fetchedAt: nowISO(),
      key: problemKey,
      partial: true,
    };
    logger.warn("coord", `problem meta still missing for ${problemKey}, using fallback skeleton. agent chain continues with partial data.`);
  } else if (problemMeta.partial) {
    logger.warn("coord", `problem meta is partial for ${problemKey} (problemId=${problemMeta.problemId}), GQL full meta may not have arrived yet`);
  } else {
    logger.info("coord", `problem meta OK for ${problemKey}: id=${problemMeta.problemId} title=${problemMeta.title} difficulty=${problemMeta.difficulty}`);
  }

  const settings = await getSettings();

  // 同题覆盖:若该题已有笔记,复用其 id,使 saveNote 覆盖旧笔记而非新增。
  // 同时保留旧笔记的 createdAt 与 review 调度状态,
  // 避免重新生成笔记导致复习进度(SM-2 interval/ease/repetitions)丢失。
  const existing = await findNoteByProblemKey(problemKey);
  const note = newNoteSkeleton(problemMeta);
  if (existing) {
    note.id = existing.id;
    note.createdAt = existing.createdAt;
    if (existing.review) note.review = existing.review;
    logger.info("coord", `overwrite existing note ${existing.id} for ${problemKey}`);
  }
  note.solving.startedAt = session.startedAt;
  note.solving.acceptedAt = session.acceptedAt;
  note.solving.durationSec = session.durationSec || 0;
  note.solving.firstAccepted = !!session.firstAccepted;
  note.solving.languagesUsed = session.languagesUsed || [];

  // 完整做题轨迹:把 session.attempts 整理成 timeline(runs + submits 全部)
  const allAttempts = session.attempts || [];
  note.solving.timeline = allAttempts.map((a) => ({
    kind: a.kind || (a.submissionId && String(a.submissionId).startsWith("runcode_") ? "run" : "submit"),
    status: a.status,
    statusMsg: a.statusMsg,
    runtime: a.runtime,
    memory: a.memory,
    lang: a.lang,
    submissionId: a.submissionId,
    ts: a.ts,
    code: a.code || "",
    url: a.url,
  }));
  // attemptCount:只数 submit(运行不算正式提交)
  note.solving.attemptCount = allAttempts.filter((a) => (a.kind || "submit") === "submit").length;

  const acceptedAttempt = [...allAttempts].reverse().find((a) => (a.kind || "submit") === "submit" && /accepted/i.test(a.status));
  logger.info("coord", `acceptedAttempt found: ${!!acceptedAttempt}` + (acceptedAttempt ? ` | lang=${acceptedAttempt.lang || "(empty)"} | codeLen=${(acceptedAttempt.code || "").length} | runtime=${acceptedAttempt.runtime ?? "?"}` : ` | attempts statuses=${allAttempts.map(a => `${a.kind || "submit"}:${a.status}`).join(",")}`) + ` | timeline=${note.solving.timeline.length} (runs=${allAttempts.filter(a=>(a.kind||"submit")==="run").length}, submits=${note.solving.attemptCount})`);
  if (acceptedAttempt) {
    note.code.language = acceptedAttempt.lang || "";
    note.code.solution = acceptedAttempt.code || "";
  }
  // 把失败尝试摘要给 agent 参考(运行和提交都算,体现完整试错过程)
  const failedAttempts = allAttempts.filter((a) => !/accepted/i.test(a.status));

  // 按配置裁剪发给 LLM 的试错代码:recentAttemptsToLLM>0 时只取最近 n 次,
  // 控制 token 量。note.solving.timeline 仍保存完整轨迹(笔记不丢数据),
  // 仅裁剪传给 Agent 的 ctx.timeline / ctx.failedAttempts。
  // AC 代码在 note.code.solution 里单独传给 LLM,不受此裁剪影响。
  const limit = Number(settings.notes && settings.notes.recentAttemptsToLLM);
  const sliceRecent = (arr) => (Number.isFinite(limit) && limit > 0 ? arr.slice(-limit) : arr);
  const ctxTimeline = sliceRecent(note.solving.timeline);
  const ctxFailedAttempts = sliceRecent(failedAttempts);
  if (limit > 0 && (ctxTimeline.length < note.solving.timeline.length || ctxFailedAttempts.length < failedAttempts.length)) {
    logger.info("coord", `recentAttemptsToLLM=${limit}: timeline ${note.solving.timeline.length}->${ctxTimeline.length}, failed ${failedAttempts.length}->${ctxFailedAttempts.length} (note keeps full timeline)`);
  }

  const ctx = { note, session, problem: problemMeta, settings, failedAttempts: ctxFailedAttempts, timeline: ctxTimeline };

  const registry = getAgentRegistry();
  const enabled = settings.agents.enabled || [];
  logger.info("coord", `generateNoteFor: agents.enabled=${JSON.stringify(enabled)} llm.enabled=${settings.llm && settings.llm.enabled} autoGenerate=${settings.notes && settings.notes.autoGenerate}`);

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
  // totalNotes 为派生值(= notes 实际数量),无需手动维护;
  // 同题覆盖时 notes 数量不变,新增时自动 +1,删除时自动 -1。

  await maybeAutoUpload(note);

  logger.info("coord", `note generated: ${note.id} for ${problemKey}`);
  return note;
}

// 带进度反馈的笔记生成:在 LeetCode 页弹常驻 toast,显示 loading → success/error。
// 解决"点通知按钮后通知立即消失,几十秒黑盒不知道生成状态"的问题。
// loading 态 sticky 常驻(带 spinner);成功后变 success 态带「查看笔记」按钮(30s 后消失);
// 失败后变 error 态显示错误信息(15s 后消失)。
async function runNoteGenerationWithProgress(problemKey) {
  const toastId = `gen-note-${problemKey}`;
  // 1. 弹 loading toast(state=loading 默认 sticky,带 spinner)
  await sendToastToActiveTab({
    id: toastId,
    title: "正在生成笔记…",
    message: "AI 正在分析你的做题过程,约 20-60 秒",
    state: "loading",
  });
  // 2. 生成笔记(可能耗时几十秒)
  try {
    const note = await generateNoteFor(problemKey);
    // 3. 成功:用同 id 更新为 success 态,带查看按钮
    await sendToastToActiveTab({
      id: toastId,
      title: "笔记已生成 ✓",
      message: note.meta.title || note.meta.titleSlug || problemKey,
      state: "success",
      duration: 30000,
      buttons: [{ title: "查看笔记", action: "view-note", noteId: note.id }],
    });
    return note;
  } catch (e) {
    logger.error("coord", `gen-note progress failed for ${problemKey}`, e);
    // 失败:更新为 error 态,显示错误
    await sendToastToActiveTab({
      id: toastId,
      title: "笔记生成失败",
      message: String(e && e.message || e),
      state: "error",
      duration: 15000,
    });
    throw e;
  }
}

// ============ AI 解答生成 ============
// 基于题目元数据(不依赖用户做题过程),调 LLM 产出通俗易懂的「最优方案」讲解。
// 结果存入 note.aiGenerated.explanation。可由复习通知按钮或详情页按钮触发。
export async function generateExplanationFor(noteId) {
  const note = await getNote(noteId);
  if (!note) throw new Error(`note not found: ${noteId}`);

  const settings = await getSettings();
  if (!settings.llm || !settings.llm.enabled) {
    throw new Error("LLM 未启用,请在设置中配置模型");
  }

  const slug = note.meta && note.meta.titleSlug;
  const problemKey = slug ? `lc:${slug}` : null;
  const problem = problemKey ? await getProblem(problemKey) : null;

  const ctx = { note, problem, settings };
  const { system, user } = buildExplanationPrompt(ctx);

  logger.info("coord", `generateExplanationFor: note=${noteId} slug=${slug || "?"} model=${settings.llm.model || "?"}`);

  const text = await chatComplete(settings.llm, [
    { role: "system", content: system },
    { role: "user", content: user },
  ], { responseFormatJSON: true });

  const parsed = parseExplanationResult(text);
  if (!parsed || !parsed.explanation) {
    throw new Error("AI 解答解析失败");
  }

  note.aiGenerated = note.aiGenerated || {};
  note.aiGenerated.explanation = parsed.explanation;
  await saveNote(note);

  logger.info("coord", `explanation generated for ${noteId} (${slug || "?"})`);
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

// 自定义下次复习时间:用户手动指定 N 天后复习,覆盖 SM-2 算法结果。
// 用于「这题我想提前/延后复习」场景。保留 ease/repetitions/reviewHistory,
// 只改 interval + nextReviewAt,并标记 customSet=true 便于追溯。
export async function setCustomReview(noteId, days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n < 1) throw new Error(`days must be >= 1, got ${days}`);
  const cap = Math.min(n, 365);
  const review = (await getReview(noteId)) || sm2Init();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const next = {
    ...review,
    interval: cap,
    nextReviewAt: new Date(Date.now() + cap * DAY_MS).toISOString(),
    lastReviewedAt: nowISO(),
    customSet: true, // 标记本次是用户手动设定,非 SM-2 算出
  };
  await saveReview(noteId, next);
  const note = await getNote(noteId);
  if (note) {
    note.review = next;
    await saveNote(note);
  }
  logger.info("coord", `custom review set: note=${noteId} in ${cap} day(s)`);
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
  // 每天只提醒一次:记录上次提醒日期,同一天内 SW 多次唤醒(浏览器打开/从最小化恢复/切 tab)
  // 都不重复弹通知。日期用本地时区 YYYY-MM-DD。
  const today = new Date().toISOString().slice(0, 10);
  const stats = await getStats();
  if (stats.lastReviewNotifiedDate === today) {
    logger.debug("coord", `review already notified today (${today}), skip`);
    return;
  }
  const due = await getDueReviews();
  if (due.length === 0) return;
  const max = settings.review.maxDuePerDay || 5;
  await notify({
    title: "今日复习提醒",
    message: `有 ${due.length} 道题到期复习${due.length > max ? `(建议先做 ${max} 道)` : ""}。点击查看,或用 AI 解答辅助复习。`,
    buttons: [
      { title: "生成 AI 解答", action: "generate-explanation" },
      { title: "稍后", action: "later" },
    ],
    onClick: () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/notes/note-viewer.html?tab=review") });
    },
    onButton: (action) => {
      if (action === "generate-explanation") {
        // 为到期复习题逐道生成「最优方案」AI 解答,限制在 maxDuePerDay 内控制 LLM 调用量。
        // 并发触发(不串行等待),每道独立 catch,失败不影响其他题。
        const target = due.slice(0, max);
        logger.info("coord", `generate explanations for ${target.length} due notes (from review notif)`);
        target.forEach(({ note }) => {
          if (note && note.id) {
            generateExplanationFor(note.id).catch((e) => logger.error("coord", `gen-explanation for ${note.id} failed`, e));
          }
        });
        // 同时打开复习页,让用户看到生成进度与结果
        chrome.tabs.create({ url: chrome.runtime.getURL("src/notes/note-viewer.html?tab=review") });
      }
    },
  });
  // 标记今天已提醒。即使 notify 失败也标记,避免 SW 反复唤醒时刷屏。
  await bumpStats({ lastReviewNotifiedDate: today });
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

// 向当前激活的 LeetCode 标签页发送 toast 消息(系统通知失败时兜底)
async function sendToastToActiveTab(payload) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (tab && tab.url && /leetcode\.cn/.test(tab.url)) {
      chrome.tabs.sendMessage(tab.id, { type: "SHOW_TOAST", payload }, () => {
        if (chrome.runtime.lastError) {
          // content script 没注入或已失效,忽略
          logger.warn("coord", "toast send failed:", chrome.runtime.lastError.message);
        }
      });
    }
  } catch (e) {
    logger.warn("coord", "sendToastToActiveTab error:", e);
  }
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
    case "TOAST_BUTTON": {
      // toast 按钮点击回调(系统通知失败时的兜底交互 + 进度 toast 的「查看笔记」按钮)
      const { action, problemKey, noteId } = payload || {};
      logger.info("coord", `toast button: ${action} for ${problemKey || noteId}`);
      if (action === "generate-note" && problemKey) {
        runNoteGenerationWithProgress(problemKey).catch((e) => logger.error("coord", "gen-note from toast", e));
      } else if (action === "view-note" && noteId) {
        chrome.tabs.create({ url: chrome.runtime.getURL(`src/notes/note-viewer.html?id=${noteId}`) });
      }
      return { ok: true };
    }
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
    case "CLEAR_STATS": return await clearStats();
    case "GENERATE_NOTE": return await generateNoteFor(payload.problemKey);
    case "GENERATE_EXPLANATION": return await generateExplanationFor(payload.noteId);
    case "REVIEW_GRADE": return await reviewNote(payload.noteId, payload.grade);
    case "SET_CUSTOM_REVIEW": return await setCustomReview(payload.noteId, payload.days);
    case "DELETE_NOTE": await deleteNote(payload.noteId); return { ok: true };
    case "DELETE_NOTES": {
      // 批量删除笔记(含对应 review)。payload.noteIds: string[]
      const removed = await deleteNotes(payload.noteIds || []);
      return { removed, count: removed.length };
    }
    case "UPLOAD_NOTE": {
      const note = await getNote(payload.noteId);
      if (!note) return { ok: false, error: "note not found" };
      const reg = getUploaderRegistry();
      return await reg.upload(payload.uploader, note, { settings: await getSettings() });
    }
    case "BATCH_UPLOAD": {
      // 批量上传。payload: { noteIds: string[], uploader: string }
      const ids = payload.noteIds || [];
      const uploader = payload.uploader;
      const reg = getUploaderRegistry();
      const settings = await getSettings();
      const results = [];
      for (const id of ids) {
        const note = await getNote(id);
        if (!note) { results.push({ id, success: false, message: "note not found" }); continue; }
        const r = await reg.upload(uploader, note, { settings });
        results.push({ id, ...r });
      }
      const ok = results.filter((r) => r.success).length;
      return { results, total: ids.length, success: ok, failed: ids.length - ok };
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
  // 当前做题:优先取「当前激活 LeetCode tab 对应的 session」。
  // 这样关闭旧题 tab、打开新题后,popup 不会卡在旧题的 session 上。
  // 回退:只考虑「tabMap 里仍打开着的 LeetCode tab 对应的未 AC session」,
  // 避免关掉所有 LeetCode tab 后还显示历史 session。
  const sessions = await chrome.storage.local.get("sessions").then((r) => r.sessions || {});
  let active = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /leetcode\.cn/.test(tab.url)) {
      const slug = parseProblemSlug(tab.url);
      if (slug) {
        active = sessions[`lc:${slug}`] || null;
      }
    }
  } catch (e) { /* SW 权限/异常时忽略,走回退 */ }
  if (!active) {
    // 回退:在仍打开着的 LeetCode tab 对应的 session 里找未 AC 的
    const openKeys = new Set([...tabMap.keys()]);
    active = Object.values(sessions).find((s) => s && !s.accepted && openKeys.has(s.problemKey)) || null;
  }
  return {
    hasLLM: !!(settings.llm.enabled && settings.llm.apiKey && settings.llm.baseURL),
    model: settings.llm.model,
    dueCount: due.length,
    stats,
    activeSession: active,
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
