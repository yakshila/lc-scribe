// 笔记生成 Agent —— 调用 LLM 产出 approach / insights / aiGenerated,写回 ctx.note。
import { chatComplete } from "../llm/llm-client.js";
import { buildNoteGenerationPrompt, parseNoteGenerationResult } from "../llm/prompts.js";
import { logger } from "../utils.js";

export class NoteAgent {
  constructor() {
    this.name = "note-agent";
    this.description = "基于题目、AC 代码与做题过程,生成结构化笔记(思路/复杂度/经验/AI 补充)。";
    this.capabilities = ["note-generation"];
  }

  async run(ctx) {
    const { note, settings } = ctx;
    if (!settings.llm || !settings.llm.enabled) {
      logger.warn("note-agent", "LLM not enabled, skip");
      return { skipped: true, reason: "llm-disabled" };
    }
    const { system, user } = buildNoteGenerationPrompt(ctx);
    const text = await chatComplete(settings.llm, [
      { role: "system", content: system },
      { role: "user", content: user },
    ], { responseFormatJSON: true });

    const parsed = parseNoteGenerationResult(text);
    if (!parsed) {
      logger.warn("note-agent", "failed to parse LLM output");
      note.aiGenerated.summary = "(AI 返回解析失败,可手动编辑或重新生成。)";
      return { skipped: true, reason: "parse-failed" };
    }
    // 合并到笔记(用户可编辑字段 + AI 增量字段分离)
    Object.assign(note.approach, parsed.approach);
    Object.assign(note.insights, parsed.insights);
    Object.assign(note.aiGenerated, parsed.aiGenerated);
    logger.info("note-agent", "note fields filled by LLM");
    return { ok: true };
  }
}
