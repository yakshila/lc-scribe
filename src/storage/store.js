// chrome.storage 封装 + 默认设置
// 存储分区:
//   settings   —— 全局配置(模型/通知/复习/agent/uploader)
//   notes      —— { [noteId]: Note }
//   problems   —— { [problemKey]: ProblemMeta }  题目元数据缓存
//   sessions   —— { [problemKey]: SessionState }  当前做题会话(计时/尝试)
//   reviews    —— { [noteId]: ReviewState }       复习调度状态
//   stats      —— 聚合统计

import { generateId, nowISO, logger } from "../utils.js";

export const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  llm: {
    enabled: false,
    baseURL: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    temperature: 0.3,
    maxTokens: 4000,
    timeoutMs: 60000,
  },
  notifications: {
    onAccepted: true,
    onStuckEnabled: true,
    onStuckMinutes: 15,
    onDueReview: true,
    reviewCheckHour: 9, // 每天复习检查时刻(本地时区 0-23)
  },
  notes: {
    autoGenerate: false, // AC 后自动生成笔记
    language: "zh",
    includeAISection: true,
    // 发给 LLM 的最近试错代码次数。0 = 全部;>0 = 只取最近 n 次(按时间倒序)的 run/submit 代码,
    // 用于控制 token 量。AC 代码始终单独传给 LLM,不受此限制影响。
    recentAttemptsToLLM: 0,
  },
  review: {
    algorithm: "SM-2",
    enableReminders: true,
    maxDuePerDay: 5,
  },
  agents: {
    enabled: ["note-generation", "code-analysis", "review-scheduler"],
  },
  uploaders: {
    feishu: { enabled: false, webhook: "", botName: "LC Scribe" },
    markdown: { enabled: true, autoDownload: false },
  },
};

/** 读取 settings,与默认值深合并 */
export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const merged = deepMerge(DEFAULT_SETTINGS, settings || {});
  // 迁移:旧的默认 maxTokens=1500 会导致笔记 JSON 被截断,统一提升到 4000
  if (!merged.llm || !merged.llm.maxTokens || merged.llm.maxTokens < 4000) {
    merged.llm = merged.llm || {};
    merged.llm.maxTokens = 4000;
  }
  // 迁移:旧的默认 timeoutMs=30000 对大模型不够,提升到 60000
  if (!merged.llm || !merged.llm.timeoutMs || merged.llm.timeoutMs < 60000) {
    merged.llm = merged.llm || {};
    merged.llm.timeoutMs = 60000;
  }
  return merged;
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = deepMerge(current, partial);
  next.schemaVersion = DEFAULT_SETTINGS.schemaVersion;
  await chrome.storage.local.set({ settings: next });
  return next;
}

// —— 笔记 ——

export async function getNote(noteId) {
  const { notes } = await chrome.storage.local.get("notes");
  return (notes && notes[noteId]) || null;
}

export async function listNotes() {
  const { notes } = await chrome.storage.local.get("notes");
  return notes ? Object.values(notes) : [];
}

/**
 * 按 problemKey 查找已有笔记(同题覆盖用)。
 * problemKey 形如 "lc:<slug>",这里用 meta.titleSlug 匹配 slug。
 * 同一题多次生成笔记时,复用旧笔记 id,使 saveNote 覆盖而非新增。
 */
export async function findNoteByProblemKey(problemKey) {
  if (!problemKey) return null;
  const slug = problemKey.startsWith("lc:") ? problemKey.slice(3) : problemKey;
  const { notes } = await chrome.storage.local.get("notes");
  if (!notes) return null;
  return Object.values(notes).find((n) => n && n.meta && n.meta.titleSlug === slug) || null;
}

export async function saveNote(note) {
  const { notes } = await chrome.storage.local.get("notes");
  const map = notes || {};
  const n = { ...note, updatedAt: nowISO() };
  map[n.id] = n;
  await chrome.storage.local.set({ notes: map });
  return n;
}

export async function deleteNote(noteId) {
  const { notes, reviews } = await chrome.storage.local.get(["notes", "reviews"]);
  if (notes && notes[noteId]) {
    delete notes[noteId];
    await chrome.storage.local.set({ notes });
  }
  if (reviews && reviews[noteId]) {
    delete reviews[noteId];
    await chrome.storage.local.set({ reviews });
  }
}

/** 批量删除笔记(含对应 review)。返回被实际删除的 noteId 数组。 */
export async function deleteNotes(noteIds) {
  if (!Array.isArray(noteIds) || noteIds.length === 0) return [];
  const { notes, reviews } = await chrome.storage.local.get(["notes", "reviews"]);
  const removed = [];
  if (notes) {
    for (const id of noteIds) {
      if (notes[id]) { delete notes[id]; removed.push(id); }
    }
    await chrome.storage.local.set({ notes });
  }
  if (reviews) {
    let changed = false;
    for (const id of noteIds) {
      if (reviews[id]) { delete reviews[id]; changed = true; }
    }
    if (changed) await chrome.storage.local.set({ reviews });
  }
  return removed;
}

// —— 题目元数据缓存 ——

export async function getProblem(problemKey) {
  const { problems } = await chrome.storage.local.get("problems");
  return (problems && problems[problemKey]) || null;
}

export async function saveProblem(problem) {
  const { problems } = await chrome.storage.local.get("problems");
  const map = problems || {};
  map[problem.key] = problem;
  await chrome.storage.local.set({ problems: map });
  return problem;
}

// —— 做题会话(进行中) ——

export async function getSession(problemKey) {
  const { sessions } = await chrome.storage.local.get("sessions");
  return (sessions && sessions[problemKey]) || null;
}

