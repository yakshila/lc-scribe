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
    maxTokens: 1500,
    timeoutMs: 30000,
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
  return deepMerge(DEFAULT_SETTINGS, settings || {});
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

export async function getStats() {
  const { stats } = await chrome.storage.local.get("stats");
  return stats || { totalAccepted: 0, totalNotes: 0, totalReviewsDone: 0, streakDays: 0, lastActiveDate: null };
}

export async function bumpStats(patch) {
  const cur = await getStats();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ stats: next });
  return next;
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
    },
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
}

logger.debug("store", "module loaded");
