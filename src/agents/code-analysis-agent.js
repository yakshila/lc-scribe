// 代码分析 Agent —— 标注 AC 代码关键行,给出可读性/改进点评。
import { chatComplete } from "../llm/llm-client.js";
import { buildCodeAnalysisPrompt, parseCodeAnalysisResult } from "../llm/prompts.js";
import { logger } from "../utils.js";

export class CodeAnalysisAgent {
  constructor() {
    this.name = "code-analysis-agent";
    this.description = "分析 AC 代码,标注关键行并给出改进点评。";
    this.capabilities = ["code-analysis"];
  }

  async run(ctx) {
    const { note, settings } = ctx;
    if (!note.code || !note.code.solution) {
      logger.warn("code-agent", "no code to analyze");
      return { skipped: true, reason: "no-code" };
    }
    if (!settings.llm || !settings.llm.enabled) {
      // 没配 LLM:做静态基础分析(行数/语言),不阻塞流程
      note.code.keyLines = [];
      return { skipped: true, reason: "llm-disabled" };
    }
    const { system, user } = buildCodeAnalysisPrompt(ctx);
    const text = await chatComplete(settings.llm, [
      { role: "system", content: system },
      { role: "user", content: user },
    ], { responseFormatJSON: true });

    const parsed = parseCodeAnalysisResult(text);
    if (!parsed) {
      logger.warn("code-agent", "failed to parse LLM output");
      return { skipped: true, reason: "parse-failed" };
    }
    note.code.keyLines = parsed.keyLines;
    if (parsed.comments && parsed.comments.length) {
      // 把点评并入 lessonsLearned(若不存在则建)
      note.insights = note.insights || { pitfalls: [], lessonsLearned: [], patterns: [], relatedProblems: [] };
      note.insights.lessonsLearned = [...(note.insights.lessonsLearned || []), ...parsed.comments.map((c) => `[代码] ${c}`)];
    }
    logger.info("code-agent", `annotated ${parsed.keyLines.length} key lines`);
    return { ok: true, keyLines: parsed.keyLines.length };
  }
}
