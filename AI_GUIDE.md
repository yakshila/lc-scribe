# AI_GUIDE — LC Scribe 代码导读索引(供 AI 阅读)

> 本索引是 AI 进入本仓库的「目录页」。**详细内容拆分在 [docs/ai-guide/](docs/ai-guide/) 下,按需加载单个文件以节省 token。**
> 所有陈述均来自源码;若文档与代码冲突,以代码为准,并按 [维护规则](docs/ai-guide/appendix.md#文档维护规则) 迭代。

---

## 子文档导航

| 文件 | 章节 | 主题 |
|---|---|---|
| [docs/ai-guide/overview.md](docs/ai-guide/overview.md) | 1-3 | 项目定位与技术栈 · 目录结构 · 运行时拓扑与数据流 |
| [docs/ai-guide/data-contract.md](docs/ai-guide/data-contract.md) | 4-5 | 存储分区与 Note 结构 · 消息 API 总表 |
| [docs/ai-guide/note-pipeline.md](docs/ai-guide/note-pipeline.md) | 6-7 | 笔记生成流水线(含同题覆盖) · Agent 体系 |
| [docs/ai-guide/integrations.md](docs/ai-guide/integrations.md) | 8-10 | Uploader 体系 · LLM 客户端与 Prompt · 复习调度(SM-2) |
| [docs/ai-guide/content-runtime.md](docs/ai-guide/content-runtime.md) | 11-12 | Content Scripts 详解 · 通知与定时器 |
| [docs/ai-guide/appendix.md](docs/ai-guide/appendix.md) | 13-16 | 权限与 MV3 约束 · 测试 · 文档维护规则 · 依据来源索引 |

---

## 快速入口

- **新功能必读**:[文档维护规则](docs/ai-guide/appendix.md#文档维护规则)(每次新增功能后必须迭代对应章节)
- **改笔记/存储前必读**:[data-contract.md](docs/ai-guide/data-contract.md)
- **改笔记生成逻辑前必读**:[note-pipeline.md](docs/ai-guide/note-pipeline.md)
- **新增 Agent / Uploader 前**:[note-pipeline.md §Agent](docs/ai-guide/note-pipeline.md#agent-体系按-capability-调度)、[integrations.md §Uploader](docs/ai-guide/integrations.md#uploader-体系)
- **查依据来源**:[依据来源索引](docs/ai-guide/appendix.md#依据来源索引)

---

## 一句话概览

面向 leetcode.cn 的 Chrome MV3 扩展(原生 ES module,无构建)。Content scripts 识别题目与提交 → Service Worker 协调 → Agent(LLM)生成结构化笔记 → SM-2 复习调度 → 可选上传(飞书/Markdown)。同题重新生成笔记会覆盖旧笔记并保留复习进度。
