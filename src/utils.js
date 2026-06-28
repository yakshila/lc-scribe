// 通用工具(ES module,供 background / agents / uploaders / llm / UI 使用)
// content script 不支持 import,其所需小工具直接内联在 content.js 的 window.LCC 命名空间中。

/** 从 leetcode.cn URL 提取题目 slug,匹配不到返回 null */
export function parseProblemSlug(url = location && location.href) {
  if (!url) return null;
  const m = String(url).match(/leetcode\.cn\/problems\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** 由 slug 生成稳定主键 */
export function problemKey(slug) {
  return `lc:${slug}`;
}

/** 秒数 → "12分34秒" */
export function formatDuration(sec) {
  if (sec == null || sec < 0 || Number.isNaN(sec)) return "—";
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}时${m}分${r}秒`;
  if (m > 0) return `${m}分${r}秒`;
  return `${r}秒`;
}

/** ISO 时间字符串 */
export function nowISO() {
  return new Date().toISOString();
}

/** 取今天 0 点的 Date(本地时区) */
export function startOfToday(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 生成笔记 id */
export function generateId(prefix = "note") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 安全 JSON 解析,失败返回 fallback */
export function safeJSONParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 从可能包含 ```json fence 的 LLM 文本中抽取 JSON */
export function extractJSON(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    t = t.slice(start, end + 1);
  }
  return safeJSONParse(t, null);
}

/** 截断字符串 */
export function truncate(s, n = 200) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let _level = LEVELS.info;
export function setLogLevel(l) {
  if (LEVELS[l] != null) _level = LEVELS[l];
}
export function log(level, tag, ...args) {
  if ((LEVELS[level] ?? LEVELS.info) < _level) return;
  const prefix = `[LCC:${level}][${tag}]`;
  if (level === "error") console.error(prefix, ...args);
  else if (level === "warn") console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}
export const logger = {
  debug: (tag, ...a) => log("debug", tag, ...a),
  info: (tag, ...a) => log("info", tag, ...a),
  warn: (tag, ...a) => log("warn", tag, ...a),
  error: (tag, ...a) => log("error", tag, ...a),
};
