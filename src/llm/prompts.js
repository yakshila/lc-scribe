// Prompt 模板 —— Agent 用来与 LLM 交互的提示词。
// 约定:所有需要结构化输出的 prompt 都要求 LLM 返回严格 JSON,字段对齐 note schema。
import { extractJSON } from "../utils.js";

// —— 笔记生成:基于题目 + AC 代码 + 做题过程(含运行/提交轨迹),产出 approach / insights / aiGenerated ——
export function buildNoteGenerationPrompt(ctx) {
  const { note, session, problem, failedAttempts, settings, timeline } = ctx;
  const lang = settings && settings.notes && settings.notes.language === "en" ? "en" : "zh";
  const outLang = lang === "en" ? "English" : "中文";

  const problemDesc = [
    `题号: ${note.meta.problemId}`,
    `标题: ${note.meta.title}`,
    `难度: ${note.meta.difficulty}`,
    `标签: ${(note.meta.tags || []).join(", ")}`,
  ].join("\n");

  // 题目正文:优先用 problem.content(GQL 拉到的 HTML),清洗掉标签后给 AI
  let problemStatement = "";
  if (problem && problem.content) {
    problemStatement = stripHtml(problem.content).slice(0, 3000);
  }
  const hints = (problem && problem.hints && problem.hints.length)
    ? problem.hints.map((h) => "  - " + stripHtml(h).slice(0, 200)).join("\n")
    : "";

  const solvingDesc = [
    `用时: ${note.solving.durationSec} 秒`,
    `提交次数: ${note.solving.attemptCount}`,
    `一次 AC: ${note.solving.firstAccepted ? "是" : "否"}`,
    `使用语言: ${(note.solving.languagesUsed || []).join(", ")}`,
  ].join("\n");

  // AC 那次提交的 runtime / memory(只从 submit 类型的 attempts 找,排除 runs)
  const acceptedAttempt = (session && session.attempts || []).slice().reverse()
    .find((a) => (a.kind || "submit") === "submit" && /accepted/i.test(a.status));
  const perfDesc = acceptedAttempt
    ? `执行: runtime=${acceptedAttempt.runtime ?? "?"} ms, memory=${acceptedAttempt.memory ?? "?"} bytes`
    : "(无执行数据)";

  // 完整做题轨迹:运行 + 提交,按时间顺序,体现试错过程
  // AI 能看到"先 TLE -> 优化 -> AC"这类轨迹,据此分析踩坑点和优化思路。
  const tl = timeline || note.solving.timeline || [];
  const timelineDesc = tl.length
    ? tl.map((a, i) => {
        const kindLabel = a.kind === "run" ? "运行" : "提交";
        const perf = (a.runtime != null || a.memory != null)
          ? ` runtime=${a.runtime ?? "?"}ms memory=${a.memory ?? "?"}B`
          : "";
        const codeSnippet = a.code ? `\n     代码片段:\n     ${(a.code || "").slice(0, 400)}` : "";
        return `  ${i + 1}. [${kindLabel}] ${a.status} ${a.statusMsg || ""}${perf} lang=${a.lang || "?"} ts=${a.ts || "?"}${codeSnippet}`;
      }).join("\n")
    : "(无轨迹数据)";

  // 失败尝试摘要:从 timeline 里挑失败的(运行和提交都算),给 AI 推断踩坑点
  const failedSummary = (failedAttempts && failedAttempts.length)
    ? failedAttempts.slice(0, 5).map((a, i) => {
        const kindLabel = a.kind === "run" ? "运行" : "提交";
        const codeSnippet = (a.code || "").slice(0, 500);
        return `  ${i + 1}. [${kindLabel} ${a.status}] ${a.statusMsg || ""}` + (codeSnippet ? `\n     代码片段:\n     ${codeSnippet}` : "");
      }).join("\n")
    : "无";

  const code = note.code.solution || "(未拿到代码)";
  const codeLang = note.code.language || "";

  const system = `你是资深的算法面试教练,擅长把一道 LeetCode 题的解题过程沉淀成高质量的复习笔记。
你会收到完整的做题轨迹(包括每一次"运行"和"提交"的代码、结果、runtime),请据此分析用户的试错过程和踩坑点。
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
  "pitfalls": ["根据做题轨迹中失败的运行/提交,推断用户实际踩的坑"],
  "lessonsLearned": ["本题可沉淀的经验"],
  "patterns": ["可复用的解题模式"],
  "relatedProblems": ["相关题号或题名"],
  "summary": "一句话总结这道题,可结合用户的做题节奏(如'多次 TLE 后优化到 AC')",
  "alternativeApproaches": ["其他可行解法及其权衡"],
  "commonMistakes": ["这道题常见错误"],
  "interviewTips": "面试中如何讲清这题,1-2 句"
}`;

  const user = `请基于以下数据生成笔记内容。

【题目】
${problemDesc}

【题目正文】
${problemStatement || "(未拿到题目正文)"}
${hints ? "\n【官方提示】\n" + hints : ""}

【做题过程】
${solvingDesc}
${perfDesc}

【完整做题轨迹】(运行 + 提交,按时间顺序,体现试错过程)
${timelineDesc}

【失败尝试摘要】(供分析踩坑点)
${failedSummary}

【AC 代码】(${codeLang})
\`\`\`
${code}
\`\`\`

请输出 JSON。`;

  return { system, user };
}

// 粗略去 HTML 标签,保留文本和换行(题目正文是 HTML)
function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
