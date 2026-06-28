// Prompt 模板 —— Agent 用来与 LLM 交互的提示词。
// 约定:所有需要结构化输出的 prompt 都要求 LLM 返回严格 JSON,字段对齐 note schema。
import { extractJSON } from "../utils.js";

// —— 笔记生成:基于题目 + AC 代码 + 做题过程,产出 approach / insights / aiGenerated ——
export function buildNoteGenerationPrompt(ctx) {
  const { note, session, problem, failedAttempts, settings } = ctx;
  const lang = settings && settings.notes && settings.notes.language === "en" ? "en" : "zh";
  const outLang = lang === "en" ? "English" : "中文";

  const problemDesc = [
    `题号: ${note.meta.problemId}`,
    `标题: ${note.meta.title}`,
    `难度: ${note.meta.difficulty}`,
    `标签: ${(note.meta.tags || []).join(", ")}`,
  ].join("\n");

  const solvingDesc = [
    `用时: ${note.solving.durationSec} 秒`,
    `提交次数: ${note.solving.attemptCount}`,
    `一次 AC: ${note.solving.firstAccepted ? "是" : "否"}`,
    `使用语言: ${(note.solving.languagesUsed || []).join(", ")}`,
  ].join("\n");

  const failedSummary = (failedAttempts && failedAttempts.length)
    ? failedAttempts.slice(0, 5).map((a, i) => `  ${i + 1}. [${a.status}] ${a.statusMsg || ""}`.trim()).join("\n")
    : "无";

  const code = note.code.solution || "(未拿到代码)";
  const codeLang = note.code.language || "";

  const system = `你是资深的算法面试教练,擅长把一道 LeetCode 题的解题过程沉淀成高质量的复习笔记。
要求:
1. 用 ${outLang} 输出。
2. 只输出一个 JSON 对象,不要任何额外文字,不要 markdown 代码围栏。
3. JSON 字段固定如下:
{
  "intuition": "对题目的第一直觉,1-2 句",
  "approach": "解法步骤,分点描述,3-6 点",
  "algorithm": "算法名称,如 '哈希表一次遍历'",
  "dataStructures": ["用到的数据结构"],
  "complexity": { "time": "O(?)", "space": "O(?)" },
  "pitfalls": ["自己可能的踩坑点(根据失败尝试推断)"],
  "lessonsLearned": ["本题可沉淀的经验"],
  "patterns": ["可复用的解题模式"],
  "relatedProblems": ["相关题号或题名"],
  "summary": "一句话总结这道题",
  "alternativeApproaches": ["其他可行解法及其权衡"],
  "commonMistakes": ["这道题常见错误"],
  "interviewTips": "面试中如何讲清这题,1-2 句"
}`;

  const user = `请基于以下数据生成笔记内容。

【题目】
${problemDesc}

【做题过程】
${solvingDesc}

【失败尝试摘要】
${failedSummary}

【AC 代码】(${codeLang})
\`\`\`
${code}
\`\`\`

请输出 JSON。`;

  return { system, user };
}

// —— 代码分析:针对 AC 代码,标注关键行 + 给出可读性/复杂度点评 ——
export function buildCodeAnalysisPrompt(ctx) {
  const { note } = ctx;
  const code = note.code.solution || "";
  const lang = note.code.language || "";
  const system = `你是代码审查助手。给定一段 AC 的算法代码,输出严格 JSON,字段:
{
  "keyLines": [{"line": 1, "note": "这行在做什么"}],
  "comments": ["整体可读性/可改进点的简短点评,1-3 条"]
}
要求:行号从 1 开始,只挑 3-6 个真正关键的行;只输出 JSON,不要额外文字。`;
  const user = `语言: ${lang}\n\n代码:\n\`\`\`\n${code}\n\`\`\``;
  return { system, user };
}

/** 把 LLM 返回解析成 note 片段 */
export function parseNoteGenerationResult(text) {
  const obj = extractJSON(text);
  if (!obj) return null;
  return {
    approach: {
      intuition: str(obj.intuition),
      approach: str(obj.approach),
      algorithm: str(obj.algorithm),
      dataStructures: arr(obj.dataStructures),
      complexity: {
        time: str(obj.complexity && obj.complexity.time),
        space: str(obj.complexity && obj.complexity.space),
      },
    },
    insights: {
      pitfalls: arr(obj.pitfalls),
      lessonsLearned: arr(obj.lessonsLearned),
      patterns: arr(obj.patterns),
      relatedProblems: arr(obj.relatedProblems),
    },
    aiGenerated: {
      summary: str(obj.summary),
      alternativeApproaches: arr(obj.alternativeApproaches),
      commonMistakes: arr(obj.commonMistakes),
      interviewTips: str(obj.interviewTips),
    },
  };
}

export function parseCodeAnalysisResult(text) {
  const obj = extractJSON(text);
  if (!obj) return null;
  const keyLines = Array.isArray(obj.keyLines)
    ? obj.keyLines.filter((k) => k && Number.isFinite(k.line)).map((k) => ({ line: Number(k.line), note: String(k.note || "") }))
    : [];
  const comments = arr(obj.comments);
  return { keyLines, comments };
}

function str(v) { return v == null ? "" : String(v); }
function arr(v) { return Array.isArray(v) ? v.map(String) : []; }
