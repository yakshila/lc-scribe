// 复习调度 Agent —— 为新笔记初始化 SM-2 复习状态。
// 这个 agent 不调用 LLM,纯本地计算,演示"agent 不一定都要 LLM"。
// 未来可替换为更智能的调度 agent(如根据题目难度/用户掌握度动态调整初始间隔)。
import { sm2Init } from "../review/sm2.js";
import { logger } from "../utils.js";

export class ReviewAgent {
  constructor() {
    this.name = "review-agent";
    this.description = "为新笔记初始化复习调度状态(SM-2)。";
    this.capabilities = ["review-scheduler"];
  }

  async run(ctx) {
    const { note } = ctx;
    // 已有复习状态则保留(幂等)
    if (note.review && note.review.nextReviewAt) {
      logger.debug("review-agent", "review state already exists, keep");
      return { ok: true, kept: true };
    }
    // 简单策略:难度越高,初始间隔越短(Hard→1天,Medium→1天,Easy→2天)
    let init = sm2Init();
    const diff = note.meta && note.meta.difficulty;
    if (diff === "Easy") {
      init.interval = 2;
      const t = Date.now() + 2 * 24 * 60 * 60 * 1000;
      init.nextReviewAt = new Date(t).toISOString();
    }
    note.review = init;
    logger.info("review-agent", `review initialized, next in ${init.interval} day(s)`);
    return { ok: true };
  }
}
