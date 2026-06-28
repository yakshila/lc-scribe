// 笔记结构定义 + 校验
// 这是 LC Scribe 笔记的核心数据契约,Agent 产出 / UI 展示 / Uploader 上传 都以此为准。
//
// 设计原则:
//  1) meta(只读、客观):题目元数据,来自 LeetCode,不含主观判断。
//  2) solving(客观、行为):做题过程数据,由插件自动采集,体现"这次做得怎么样"。
//  3) approach(主观、解法):解法思路与复杂度,可由用户编辑,Agent 辅助填充。
//  4) code(客观 + 标注):AC 代码,Agent 可标注关键行。
//  5) insights(主观、提炼):坑点/经验/模式/关联题,Agent 辅助提炼。
//  6) review(调度):SM-2 复习调度状态。
//  7) aiGenerated(AI 增量):Agent 生成的额外内容,与用户可编辑字段分离,便于追溯。

export const NOTE_SCHEMA_VERSION = 1;

export const NOTE_FIELDS = {
  meta: {
    problemId: "number 题号",
    titleSlug: "string URL slug,如 two-sum",
    title: "string 题目标题",
    difficulty: "Easy|Medium|Hard",
    tags: "string[] 标签,如 ['数组','哈希表']",
    url: "string 题目 URL",
    site: "leetcode.cn",
  },
  solving: {
    startedAt: "ISO 进入题目时刻",
    acceptedAt: "ISO 首次 AC 时刻(null 表示未 AC)",
    durationSec: "number 从开始到 AC 的秒数",
    attemptCount: "number 提交次数(不含运行)",
    firstAccepted: "boolean 是否一次 AC",
    languagesUsed: "string[] 用过的语言",
    timeline: "{kind:'run'|'submit', status, statusMsg, runtime, memory, lang, submissionId, ts, code?, url?}[] 完整做题轨迹(运行+提交)",
  },
  approach: {
    intuition: "string 题目直觉/第一想法",
    approach: "string 解法步骤描述",
    algorithm: "string 算法名称,如 '哈希表一次遍历'",
    dataStructures: "string[] 用到的数据结构",
    complexity: { time: "O(n)", space: "O(n)" },
  },
  code: {
    language: "string 提交语言,如 python3",
    solution: "string AC 代码",
    keyLines: "{line:number, note:string}[] 关键行标注",
  },
  insights: {
    pitfalls: "string[] 自己踩的坑",
    lessonsLearned: "string[] 学到的东西",
    patterns: "string[] 可复用模式",
    relatedProblems: "string[] 相关题号/slug",
  },
  review: {
    algorithm: "SM-2",
    interval: "number 下次复习间隔(天)",
    ease: "number 难度系数(SM-2 ease factor)",
    repetitions: "number 连续答对次数",
    nextReviewAt: "ISO 下次复习时间",
    lastReviewedAt: "ISO 上次复习时间",
    reviewHistory: "{date:ISO, grade:0-5}[]",
  },
  aiGenerated: {
    summary: "string 一句话总结",
    alternativeApproaches: "string[] 其他解法",
    commonMistakes: "string[] 常见错误",
    interviewTips: "string 面试建议",
  },
};

/** 复习质量评分(SM-2 标准 0-5) */
export const REVIEW_GRADES = {
  AGAIN: 0, // 完全忘记
  HARD: 2, // 想起来但很费劲
  GOOD: 4, // 正常回忆起来
  EASY: 5, // 轻松
};

/** 轻量校验:返回 {valid, errors[]} */
export function validateNote(note) {
  const errors = [];
  if (!note || typeof note !== "object") return { valid: false, errors: ["note is not an object"] };
  if (!note.id) errors.push("missing id");
  if (!note.meta || !note.meta.titleSlug) errors.push("missing meta.titleSlug");
  if (!note.meta || !note.meta.problemId) errors.push("missing meta.problemId");
  if (!note.solving) errors.push("missing solving");
  if (!note.approach) errors.push("missing approach");
  if (!note.code) errors.push("missing code");
  if (!note.review) errors.push("missing review");
  return { valid: errors.length === 0, errors };
}