export async function saveSession(problemKey, session) {
  const { sessions } = await chrome.storage.local.get("sessions");
  const map = sessions || {};
  map[problemKey] = session;
  await chrome.storage.local.set({ sessions: map });
  return session;
}

export async function deleteSession(problemKey) {
  const { sessions } = await chrome.storage.local.get("sessions");
  if (sessions && sessions[problemKey]) {
    delete sessions[problemKey];
    await chrome.storage.local.set({ sessions });
  }
}

// —— 复习状态 ——

export async function getReview(noteId) {
  const { reviews } = await chrome.storage.local.get("reviews");
  return (reviews && reviews[noteId]) || null;
}

export async function saveReview(noteId, review) {
  const { reviews } = await chrome.storage.local.get("reviews");
  const map = reviews || {};
  map[noteId] = review;
  await chrome.storage.local.set({ reviews: map });
  return review;
}

export async function listReviews() {
  const { reviews } = await chrome.storage.local.get("reviews");
  return reviews ? Object.values(reviews) : [];
}

// —— 统计 ——
// totalAccepted 与 totalNotes 为派生值,永远与真实数据一致:
//   totalAccepted = acceptedProblems 集合大小(按 problemKey 去重,同题多次 AC 只算一次)
//   totalNotes    = notes 实际数量(删笔记即同步,无需手动维护)
// 仅 totalReviewsDone / streakDays / lastActiveDate 为累加存储。

export async function getStats() {
  const { stats, notes } = await chrome.storage.local.get(["stats", "notes"]);
  const base = stats || {};
  const acceptedProblems = base.acceptedProblems || {};
  return {
    acceptedProblems,
    totalAccepted: Object.keys(acceptedProblems).length, // 派生:按题去重
    totalNotes: notes ? Object.keys(notes).length : 0,    // 派生:真实笔记数
    totalReviewsDone: base.totalReviewsDone || 0,
    streakDays: base.streakDays || 0,
    lastActiveDate: base.lastActiveDate || null,
  };
}

export async function bumpStats(patch) {
  const cur = await getStats();
  // 派生字段不接受外部覆盖,始终由真实数据计算
  const { totalAccepted, totalNotes, ...rest } = patch;
  const base = await chrome.storage.local.get("stats").then((r) => r.stats || {});
  const next = { ...base, ...rest };
  await chrome.storage.local.set({ stats: next });
  return getStats();
}

/** 标记某题已 AC(按 problemKey 去重,重复标记幂等)。 */
export async function markAccepted(problemKey) {
  const base = await chrome.storage.local.get("stats").then((r) => r.stats || {});
  const acceptedProblems = { ...(base.acceptedProblems || {}), [problemKey]: nowISO() };
  await chrome.storage.local.set({
    stats: { ...base, acceptedProblems, lastActiveDate: new Date().toISOString().slice(0, 10) },
  });
  return getStats();
}

/** 清空计数(AC 计数 + 复习计数 + 连续天数)。笔记本身不动,totalNotes 因派生而保留。 */
export async function clearStats() {
  const base = await chrome.storage.local.get("stats").then((r) => r.stats || {});
  await chrome.storage.local.set({
    stats: {
      ...base,
      acceptedProblems: {},
      totalReviewsDone: 0,
      streakDays: 0,
      lastActiveDate: null,
    },
  });
  return getStats();
}

// —— 工具 ——

export function deepMerge(base, override) {
  if (override === undefined || override === null) return structuredClone ? structuredClone(base) : JSON.parse(JSON.stringify(base));
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return override === undefined ? base : override;
  }
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(override)) {
    if (
      base[k] &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k]) &&
      override[k] &&
      typeof override[k] === "object" &&
      !Array.isArray(override[k])
    ) {
      out[k] = deepMerge(base[k], override[k]);
    } else if (override[k] !== undefined) {
      out[k] = override[k];
    }
  }
  return out;
}

/** 新建空笔记骨架,带 id 与时间戳 */
export function newNoteSkeleton(problem) {
  return {
    id: generateId("note"),
    version: 1,
    meta: {
      problemId: problem.problemId,
      titleSlug: problem.titleSlug,
      title: problem.title,
      difficulty: problem.difficulty,
      tags: problem.tags || [],
      url: problem.url,
      site: "leetcode.cn",
    },
    solving: {
      startedAt: null,
      acceptedAt: null,
      durationSec: 0,
      attemptCount: 0,
      firstAccepted: false,
      languagesUsed: [],
      // 完整做题轨迹:每一次运行/提交的快照,供 AI 分析踩坑点、用户回顾试错过程。
      // 元素结构: { kind: "run"|"submit", status, statusMsg, runtime, memory, lang, submissionId, ts, code?, url? }
      timeline: [],
    },
    approach: {
      intuition: "",
      approach: "",
      algorithm: "",
      dataStructures: [],
      complexity: { time: "", space: "" },
    },
    code: {
      language: "",
      solution: "",
      keyLines: [],
    },
    insights: {
      pitfalls: [],
      lessonsLearned: [],
      patterns: [],
      relatedProblems: [],
    },
    review: {
      algorithm: "SM-2",
      interval: 1,
      ease: 2.5,
      repetitions: 0,
      nextReviewAt: null,
      lastReviewedAt: null,
      reviewHistory: [],
    },
    aiGenerated: {
      summary: "",
      alternativeApproaches: [],
      commonMistakes: [],
      interviewTips: "",
      explanation: null, // 最优方案通俗讲解,由 GENERATE_EXPLANATION 触发生成
    },
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
}

logger.debug("store", "module loaded");
