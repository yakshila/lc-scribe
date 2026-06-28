# LC Scribe

> 力扣刷题助手浏览器扩展 — 自动识别题目与提交、关键节点提醒、AI 笔记生成、间隔复习,可扩展 Agent 与上传器。

面向 [leetcode.cn](https://leetcode.cn) 的 Chrome/Edge MV3 扩展。在你刷题时安静地工作,只在关键节点(AC、卡壳、到期复习)提醒你,并把每道题沉淀成结构化笔记 + 复习计划。

## 功能一览

| 能力 | 说明 |
|---|---|
| 自动识别 | 进入题目页自动识别题目元数据;提交时自动捕获代码、语言、状态、耗时 |
| 完整做题轨迹 | 记录每一次"运行"和"提交"(代码/状态/runtime/memory),不只是 AC 那次,体现真实试错过程 |
| 关键节点提醒 | AC 提醒 / N 分钟未 AC 卡壳提醒(可配阈值)/ 每日到期复习提醒;系统通知失败时页面内 toast 兜底 |
| AI 笔记生成 | AC 后一键(或自动)生成结构化笔记:思路 / 复杂度 / 经验提炼 / AI 补充;踩坑分析为深度 code review(现象→根因→错代码→修法→规律) |
| 代码高亮 | 笔记详情页代码块语法高亮(highlight.js,支持 Go/Python/Java/C++/JS/TS/Rust 等) |
| 间隔复习 | 内置 SM-2 算法,按"忘记/困难/良好/简单"推进复习间隔 |
| 第三方模型 | OpenAI 兼容 API(OpenAI / DeepSeek / 智谱 GLM / Kimi / 通义 / 本地 Ollama 等) |
| 可扩展 Agent | 按 capability 调度,内置笔记生成 / 代码分析 / 复习调度三个 Agent |
| 可扩展上传器 | 内置飞书 Webhook + Markdown 导出,接口开放,可接 Notion / Obsidian 等 |

## 安装

### 方式一:从 Release 下载(推荐)

1. 前往 [Releases](https://github.com/yakshila/lc-scribe/releases),下载最新 `lc-scribe-*.zip` 并解压
2. 打开 `chrome://extensions`(Edge 为 `edge://extensions`)
3. 右上角开启 **开发者模式**
4. 点击 **加载已解压的扩展程序**,选择解压出来的目录
5. 打开 [leetcode.cn](https://leetcode.cn) 开始刷题

> 每次 main 分支合并都会自动构建并发布新 Release。

### 方式二:从源码加载

```bash
git clone https://github.com/yakshila/lc-scribe.git
```

然后在 `chrome://extensions` 加载该目录即可(无需构建步骤,纯原生 ES module)。

## 首次使用

1. 安装后会自动打开设置页
2. 在「第三方模型」区块填入:
   - **Base URL**(填到 `/v1`,如 `https://api.openai.com/v1`)
   - **API Key**
   - **Model**(如 `gpt-4o-mini`)
3. 点击「授权域名」→「测试连接」
4. (可选)配置通知阈值、复习参数、飞书 Webhook、Markdown 自动导出
5. 去 leetcode.cn 刷题即可,AC 后点通知里的「生成笔记」(或在设置里打开「AC 后自动生成笔记」)

> 不配置模型也能用,只是笔记的 AI 部分会留空,其余字段(题目元数据 / 做题过程 / 复习调度)照常工作。

## 架构

```
┌─────────────────────── Content Scripts (leetcode.cn 页内) ───────────────────────┐
│  problem-detector  ──  SPA 路由 hook,识别当前题目                                 │
│  page-hook (主世界) ─  包裹 fetch/XHR,捕获提交请求体与结果响应                    │
│  submission-watcher ─  DOM 兜底监听 "Accepted" 文本                               │
│  timer-tracker ──────  可见性感知的有效用时统计                                    │
│  leetcode-api ───────  GraphQL 拉题目元数据                                       │
└───────────────────────────────┬───────────────────────────────────────────────────┘
                                │ chrome.runtime.sendMessage
┌───────────────────────────────▼───────────────────────────────────────────────────┐
│                        Background Service Worker                                  │
│  coordinator ───  核心编排:事件 → Agent → 存储 → 复习 → 通知                      │
│  notification-manager / alarm-manager                                             │
└──┬──────────────────┬──────────────────┬──────────────────┬──────────────────────┘
   │                  │                  │                  │
   ▼                  ▼                  ▼                  ▼
┌─────────┐     ┌──────────┐      ┌────────────┐     ┌──────────────┐
│ Storage │     │   LLM    │      │   Agents   │     │  Uploaders   │
│ (notes/ │     │ (OpenAI  │      │ (registry  │     │ (registry    │
│  review │     │  兼容)    │      │  by cap)   │     │  by name)    │
│  /...)  │     │          │      │            │     │              │
└─────────┘     └──────────┘      └────────────┘     └──────────────┘
```

### Agent 架构(可扩展)

Coordinator 不直接调用某个 Agent,而是按 **capability** 调度:

```js
registry.runCapability("note-generation", ctx);
```

后续接入第三方 Agent,只需注册一个声明了相同 capability 的实现即可替换或增强,无需改 coordinator。`ctx` 是共享上下文 `{ note, session, problem, settings, failedAttempts }`,多 Agent 形成流水线(代码分析 → 笔记生成 → 复习调度)。

内置 Agent:

| Agent | capability | 说明 |
|---|---|---|
| `note-agent` | `note-generation` | 调 LLM 产出思路/复杂度/经验/AI 补充 |
| `code-analysis-agent` | `code-analysis` | 标注 AC 代码关键行,给出改进点评 |
| `review-agent` | `review-scheduler` | 为新笔记初始化 SM-2 复习状态(纯本地,不调 LLM) |

### Uploader 架构(可扩展)

同一 `upload(note, opts)` 接口,内置:
- `feishu` — 飞书自定义机器人 Webhook,发送互动卡片
- `markdown` — 本地 `.md` 下载

加新目标(如 Notion / Obsidian)只需 `registry.registerUploader(new XxxUploader())`。

## 笔记结构

分 7 层,客观/主观/AI 增量分离,便于追溯与编辑:

```
meta          题号 / slug / 标题 / 难度 / 标签 / url          ← LeetCode 客观
solving       开始/AC 时刻 / 用时 / 提交次数 / 一次 AC / 语言 / 完整做题轨迹(运行+提交) ← 插件采集
approach      直觉 / 解法 / 算法 / 数据结构 / 复杂度           ← 用户可编辑,Agent 辅助
code          语言 / AC 代码 / 关键行标注                      ← Agent 标注
insights      踩坑(深度分析:现象/根因/错代码/修法/规律) / 收获 / 可复用模式 / 相关题 ← Agent 辅助提炼
review        SM-2: 间隔 / ease / 重复次数 / 下次复习 / 历史   ← 调度状态
aiGenerated   总结 / 其他解法 / 常见错误 / 面试建议            ← AI 增量,与用户字段分离
```

## 权限说明

| 权限 | 用途 |
|---|---|
| `storage` | 存笔记 / 复习状态 / 设置 |
| `notifications` | AC / 卡壳 / 复习提醒 |
| `alarms` | 卡壳定时器、每日复习检查 |
| `tabs` / `scripting` | 打开笔记页、向 content script 下发指令 |
| `downloads` | Markdown 导出 |
| `host_permissions: leetcode.cn` | 题目识别与提交捕获 |
| `optional_host_permissions: *://*/*` | LLM / 飞书域名按需授权(默认不申请) |

LLM 与飞书域名走 optional 权限,只在设置页点击「授权」时才申请,不会一上来就要 `<all_urls>`。

## 开发

```bash
# 跑纯函数 smoke test(无 chrome 依赖)
node tests/smoke.test.mjs
```

项目无构建步骤,纯原生 ES module + IIFE,改完代码在 `chrome://extensions` 点「重新加载」即可生效。图标已预生成并提交到 `icons/`,无需重新生成。

### 调试

- **content script 日志**:LeetCode 页面 F12 Console
- **service worker 日志**:`chrome://extensions` → LC Scribe → 点「Service Worker」链接
- **诊断页**:访问 `chrome-extension://<id>/src/diagnose/diagnose.html` 可查看当前状态、session、设置
- 调试 AC 无提示时,优先确认:① 是否刷新了 LeetCode 页面(避免 context invalidated)② LLM 是否在设置里启用 ③ `autoGenerate` 是否开启(否则需点 toast/通知的「生成笔记」按钮)

## 技术栈

Chrome Manifest V3 · 原生 ES module · chrome.storage · SM-2 · OpenAI 兼容 API · 飞书 Webhook

## License

MIT
