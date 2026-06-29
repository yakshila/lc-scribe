# 概览(第 1-3 章)

> 返回 [索引](../../AI_GUIDE.md)。本文件覆盖项目定位、目录结构、运行时拓扑。

## 目录

1. [项目定位与技术栈](#1-项目定位与技术栈)
2. [目录结构](#2-目录结构)
3. [运行时拓扑与数据流](#3-运行时拓扑与数据流)

---

## 1. 项目定位与技术栈

LC Scribe 是面向 [leetcode.cn](https://leetcode.cn) 的 Chrome/Edge **MV3 浏览器扩展**,在用户刷题时自动识别题目与提交,在关键节点(AC、卡壳、到期复习)提醒,并把每道题沉淀为结构化笔记 + SM-2 复习计划。

- **技术栈**:Chrome Manifest V3 · 原生 ES module(无构建步骤)· `chrome.storage` · SM-2 · OpenAI 兼容 API · 飞书 Webhook。
- **无打包**:改完代码在 `chrome://extensions` 点「重新加载」即生效。
- 依据:[manifest.json](../../manifest.json)(`manifest_version: 3`, `"type": "module"`)、[README.md](../../README.md)「技术栈」「开发」段。

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

依据:[src/](../../src/) 目录列举;各文件顶部注释。

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
- 依据:[manifest.json](../../manifest.json) `content_scripts`(两段:isolated + MAIN)、[content.js](../../src/content/content.js) `window.LCC` 定义、[page-hook.js](../../src/content/page-hook.js) 顶部注释。
