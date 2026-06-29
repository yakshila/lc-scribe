# 附录:权限 / 测试 / 维护规则 / 依据索引(第 13-16 章)

> 返回 [索引](../../AI_GUIDE.md)。本文件覆盖权限与 MV3 约束、测试、文档维护规则、依据来源索引。

## 目录

13. [权限与 MV3 约束](#13-权限与-mv3-约束)
14. [测试](#14-测试)
15. [文档维护规则](#文档维护规则)
16. [依据来源索引](#依据来源索引)

---

## 13. 权限与 MV3 约束

[manifest.json](../../manifest.json):
- `permissions`:storage, notifications, alarms, tabs, scripting, downloads。
- `host_permissions`:`https://leetcode.cn/*`。
- `optional_host_permissions`:`http://*/*`, `https://*/*`(LLM/飞书域名按需授权)。
- Background:`"service_worker"`, `"type":"module"`。
- Content scripts 两段:isolated(`document_idle`)+ MAIN world(`document_start`,仅 `page-hook.js`)。
- 最低 Chrome 111。

---

## 14. 测试

[tests/smoke.test.mjs](../../tests/smoke.test.mjs):纯函数 smoke test(无 chrome 依赖),覆盖 `utils`、`store/schema`、`deepMerge`、`SM-2`、`prompts` 解析。

运行:

```bash
node tests/smoke.test.mjs
```

> 改动 store/schema/utils/sm2/prompts 后应跑此测试。涉及 chrome API 的逻辑无自动化测试,需手动验证。

---

## 文档维护规则

**强制规则:每次新增功能(或修改既有行为)后,必须同步迭代 AI 文档对应章节,并保证:**

1. **不歪曲代码事实**:所有陈述必须能在源码中找到对应。引用时标注依据(文件路径 + 符号名/行号)。
2. **保持索引与 TOC 有效**:新增章节时同步更新 [根索引 AI_GUIDE.md](../../AI_GUIDE.md) 的子文档导航表 + 本目录子文件的局部 TOC,使 AI 能按需跳转、减少 token 输入。
3. **变更即更新**:新增/修改消息类型、存储字段、Note 字段、Agent capability、Uploader、Prompt 输出字段、权限等契约时,必须更新 [data-contract.md](./data-contract.md) / [note-pipeline.md](./note-pipeline.md) / [integrations.md](./integrations.md) / [content-runtime.md](./content-runtime.md) / 本文件第 13 章对应表格。
4. **拆分即维护**:新增主题若超过单文件合理篇幅(建议 < 120 行),可新建子文件并更新根索引表;避免单文件膨胀。
5. **删除即清理**:移除功能时,同步删除文档相关描述,避免误导。
6. **代码优先**:若文档与代码冲突,以代码为准,并立即修正文档。
7. **迭代纪要**:在下方「依据来源索引」补充本次变更涉及的文件。

---

## 依据来源索引

> 以下为本仓库 AI 文档陈述所依据的源码位置(AI 校验事实时按图索骥)。

| 章节 | 所在文档 | 依据文件 | 关键符号 |
|---|---|---|---|
| 1-3 | [overview.md](./overview.md) | [manifest.json](../../manifest.json), [README.md](../../README.md), [src/](../../src/), [content.js](../../src/content/content.js), [page-hook.js](../../src/content/page-hook.js) | `manifest_version`, 技术栈段, `content_scripts`, `window.LCC`, MAIN world 注释 |
| 4-5 | [data-contract.md](./data-contract.md) | [store.js](../../src/storage/store.js), [schema.js](../../src/storage/schema.js), [coordinator.js](../../src/background/coordinator.js), [content.js](../../src/content/content.js) | 顶部分区注释, `NOTE_FIELDS`, `newNoteSkeleton`, `handleMessage` |
| 6-7 | [note-pipeline.md](./note-pipeline.md) | [coordinator.js](../../src/background/coordinator.js), [store.js](../../src/storage/store.js), [agent-registry.js](../../src/agents/agent-registry.js), [note-agent.js](../../src/agents/note-agent.js), [code-analysis-agent.js](../../src/agents/code-analysis-agent.js), [review-agent.js](../../src/agents/review-agent.js) | `generateNoteFor`, `findNoteByProblemKey`, `saveNote`, `onSubmissionResult`, `runCapability`, 各 agent `capabilities` |
| 8-10 | [integrations.md](./integrations.md) | [uploader-registry.js](../../src/uploaders/uploader-registry.js), [feishu-uploader.js](../../src/uploaders/feishu-uploader.js), [markdown-uploader.js](../../src/uploaders/markdown-uploader.js), [llm-client.js](../../src/llm/llm-client.js), [prompts.js](../../src/llm/prompts.js), [sm2.js](../../src/review/sm2.js), [schema.js](../../src/storage/schema.js) | `upload`, `name`, `chatComplete`, `buildNoteGenerationPrompt`, `parseNoteGenerationResult`, `sm2Init`, `sm2Next`, `REVIEW_GRADES` |
| 11-12 | [content-runtime.md](./content-runtime.md) | [content.js](../../src/content/content.js), [problem-detector.js](../../src/content/problem-detector.js), [page-hook.js](../../src/content/page-hook.js), [submission-watcher.js](../../src/content/submission-watcher.js), [timer-tracker.js](../../src/content/timer-tracker.js), [leetcode-api.js](../../src/content/leetcode-api.js), [notification-manager.js](../../src/background/notification-manager.js), [alarm-manager.js](../../src/background/alarm-manager.js) | 各模块 `start`/`detect`/`fetch`, `notify`, `ensureDailyReviewAlarm`, `installAlarmListener` |
| 13-14 | 本文件 | [manifest.json](../../manifest.json), [tests/smoke.test.mjs](../../tests/smoke.test.mjs) | `permissions`, `host_permissions`, `optional_host_permissions`, 测试用例 |
