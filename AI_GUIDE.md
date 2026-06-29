# AI_GUIDE.md — LC Scribe 代码导读(供 AI 阅读)

> 本文档面向 AI 助手,目的是让 AI 在少量 token 内建立对代码库的准确认知。
> **所有陈述均来自源码,文末标注依据来源(文件路径 + 符号/行号)。**
> 若代码与本文档冲突,以代码为准,并按本文档末尾「文档维护规则」迭代本文档。

---

## 目录(TOC)

读 AI 时按需跳转对应章节,不必整篇加载:

1. [项目定位与技术栈](#1-项目定位与技术栈)
2. [目录结构](#2-目录结构)
3. [运行时拓扑与数据流](#3-运行时拓扑与数据流)
4. [存储分区与核心数据契约](#4-存储分区与核心数据契约)
5. [消息 API 总表](#5-消息-api-总表)
6. [笔记生成流水线(含同题覆盖)](#6-笔记生成流水线含同题覆盖)
7. [Agent 体系(按 capability 调度)](#7-agent-体系按-capability-调度)
8. [Uploader 体系](#8-uploader-体系)
9. [LLM 客户端与 Prompt 契约](#9-llm-客户端与-prompt-契约)
10. [复习调度(SM-2)](#10-复习调度sm-2)
11. [Content Scripts 详解](#11-content-scripts-详解)
12. [通知与定时器](#12-通知与定时器)
13. [权限与 MV3 约束](#13-权限与-mv3-约束)
14. [测试](#14-测试)
15. [文档维护规则](#15-文档维护规则)
16. [依据来源索引](#16-依据来源索引)

---

## 1. 项目定位与技术栈

LC Scribe 是面向 [leetcode.cn](https://leetcode.cn) 的 Chrome/Edge **MV3 浏览器扩展**,在用户刷题时自动识别题目与提交,在关键节点(AC、卡壳、到期复习)提醒,并把每道题沉淀为结构化笔记 + SM-2 复习计划。

- **技术栈**:Chrome Manifest V3 · 原生 ES module(无构建步骤)· `chrome.storage` · SM-2 · OpenAI 兼容 API · 飞书 Webhook。
- **无打包**:改完代码在 `chrome://extensions` 点「重新加载」即生效。
- 依据:[manifest.json](manifest.json)(`manifest_version: 3`, `"type": "module"`)、[README.md](README.md)「技术栈」「开发」段。

---

## 2. 目录结构

```
manifest.json               MV3 清单
src/
  background/               后台 Service Worker
    service-worker.js       入口:消息路由 + 通知监听 + 初始化
    coordinator.js          核心编排器(事件→Agent→存储→复习→通知)
    notification-manager.js chrome.notifications 封装
    alarm-manager.js        chrome.alarms 封装(卡壳/每日复习)
  content/                  注入 leetcode.cn 页面的脚本
    content.js              入口:命名空间 window.LCC + 编排
    leetcode-api.js         GraphQL 拉题目元数据
    page-hook.js            主世界(MAIN world)包裹 fetch/XHR
    problem-detector.js     SPA 路由 hook,识别当前题目
    submission-watcher.js   提交结果监听(page-hook + DOM 兜底)
    timer-tracker.js        可见性感知的有效用时统计
  agents/                   Agent 注册表 + 三个内置 Agent
    agent-registry.js       按 capability 调度
    note-agent.js           note-generation
    code-analysis-agent.js  code-analysis
    review-agent.js         review-scheduler
  llm/                      OpenAI 兼容客户端 + Prompt
    llm-client.js           chatComplete / testConnection / ensureHostPermission
    prompts.js              笔记生成 / 代码分析 Prompt + 结果解析
  storage/                  chrome.storage 封装 + Note 结构
    store.js                settings/notes/problems/sessions/reviews/stats CRUD
    schema.js               NOTE_FIELDS 定义 + validateNote + noteToMarkdown
  review/sm2.js             SM-2 间隔重复算法
  uploaders/                上传器注册表 + 飞书/Markdown
    uploader-registry.js
    feishu-uploader.js
    markdown-uploader.js
  notes/                    笔记查看页(列表/复习/详情)
  popup/                    工具栏弹窗(状态 + 快捷操作)
  options/                  设置页(LLM/通知/复习/上传器)
  diagnose/                 诊断页(查看 session/设置)
  vendor/                   highlight.js 代码高亮(预置)
tests/smoke.test.mjs        纯函数 smoke test(无 chrome 依赖)
```

依据:[src/](src/) 目录列举;各文件顶部注释。

---

## 3. 运行时拓扑与数据流

```
┌──── Content Scripts (leetcode.cn,isolated world) ────┐
│ problem-detector ─ SPA 路由 hook → 识别题目          │
│ page-hook (MAIN world) ─ 包裹 fetch/XHR,捕获提交     │
│ submission-watcher ─ DOM 兜底监听结果文本             │
│ timer-tracker ─ 可见性感知的有效用时                  │
│ leetcode-api ─ GraphQL 拉题目元数据                   │
└───────────────────────┬──────────────────────────────┘
                        │ chrome.runtime.sendMessage
┌───────────────────────▼──────────────────────────────┐
│            Background Service Worker                  │
│ service-worker → coordinator(核心编排)                │
│ coordinator ─ 事件 → Agent → 存储 → 复习 → 通知       │
└──┬──────────┬──────────┬──────────┬──────────────────┘
   ▼          ▼          ▼          ▼
 storage      LLM        Agents     Uploaders
(notes/...)  (OpenAI    (registry  (registry
              兼容)      by cap)    by name)
```

- Content scripts 之间共享 isolated world,通过 `window.LCC` 命名空间通信。
- `page-hook.js` 运行在 **MAIN world**(`manifest.json` 中 `"world": "MAIN"`),不能用 `chrome.*`,通过 `window.postMessage` 回传给 content script。
- 依据:[manifest.json](manifest.json) `content_scripts`(两段:isolated + MAIN)、[content.js](src/content/content.js) `window.LCC` 定义、[page-hook.js](src/content/page-hook.js) 顶部注释。

---

## 4. 存储分区与核心数据契约

### 4.1 存储分区(`chrome.storage.local`)

| key | 结构 | 说明 |
|---|---|---|
| `settings` | `Settings` | 全局配置(LLM/通知/复习/agent/uploader) |
| `notes` | `{ [noteId]: Note }` | 笔记,按 id 索引 |
| `problems` | `{ [problemKey]: ProblemMeta }` | 题目元数据缓存 |
| `sessions` | `{ [problemKey]: SessionState }` | 做题会话(计时/尝试) |
| `reviews` | `{ [noteId]: ReviewState }` | 复习调度状态 |
| `stats` | `Stats` | 聚合统计 |

依据:[store.js](src/storage/store.js) 顶部注释 + 各 CRUD 函数。

### 4.2 Note 结构(7 层,客观/主观/AI 增量分离)

| 字段 | 含义 | 来源 |
|---|---|---|
| `meta` | 题号/slug/标题/难度/标签/url | LeetCode 客观 |
| `solving` | 开始/AC 时刻、用时、提交次数、一次 AC、语言、`timeline[]`(运行+提交轨迹) | 插件采集 |
| `approach` | 直觉/解法/算法/数据结构/复杂度 | 用户可编辑,Agent 辅助 |
| `code` | 语言/AC 代码/`keyLines[]`(关键行标注) | Agent 标注 |
| `insights` | `pitfalls[]`(深度分析:现象/根因/错代码/修法/规律)/收获/模式/相关题 | Agent 辅助提炼 |
| `review` | SM-2:间隔/ease/repetitions/下次复习/历史 | 调度状态 |
| `aiGenerated` | 总结/其他解法/常见错误/面试建议 | AI 增量,与用户字段分离 |

- `problemKey` 形如 `lc:<slug>`(见 [utils.js](src/utils.js) `problemKey`)。
- 笔记 `id` 由 `generateId("note")` 生成(`note_<base36时间>_<随机>`)。
- 依据:[schema.js](src/storage/schema.js) `NOTE_FIELDS`、[store.js](src/storage/store.js) `newNoteSkeleton`。

---

## 5. 消息 API 总表

所有消息走 `chrome.runtime.sendMessage({ type, payload })`,由 [coordinator.js](src/background/coordinator.js) `handleMessage` 路由,响应统一为 `{ ok, data }` 或 `{ ok:false, error }`。

**Content → Background**:

| type | 方向 | 说明 |
|---|---|---|
| `PROBLEM_ENTERED` | content→bg | 进入题目,建/恢复 session |
| `PROBLEM_META` | content→bg | 异步补全题目元数据 |
| `SUBMISSION_RESULT` | content→bg | 提交/运行结果(含代码/语言/状态/runtime/memory) |
| `TIMER_TICK` / `TIMER_FINAL` | content→bg | 上报有效用时 |
| `TOAST_BUTTON` | content→bg | 页内 toast 按钮回调(如 generate-note) |

**Background → Content**(由 coordinator 下发):

| type | 说明 |
|---|---|
| `TIMER_START` / `TIMER_STOP` / `TIMER_PAUSE` / `TIMER_RESUME` | 计时控制 |
| `REFRESH_PROBLEM_META` | 请求 content 重新拉 GQL 元数据 |
| `SHOW_TOAST` | 系统通知失败时,页内 toast 兜底 |

**UI(popup/options/notes)→ Background**:

| type | 说明 |
|---|---|
| `GET_STATUS` | 状态汇总(LLM/统计/当前 session) |
| `GET_NOTES` / `GET_NOTE` | 列表 / 单条 |
| `GET_DUE_REVIEWS` | 到期复习 |
| `GET_SETTINGS` / `SAVE_SETTINGS` | 配置读写 |
| `GET_STATS` | 统计 |
| `GENERATE_NOTE` | 触发笔记生成(`payload.problemKey`) |
| `REVIEW_GRADE` | 复习评分(`noteId`, `grade`) |
| `DELETE_NOTE` | 删除笔记 |
| `UPLOAD_NOTE` | 上传(`noteId`, `uploader`) |
| `GET_NOTE_MARKDOWN` | 取笔记 Markdown |
| `TRIGGER_REVIEW_CHECK` | 触发每日复习检查 |

依据:[coordinator.js](src/background/coordinator.js) `handleMessage`、[content.js](src/content/content.js) `onMessage` 监听。

---

## 6. 笔记生成流水线(含同题覆盖)

入口:[coordinator.js](src/background/coordinator.js) `generateNoteFor(problemKey)`。触发点:AC 后(`onAccepted`,若 `settings.notes.autoGenerate`)、通知/toast「生成笔记」按钮、popup 按钮、`GENERATE_NOTE` 消息。

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

依据:[coordinator.js](src/background/coordinator.js) `generateNoteFor`、`onSubmissionResult`、`onAccepted`;[store.js](src/storage/store.js) `findNoteByProblemKey`、`newNoteSkeleton`、`saveNote`。

---

## 7. Agent 体系(按 capability 调度)

[agent-registry.js](src/agents/agent-registry.js):单例注册表,coordinator 不直调某 agent,而是 `registry.runCapability(cap, ctx)`。`ctx = { note, session, problem, settings, failedAttempts, timeline }`,agent 可改写 `ctx.note`。

| Agent | capability | 行为 | 依据 |
|---|---|---|---|
| `note-agent` | `note-generation` | 调 LLM 产出 approach/insights/aiGenerated;LLM 未启用则跳过 | [note-agent.js](src/agents/note-agent.js) |
| `code-analysis-agent` | `code-analysis` | 标注 AC 代码关键行 + 改进点评;无 LLM 时静态基础分析 | [code-analysis-agent.js](src/agents/code-analysis-agent.js) |
| `review-agent` | `review-scheduler` | 初始化 SM-2(Easy→2 天,其余→1 天);纯本地不调 LLM;幂等 | [review-agent.js](src/agents/review-agent.js) |

扩展点:`registerAgent(new MyAgent())` 注入自定义 agent,无需改 coordinator。

---

## 8. Uploader 体系

[uploader-registry.js](src/uploaders/uploader-registry.js):`registry.upload(name, note, opts)`,`name` 对应 `settings.uploaders[name]`。

| Uploader | 说明 | 依据 |
|---|---|---|
| `feishu` | 飞书自定义机器人 Webhook,发 interactive 卡片;需授权 `open.feishu.cn`;仅支持无签名 webhook | [feishu-uploader.js](src/uploaders/feishu-uploader.js) |
| `markdown` | 渲染 `.md` 触发浏览器下载(data URL);纯本地 | [markdown-uploader.js](src/uploaders/markdown-uploader.js) |

接口约定:`upload(note, opts) -> { success, url?, message? }`、`test(opts) -> { success, message? }`。`enabled === false` 时直接返回失败。

---

## 9. LLM 客户端与 Prompt 契约

- [llm-client.js](src/llm/llm-client.js) `chatComplete`:OpenAI 兼容 `POST {baseURL}/chat/completions`,`Bearer` 鉴权,`AbortController` 超时(`timeoutMs`,默认 60000)。`responseFormatJSON` 时带 `response_format:{type:"json_object"}`。
- `ensureHostPermission(baseURL)`:对 baseURL origin 申请 optional host 权限(需用户手势)。
- [prompts.js](src/llm/prompts.js):
  - `buildNoteGenerationPrompt(ctx)`:产出 system+user prompt,要求 LLM 返回严格 JSON,字段对齐 note schema。pitfalls 要求基于用户**实际失败代码**做深度分析(现象→根因→错代码→修法→规律)。
  - `parseNoteGenerationResult(text)`:用 `extractJSON` 解析,`normalizePitfalls` 兼容字符串/对象两种格式。
  - `buildCodeAnalysisPrompt` / `parseCodeAnalysisResult`:关键行 + 点评。
- 默认 `maxTokens` 4000、`timeoutMs` 60000(store.js 迁移逻辑保证下限)。
- 依据:[llm-client.js](src/llm/llm-client.js)、[prompts.js](src/llm/prompts.js)、[store.js](src/storage/store.js) `getSettings` 迁移段。

---

## 10. 复习调度(SM-2)

[sm2.js](src/review/sm2.js):
- `sm2Init()`:interval=1, ease=2.5, repetitions=0, 1 天后复习。
- `sm2Next(state, grade)`:grade 0-2 视为未掌握(重置 repetitions=0, interval=1);3-5 推进(repetitions 1→interval 1,2→6,之后 `round(interval*ease)`)。ease 仅在 g≥3 时调整,下限 1.3。
- `countDue(reviews, now)`:统计 `nextReviewAt ≤ now` 的数量。
- 评分常量(`schema.js` `REVIEW_GRADES`):AGAIN=0, HARD=2, GOOD=4, EASY=5。

复习到期检查:`getDueReviews`(`coordinator.js`),由 `alarm-manager.js` 每日 alarm 触发 `runDailyReviewCheck`。

---

## 11. Content Scripts 详解

- [content.js](src/content/content.js):建 `window.LCC` 命名空间 + `LCC.bg` 发消息(检测 "Extension context invalidated" 并提示刷新)。启动顺序:page-hook → 监听 page message → problem-detector → timer-tracker → submission-watcher。`bootstrap()` 用 `setTimeout(0)` 等同级脚本就绪后再 `start()`。
- [problem-detector.js](src/content/problem-detector.js):hook `history.pushState/replaceState` + `popstate`,`parseProblemSlug` 取 slug,`PROBLEM_ENTERED` 上报;GQL 异步补全 `PROBLEM_META`。DOM 兜底读标题(标记 `partial:true`)。
- [page-hook.js](src/content/page-hook.js)(MAIN world):包裹 `fetch`/`XHR`,识别 submit/interpret_solution 请求体(`typedCode`/`lang`,兼容 `data_json`),postMessage 回传 `SUBMIT_REQUEST`/`SUBMIT_RESULT`。`/submissions/detail/<id>/check/` 响应解析 status_code(10=Accepted 等),`runcode_` 前缀判为运行;runtime/memory 多字段兼容(`status_runtime`/`display_runtime`/`status_memory` 等)。
- [submission-watcher.js](src/content/submission-watcher.js):合并 pendingSubmit 的 code/lang;DOM MutationObserver 兜底监听结果容器文本(只看结果容器选择器,避免命中统计区 "Accepted: 1.2M")。
- [timer-tracker.js](src/content/timer-tracker.js):`visibilitychange`/`blur`/`focus` 降权,每 30s `TIMER_TICK`,`TIMER_STOP` 时 `TIMER_FINAL`。
- [leetcode-api.js](src/content/leetcode-api.js):`POST https://leetcode.cn/graphql/`,`credentials:"include"`(自带 cookie);`fetchQuestion` 归一化 ProblemMeta;`readFromPageGlobal` 读 `__NEXT_DATA__` 快速路径。

---

## 12. 通知与定时器

- [notification-manager.js](src/background/notification-manager.js):`notify({id,title,message,buttons,onClick,onButton})`,按钮回调存 `pendingActions` Map,`installNotificationListeners` 绑定点击/按钮点击/关闭。`iconUrl` 用相对路径(注释说明不能用 `getURL`/data URI)。
- [alarm-manager.js](src/background/alarm-manager.js):
  - `setStuckAlarm(problemKey, minutes)` / `clearStuckAlarm`:卡壳提醒(`stuck:<problemKey>`)。
  - `ensureDailyReviewAlarm(hour)`:每日 `reviewCheckHour` 点触发,`periodInMinutes=24*60` 重复。
  - `installAlarmListener(onStuck, onDailyReview)`。
- 系统通知失败时,coordinator 用 `sendToastToActiveTab` 在 LeetCode 页内弹 toast 兜底(content.js `SHOW_TOAST`)。

---

## 13. 权限与 MV3 约束

[manifest.json](manifest.json):
- `permissions`:storage, notifications, alarms, tabs, scripting, downloads。
- `host_permissions`:`https://leetcode.cn/*`。
- `optional_host_permissions`:`http://*/*`, `https://*/*`(LLM/飞书域名按需授权)。
- Background:`"service_worker"`, `"type":"module"`。
- Content scripts 两段:isolated(`document_idle`)+ MAIN world(`document_start`,仅 `page-hook.js`)。
- 最低 Chrome 111。

---

## 14. 测试

[tests/smoke.test.mjs](tests/smoke.test.mjs):纯函数 smoke test(无 chrome 依赖),覆盖 `utils`、`store/schema`、`deepMerge`、`SM-2`、`prompts` 解析。

运行:

```bash
node tests/smoke.test.mjs
```

> 改动 store/schema/utils/sm2/prompts 后应跑此测试。涉及 chrome API 的逻辑无自动化测试,需手动验证。

---

## 15. 文档维护规则

**强制规则:每次新增功能(或修改既有行为)后,必须同步迭代本文档对应章节,并保证:**

1. **不歪曲代码事实**:所有陈述必须能在源码中找到对应。引用时标注依据(文件路径 + 符号名/行号)。
2. **保持目录(TOC)有效**:新增章节时同步更新顶部 TOC,使 AI 能按需跳转、减少 token 输入。
3. **变更即更新**:新增/修改消息类型、存储字段、Note 字段、Agent capability、Uploader、Prompt 输出字段、权限等契约时,必须更新第 4/5/6/7/8/9/13 章对应表格。
4. **删除即清理**:移除功能时,同步删除本文档相关描述,避免误导。
5. **代码优先**:若本文档与代码冲突,以代码为准,并立即修正本文档。
6. **迭代纪要**:在下方「依据来源索引」补充本次变更涉及的文件。

---

## 16. 依据来源索引

> 以下为本文件陈述所依据的源码位置(AI 校验事实时按图索骥)。

| 章节 | 依据文件 | 关键符号 |
|---|---|---|
| 1 | [manifest.json](manifest.json), [README.md](README.md) | `manifest_version`, 技术栈段 |
| 2 | [src/](src/) | 目录结构 + 各文件顶部注释 |
| 3 | [manifest.json](manifest.json), [content.js](src/content/content.js), [page-hook.js](src/content/page-hook.js) | `content_scripts`, `window.LCC`, MAIN world 注释 |
| 4 | [store.js](src/storage/store.js), [schema.js](src/storage/schema.js) | 顶部分区注释, `NOTE_FIELDS`, `newNoteSkeleton` |
| 5 | [coordinator.js](src/background/coordinator.js) | `handleMessage` |
| 6 | [coordinator.js](src/background/coordinator.js), [store.js](src/storage/store.js) | `generateNoteFor`, `findNoteByProblemKey`, `saveNote`, `onSubmissionResult` |
| 7 | [agent-registry.js](src/agents/agent-registry.js), [note-agent.js](src/agents/note-agent.js), [code-analysis-agent.js](src/agents/code-analysis-agent.js), [review-agent.js](src/agents/review-agent.js) | `runCapability`, 各 agent `capabilities` |
| 8 | [uploader-registry.js](src/uploaders/uploader-registry.js), [feishu-uploader.js](src/uploaders/feishu-uploader.js), [markdown-uploader.js](src/uploaders/markdown-uploader.js) | `upload`, `name` |
| 9 | [llm-client.js](src/llm/llm-client.js), [prompts.js](src/llm/prompts.js) | `chatComplete`, `buildNoteGenerationPrompt`, `parseNoteGenerationResult` |
| 10 | [sm2.js](src/review/sm2.js), [schema.js](src/storage/schema.js) | `sm2Init`, `sm2Next`, `REVIEW_GRADES` |
| 11 | [content.js](src/content/content.js), [problem-detector.js](src/content/problem-detector.js), [page-hook.js](src/content/page-hook.js), [submission-watcher.js](src/content/submission-watcher.js), [timer-tracker.js](src/content/timer-tracker.js), [leetcode-api.js](src/content/leetcode-api.js) | 各模块 `start`/`detect`/`fetch` |
| 12 | [notification-manager.js](src/background/notification-manager.js), [alarm-manager.js](src/background/alarm-manager.js) | `notify`, `ensureDailyReviewAlarm`, `installAlarmListener` |
| 13 | [manifest.json](manifest.json) | `permissions`, `host_permissions`, `optional_host_permissions` |
| 14 | [tests/smoke.test.mjs](tests/smoke.test.mjs) | 测试用例 |
