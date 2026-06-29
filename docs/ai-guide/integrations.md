# 集成层:Uploader / LLM / 复习(第 8-10 章)

> 返回 [索引](../../AI_GUIDE.md)。本文件覆盖 Uploader 体系、LLM 客户端与 Prompt 契约、SM-2 复习调度。

## 目录

8. [Uploader 体系](#8-uploader-体系)
9. [LLM 客户端与 Prompt 契约](#9-llm-客户端与-prompt-契约)
10. [复习调度(SM-2)](#10-复习调度sm-2)

---

## 8. Uploader 体系

[uploader-registry.js](../../src/uploaders/uploader-registry.js):`registry.upload(name, note, opts)`,`name` 对应 `settings.uploaders[name]`。

| Uploader | 说明 | 依据 |
|---|---|---|
| `feishu` | 飞书自定义机器人 Webhook,发 interactive 卡片;需授权 `open.feishu.cn`;仅支持无签名 webhook | [feishu-uploader.js](../../src/uploaders/feishu-uploader.js) |
| `markdown` | 渲染 `.md` 触发浏览器下载(data URL);纯本地 | [markdown-uploader.js](../../src/uploaders/markdown-uploader.js) |

接口约定:`upload(note, opts) -> { success, url?, message? }`、`test(opts) -> { success, message? }`。`enabled === false` 时直接返回失败。

---

## 9. LLM 客户端与 Prompt 契约

- [llm-client.js](../../src/llm/llm-client.js) `chatComplete`:OpenAI 兼容 `POST {baseURL}/chat/completions`,`Bearer` 鉴权,`AbortController` 超时(`timeoutMs`,默认 60000)。`responseFormatJSON` 时带 `response_format:{type:"json_object"}`。
- `ensureHostPermission(baseURL)`:对 baseURL origin 申请 optional host 权限(需用户手势)。
- [prompts.js](../../src/llm/prompts.js):
  - `buildNoteGenerationPrompt(ctx)`:产出 system+user prompt,要求 LLM 返回严格 JSON,字段对齐 note schema。pitfalls 要求基于用户**实际失败代码**做深度分析(现象→根因→错代码→修法→规律)。
  - `parseNoteGenerationResult(text)`:用 `extractJSON` 解析,`normalizePitfalls` 兼容字符串/对象两种格式。
  - `buildCodeAnalysisPrompt` / `parseCodeAnalysisResult`:关键行 + 点评。
  - `buildExplanationPrompt(ctx)`:AI 解答 prompt,要求通俗易懂 + 必须给最优方案,输出 JSON `{plainExplanation, optimalApproach{name, idea, steps[], whyOptimal, complexity}, analogy, keyInsight, commonPitfalls[], codeTemplate}`。
  - `parseExplanationResult(text)`:解析为 `note.aiGenerated.explanation` 片段。
- 默认 `maxTokens` 4000、`timeoutMs` 60000(store.js 迁移逻辑保证下限)。
- 依据:[llm-client.js](../../src/llm/llm-client.js)、[prompts.js](../../src/llm/prompts.js)、[store.js](../../src/storage/store.js) `getSettings` 迁移段。

---

## 10. 复习调度(SM-2)

[sm2.js](../../src/review/sm2.js):
- `sm2Init()`:interval=1, ease=2.5, repetitions=0, 1 天后复习。
- `sm2Next(state, grade)`:grade 0-2 视为未掌握(重置 repetitions=0, interval=1);3-5 推进(repetitions 1→interval 1,2→6,之后 `round(interval*ease)`)。ease 仅在 g≥3 时调整,下限 1.3。
- `countDue(reviews, now)`:统计 `nextReviewAt ≤ now` 的数量。
- 评分常量(`schema.js` `REVIEW_GRADES`):AGAIN=0, HARD=2, GOOD=4, EASY=5。

复习到期检查:`getDueReviews`(`coordinator.js`),由 `alarm-manager.js` 每日 alarm 触发 `runDailyReviewCheck`。通知带「生成 AI 解答」按钮(对到期题并发调 `generateExplanationFor`,限 `maxDuePerDay` 道)与「稍后」按钮;通知主体点击打开复习页。`alarm-manager.js` 的 `onAlarm` 监听器为 async 并 await 回调,确保 MV3 SW 不会在 `notify` 完成前被杀;`notify` 对带按钮的通知默认 `requireInteraction: true`(常驻直到用户操作)。
