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
4. **裁剪发给 LLM 的试错代码**:若 `settings.notes.recentAttemptsToLLM > 0`,只取最近 n 次 run/submit 的代码传给 Agent(`ctx.timeline` / `ctx.failedAttempts`);`note.solving.timeline` 仍保存完整轨迹(笔记不丢数据)。AC 代码在 `note.code.solution` 单独传给 LLM,不受此裁剪影响。
5. 按 `settings.agents.enabled` 顺序跑 Agent:`code-analysis` → `note-generation` → `review-scheduler`(各自 try/catch,互不阻塞)。
6. `saveNote(note)`;若 `note.review` 存在则 `saveReview`。
7. **统计**:`totalNotes` 为派生值(= notes 实际数量),无需手动维护;同题覆盖时数量不变,新增/删除自动同步。
8. `maybeAutoUpload(note)`:对每个 `enabled && autoDownload` 的 uploader 自动上传。

**关键约束**:
- 只有 `submit`(非 `run`)且 `accepted` 才算 AC(`onSubmissionResult` 中 `isRun` 判断)。
- `attemptCount` 只数 `submit`(运行不算)。
- **AC 计数按题去重**:`onAccepted` 调 `markAccepted(problemKey)`(幂等),同题多次 AC 只算一次;`totalAccepted` 为派生值(= `acceptedProblems` 集合大小)。
- `review-agent` 幂等:已有 `review.nextReviewAt` 则保留。

依据:[coordinator.js](../../src/background/coordinator.js) `generateNoteFor`、`onSubmissionResult`、`onAccepted`;[store.js](../../src/storage/store.js) `findNoteByProblemKey`、`newNoteSkeleton`、`saveNote`。

### 6.1 AI 解答生成(最优方案讲解)

入口:[coordinator.js](../../src/background/coordinator.js) `generateExplanationFor(noteId)`。触发点:复习通知「生成 AI 解答」按钮、笔记详情页「生成 AI 解答」按钮、`GENERATE_EXPLANATION` 消息。

**与笔记生成的区别**:不依赖用户做题过程(不读 session/attempts),仅基于题目元数据(题号/标题/难度/标签/正文/hints)调 LLM,产出通俗易懂的「最优方案」讲解,存入 `note.aiGenerated.explanation`。

**步骤**:
1. `getNote(noteId)` 取笔记;`getProblem(lc:<slug>)` 取题目元数据(可能为 null,prompt 内会兜底)。
2. 检查 `settings.llm.enabled`,未启用抛错。
3. `buildExplanationPrompt({ note, problem, settings })` 构造 prompt(系统提示要求通俗易懂 + 必须给最优方案 + 严格 JSON)。
4. `chatComplete(settings.llm, messages, { responseFormatJSON: true })` 调 LLM。
5. `parseExplanationResult(text)` 解析为 `{ explanation: { plainExplanation, analogy, keyInsight, commonPitfalls[], codeTemplate, optimalApproach:{name, idea, steps[], whyOptimal, complexity:{time, space}} } }`。
6. 写入 `note.aiGenerated.explanation`,`saveNote(note)`。

**复习通知按钮行为**:`runDailyReviewCheck` 到点弹通知,带「生成 AI 解答」/「稍后」两个按钮。点「生成 AI 解答」会对到期复习题(限 `maxDuePerDay` 道)并发触发 `generateExplanationFor`,并打开复习页;点通知主体则只打开复习页。

依据:[coordinator.js](../../src/background/coordinator.js) `generateExplanationFor`、`runDailyReviewCheck`;[prompts.js](../../src/llm/prompts.js) `buildExplanationPrompt`/`parseExplanationResult`;[llm-client.js](../../src/llm/llm-client.js) `chatComplete`。

---

## 7. Agent 体系(按 capability 调度)

[agent-registry.js](../../src/agents/agent-registry.js):单例注册表,coordinator 不直调某 agent,而是 `registry.runCapability(cap, ctx)`。`ctx = { note, session, problem, settings, failedAttempts, timeline }`,agent 可改写 `ctx.note`。

| Agent | capability | 行为 | 依据 |
|---|---|---|---|
| `note-agent` | `note-generation` | 调 LLM 产出 approach/insights/aiGenerated;LLM 未启用则跳过 | [note-agent.js](../../src/agents/note-agent.js) |
| `code-analysis-agent` | `code-analysis` | 标注 AC 代码关键行 + 改进点评;无 LLM 时静态基础分析 | [code-analysis-agent.js](../../src/agents/code-analysis-agent.js) |
| `review-agent` | `review-scheduler` | 初始化 SM-2(Easy→2 天,其余→1 天);纯本地不调 LLM;幂等 | [review-agent.js](../../src/agents/review-agent.js) |

扩展点:`registerAgent(new MyAgent())` 注入自定义 agent,无需改 coordinator。
