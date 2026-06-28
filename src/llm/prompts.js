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

  // 完整做题轨迹:运行 + 提交,按时间顺序,体现试错过程。
  // 失败代码给完整内容(不截断),让 AI 能定位到具体错误行做深度分析。
  const tl = timeline || note.solving.timeline || [];
  const timelineDesc = tl.length
    ? tl.map((a, i) => {
        const kindLabel = a.kind === "run" ? "运行" : "提交";
        const perf = (a.runtime != null || a.memory != null)
          ? ` runtime=${a.runtime ?? "?"}ms memory=${a.memory ?? "?"}B`
          : "";
        // 完整代码不截断,AI 需要看全才能定位错误行
        const fullCode = a.code ? `\n     --- 代码 ---\n     ${a.code}` : "";
        return `  ${i + 1}. [${kindLabel}] ${a.status} ${a.statusMsg || ""}${perf} lang=${a.lang || "?"} ts=${a.ts || "?"}${fullCode}`;
      }).join("\n")
    : "(无轨迹数据)";

  // 失败尝试:完整代码 + 简要信息,供 AI 做代码评审式深度分析
  const failedSummary = (failedAttempts && failedAttempts.length)
    ? failedAttempts.slice(0, 6).map((a, i) => {
        const kindLabel = a.kind === "run" ? "运行" : "提交";
        const fullCode = a.code || "(无代码)";
        return `  --- 失败 ${i + 1}: [${kindLabel} ${a.status}] ${a.statusMsg || ""} ---\n${fullCode}`;
      }).join("\n\n")
    : "无";

  const code = note.code.solution || "(未拿到代码)";
  const codeLang = note.code.language || "";

  const system = `你是一位资深算法工程师 + 严格的代码评审者,正在帮用户复盘一道 LeetCode 题的完整做题过程。
你会收到用户的完整做题轨迹:每一次"运行/提交"的完整代码、结果(Accepted/WA/TLE/MLE/CE 等)、runtime/memory。
你的核心任务之一是:像资深工程师做 code review 一样,深度分析用户失败尝试的代码,讲清楚:
  - 错在哪个具体位置(哪一行/哪个变量/哪个逻辑)
  - 为什么这是错的(根本原因,不能只说"会出错")
  - 这个错误会导致什么具体现象(为什么会 Memory Limit Exceeded / TLE / Wrong Answer,要讲清因果链)
  - 正确的写法是什么、为什么这样写才对

要求:
1. 用 ${outLang} 输出,语言要通俗易懂、像在给同事讲题,不要堆术语。
2. 只输出一个 JSON 对象,不要任何额外文字,不要 markdown 代码围栏。
3. JSON 字段固定如下:
{
  "intuition": "对题目的第一直觉,1-2 句",
  "approach": "解法步骤,分点描述,3-6 点",
  "algorithm": "算法名称,如 '哈希表一次遍历'",
  "dataStructures": ["用到的数据结构"],
  "complexity": { "time": "O(?)", "space": "O(?)" },
  "pitfalls": [
    {
      "symptom": "失败现象,如 'Memory Limit Exceeded' 或 '运行时 2/3 用例通过'",
      "rootCause": "根本原因的深度分析:错在哪个位置、为什么是错的、为什么会导致这个现象(讲清因果链,如'pre 初始化为 dummyHead 导致原头节点的 Next 指回 dummyHead 形成环,遍历反转后链表时无限循环,内存暴涨触发 MLE')",
      "badCode": "出错的关键代码片段(原文摘录,几行即可)",
      "fix": "正确的写法 + 为什么这样写才对(如'pre 必须初始化为 nil,因为反转后原头节点变成尾节点,尾节点必须指向 nil 收尾')",
      "lesson": "从这个坑能学到的一句话规律(如'反转整个链表,pre 必定从 nil 起手')"
    }
  ],
  "lessonsLearned": ["本题可沉淀的经验,具体可操作"],
  "patterns": ["可复用的解题模式"],
  "relatedProblems": ["相关题号或题名"],
  "summary": "结合用户实际做题节奏的一句话总结(如'用 dummyHead 导致 MLE,调试多次后改用 pre=nil 的标准迭代法通过')",
  "alternativeApproaches": ["其他可行解法及其权衡"],
  "commonMistakes": ["这道题常见错误"],
  "interviewTips": "面试中如何讲清这题,1-2 句"
}

注意:
- pitfalls 必须基于用户实际的失败代码分析,不要泛泛而谈"可能踩的坑"。如果用户没失败过,pitfalls 为空数组 []。
- 每个坑要讲透:现象 -> 根因 -> 错误代码 -> 修法 -> 规律,像给同事讲题一样通俗详细。
- 如果两次失败的根因相同(比如都是 dummyHead 导致环),合并成一个坑,不要重复列。`;

  const user = `请基于以下数据生成笔记内容。

【题目】
${problemDesc}

【题目正文】
${problemStatement || "(未拿到题目正文)"}
${hints ? "\n【官方提示】\n" + hints : ""}

【做题过程】
${solvingDesc}
${perfDesc}

【完整做题轨迹】(运行 + 提交,按时间顺序,完整代码已附上)
${timelineDesc}

【失败尝试完整代码】(供深度 code review,请逐个分析错在哪、为什么错、怎么改)
${failedSummary}

【AC 代码】(${codeLang})
\`\`\`
${code}
\`\`\`

请输出 JSON。pitfalls 字段请结合上面的失败代码做深度分析,每个坑都要讲透现象→根因→错代码→修法→规律。`;

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
      // pitfalls 支持两种格式:新格式(对象数组,深度分析)和旧格式(字符串数组)
      // 统一归一化为对象数组,旧字符串包成 { symptom: str, rootCause: str, lesson: "" }
      pitfalls: normalizePitfalls(obj.pitfalls),
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

/** 把 pitfalls 归一化为对象数组 {symptom, rootCause, badCode?, fix?, lesson?} */
function normalizePitfalls(v) {
  if (!Array.isArray(v)) return [];
  return v.map((p) => {
    if (typeof p === "string") {
      return { symptom: p, rootCause: p, badCode: "", fix: "", lesson: "" };
    }
    if (p && typeof p === "object") {
      return {
        symptom: str(p.symptom || p.title),
        rootCause: str(p.rootCause || p.cause || p.analysis),
        badCode: str(p.badCode || p.code || ""),
        fix: str(p.fix || p.solution || p.correction),
        lesson: str(p.lesson || p.takeaway || ""),
      };
    }
    return { symptom: String(p), rootCause: "", badCode: "", fix: "", lesson: "" };
  });
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