/** 把 Note 渲染成 Markdown(供 markdown uploader / 复制用) */
export function noteToMarkdown(note) {
  if (!note) return "";
  const m = note.meta;
  const s = note.solving;
  const a = note.approach;
  const c = note.code;
  const ins = note.insights;
  const ai = note.aiGenerated;
  const L = ["# " + (m.title || m.titleSlug), ""];

  L.push(`> 题号: **${m.problemId}** · 难度: **${m.difficulty}** · 标签: ${(m.tags || []).join(", ") || "—"}  `);
  L.push(`> 链接: ${m.url}  `);
  L.push("");

  L.push("## 做题过程");
  L.push(`- 开始: ${s.startedAt || "—"}`);
  L.push(`- AC: ${s.acceptedAt || "未 AC"}`);
  L.push(`- 用时: ${fmtDur(s.durationSec)} · 提交次数: ${s.attemptCount} · 一次 AC: ${s.firstAccepted ? "是" : "否"}`);
  L.push(`- 语言: ${(s.languagesUsed || []).join(", ") || "—"}`);
  L.push("");

  // 完整做题轨迹(运行 + 提交),体现试错过程
  if (s.timeline && s.timeline.length) {
    L.push("## 做题轨迹");
    L.push("| # | 类型 | 结果 | runtime | memory | 语言 | 时间 |");
    L.push("|---|------|------|---------|--------|------|------|");
    s.timeline.forEach((a, i) => {
      const kindLabel = a.kind === "run" ? "运行" : "提交";
      const rt = a.runtime != null ? `${a.runtime}ms` : "—";
      const mem = a.memory != null ? `${a.memory}B` : "—";
      const t = a.ts ? new Date(a.ts).toLocaleString("zh-CN", { hour12: false }) : "—";
      L.push(`| ${i + 1} | ${kindLabel} | ${a.status} | ${rt} | ${mem} | ${a.lang || "—"} | ${t} |`);
    });
    L.push("");
  }

  L.push("## 思路");
  if (a.intuition) L.push(`**直觉**: ${a.intuition}`, "");
  if (a.approach) L.push(`**解法**: ${a.approach}`, "");
  if (a.algorithm) L.push(`- 算法: ${a.algorithm}`);
  if ((a.dataStructures || []).length) L.push(`- 数据结构: ${a.dataStructures.join(", ")}`);
  if (a.complexity) L.push(`- 复杂度: 时间 ${a.complexity.time || "—"} / 空间 ${a.complexity.space || "—"}`);
  L.push("");

  L.push("## 代码");
  if (c.language) L.push("```" + langToFence(c.language));
  if (c.solution) L.push(c.solution);
  if (c.language) L.push("```");
  L.push("");

  if (c.keyLines && c.keyLines.length) {
    L.push("**关键行**:");
    for (const k of c.keyLines) L.push(`- L${k.line}: ${k.note}`);
    L.push("");
  }

  if (ins && (ins.pitfalls?.length || ins.lessonsLearned?.length || ins.patterns?.length || ins.relatedProblems?.length)) {
    L.push("## 经验提炼");
    if (ins.pitfalls?.length) { L.push("**踩坑**:"); ins.pitfalls.forEach((x) => L.push(`- ${x}`)); }
    if (ins.lessonsLearned?.length) { L.push("**收获**:"); ins.lessonsLearned.forEach((x) => L.push(`- ${x}`)); }
    if (ins.patterns?.length) { L.push("**可复用模式**:"); ins.patterns.forEach((x) => L.push(`- ${x}`)); }
    if (ins.relatedProblems?.length) { L.push("**相关题目**: " + ins.relatedProblems.join(", ")); }
    L.push("");
  }

  if (ai && (ai.summary || ai.alternativeApproaches?.length || ai.commonMistakes?.length || ai.interviewTips)) {
    L.push("## AI 补充");
    if (ai.summary) L.push(`**总结**: ${ai.summary}`, "");
    if (ai.alternativeApproaches?.length) { L.push("**其他解法**:"); ai.alternativeApproaches.forEach((x) => L.push(`- ${x}`)); }
    if (ai.commonMistakes?.length) { L.push("**常见错误**:"); ai.commonMistakes.forEach((x) => L.push(`- ${x}`)); }
    if (ai.interviewTips) L.push("", `**面试建议**: ${ai.interviewTips}`);
    L.push("");
  }

  if (note.review) {
    L.push("## 复习");
    L.push(`- 下次复习: ${note.review.nextReviewAt || "—"}`);
    L.push(`- 间隔: ${note.review.interval} 天 · 难度系数: ${note.review.ease} · 连续答对: ${note.review.repetitions}`);
    L.push("");
  }

  return L.join("\n");
}

function fmtDur(sec) {
  if (!sec && sec !== 0) return "—";
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return m > 0 ? `${m}分${r}秒` : `${r}秒`;
}
function langToFence(lang) {
  const map = { python3: "python", python: "python", cpp: "cpp", c: "c", java: "java", javascript: "javascript", js: "javascript", golang: "go", go: "go", rust: "rust", typescript: "typescript", ts: "typescript", mysql: "sql", sqlserver: "sql" };
  return map[lang] || lang || "";
}
