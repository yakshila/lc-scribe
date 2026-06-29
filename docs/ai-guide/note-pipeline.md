# 笔记流水线与 Agent(第 6-7 章)

> 返回 [索引](../../AI_GUIDE.md)。本文件覆盖笔记生成流水线(含同题覆盖)与 Agent 体系。

## 目录

6. [笔记生成流水线(含同题覆盖)](#6-笔记生成流水线含同题覆盖)
7. [Agent 体系(按 capability 调度)](#7-agent-体系按-capability-调度)

---

## 6. 笔记生成流水线(含同题覆盖)

入口:[coordinator.js](../../src/background/coordinator.js) `generateNoteFor(problemKey)`。触发点:AC 后(`onAccepted`,若 `settings.notes.autoGenerate`)、通知/toast「生成笔记」按钮、popup 按钮、`GENERATE_NOTE` 消息。

**步骤**:

1. 取 `session`、`problem`(缺失/partial 时向 content 发 `REFRESH_PROBLEM_META` 同步拉 GQL;仍缺失则用 slug 构造 `partial` 兜底骨架)。
2. **同题覆盖**:`findNoteByProblemKey(problemKey)` 查找已有笔记;若存在,复用其 `id`(使 `saveNote` 覆盖而非新增),并保留 `createdAt` 与 `review`(避免复习进度丢失)。
3. `newNoteSkeleton(problemMeta)` 建骨架,填入 `solving`(startedAt/acceptedAt/durationSec/firstAccepted/languagesUsed/timeline/attemptCount)与 `code`(AC 那次 submit 的 lang/solution)。
4. 按 `settings.agents.enabled` 顺序跑 Agent:`code-analysis` → `note-generation` → `review-scheduler`(各自 try/catch,互不阻塞)。
5. `saveNote(note)`;若 `note.review` 存在则 `saveReview`。
6. **统计**:`totalNotes` 仅在「新笔记(非覆盖)」时 +1。
7. `maybeAutoUpload(note)`:对每个 `enabled && autoDownload` 的 uploader 自动上传。

**关键约束**:
- 只有 `submit`(非 `run`)且 `accepted` 才算 AC(`onSubmissionResult` 中 `isRun` 判断)。
- `attemptCount` 只数 `submit`(运行不算)。
- `review-agent` 幂等:已有 `review.nextReviewAt` 则保留。

依据:[coordinator.js](../../src/background/coordinator.js) `generateNoteFor`、`onSubmissionResult`、`onAccepted`;[store.js](../../src/storage/store.js) `findNoteByProblemKey`、`newNoteSkeleton`、`saveNote`。

---

## 7. Agent 体系(按 capability 调度)

[agent-registry.js](../../src/agents/agent-registry.js):单例注册表,coordinator 不直调某 agent,而是 `registry.runCapability(cap, ctx)`。`ctx = { note, session, problem, settings, failedAttempts, timeline }`,agent 可改写 `ctx.note`。

| Agent | capability | 行为 | 依据 |
|---|---|---|---|
| `note-agent` | `note-generation` | 调 LLM 产出 approach/insights/aiGenerated;LLM 未启用则跳过 | [note-agent.js](../../src/agents/note-agent.js) |
| `code-analysis-agent` | `code-analysis` | 标注 AC 代码关键行 + 改进点评;无 LLM 时静态基础分析 | [code-analysis-agent.js](../../src/agents/code-analysis-agent.js) |
| `review-agent` | `review-scheduler` | 初始化 SM-2(Easy→2 天,其余→1 天);纯本地不调 LLM;幂等 | [review-agent.js](../../src/agents/review-agent.js) |

扩展点:`registerAgent(new MyAgent())` 注入自定义 agent,无需改 coordinator。
