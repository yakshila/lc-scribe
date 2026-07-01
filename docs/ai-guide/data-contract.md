# 数据契约(第 4-5 章)

> 返回 [索引](../../AI_GUIDE.md)。本文件覆盖存储分区、Note 结构、消息 API。

## 目录

4. [存储分区与核心数据契约](#4-存储分区与核心数据契约)
5. [消息 API 总表](#5-消息-api-总表)

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
| `stats` | `Stats` | 聚合统计(部分派生,见 4.1.2) |

### 4.1.2 `stats` 字段(部分派生)

| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `acceptedProblems` | `{ [problemKey]: ISO时间 }` | 存储 | 已 AC 题目集合(按 problemKey 去重) |
| `totalAccepted` | number | **派生** | `= Object.keys(acceptedProblems).length`,同题多次 AC 只算一次 |
| `totalNotes` | number | **派生** | `= notes 实际数量`,删笔记即同步,无需手动维护 |
| `totalReviewsDone` | number | 累加存储 | 完成的复习次数 |
| `streakDays` | number | 累加存储 | 连续刷题天数 |
| `lastActiveDate` | `YYYY-MM-DD` | 存储 | 最近活跃日期 |

> 派生字段由 `getStats()` 实时计算,`bumpStats` 会忽略对 `totalAccepted`/`totalNotes` 的覆盖。AC 记录用 `markAccepted(problemKey)`(幂等),清空用 `clearStats()`。

依据:[store.js](../../src/storage/store.js) `getStats` / `markAccepted` / `clearStats` / `bumpStats`。

### 4.1.3 `settings.notes` 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoGenerate` | `false` | AC 后自动生成笔记 |
| `language` | `"zh"` | 输出语言(`zh`/`en`) |
| `includeAISection` | `true` | 是否包含 AI 增量字段 |
| `recentAttemptsToLLM` | `0` | 发给 LLM 的最近试错代码次数。`0`=全部;`>0`=只取最近 n 次 run/submit 代码(控制 token)。AC 代码始终上传,笔记仍保存完整 timeline |

依据:[store.js](../../src/storage/store.js) `DEFAULT_SETTINGS.notes`。

### 4.2 Note 结构(7 层,客观/主观/AI 增量分离)

| 字段 | 含义 | 来源 |
|---|---|---|
| `meta` | 题号/slug/标题/难度/标签/url | LeetCode 客观 |
| `solving` | 开始/AC 时刻、用时、提交次数、一次 AC、语言、`timeline[]`(运行+提交轨迹) | 插件采集 |
| `approach` | 直觉/解法/算法/数据结构/复杂度 | 用户可编辑,Agent 辅助 |
| `code` | 语言/AC 代码/`keyLines[]`(关键行标注) | Agent 标注 |
| `insights` | `pitfalls[]`(深度分析:现象/根因/错代码/修法/规律)/收获/模式/相关题 | Agent 辅助提炼 |
| `review` | SM-2:间隔/ease/repetitions/下次复习/历史 | 调度状态 |
| `aiGenerated` | 总结/其他解法/`betterApproach`(更优解法通俗讲解)/常见错误/面试建议/`explanation`(最优方案通俗讲解) | AI 增量,与用户字段分离 |

- `problemKey` 形如 `lc:<slug>`(见 [utils.js](../../src/utils.js) `problemKey`)。
- 笔记 `id` 由 `generateId("note")` 生成(`note_<base36时间>_<随机>`)。
- 依据:[schema.js](../../src/storage/schema.js) `NOTE_FIELDS`、[store.js](../../src/storage/store.js) `newNoteSkeleton`。

---

## 5. 消息 API 总表

所有消息走 `chrome.runtime.sendMessage({ type, payload })`,由 [coordinator.js](../../src/background/coordinator.js) `handleMessage` 路由,响应统一为 `{ ok, data }` 或 `{ ok:false, error }`。

**消息路由层重构**:`handleMessage` 由 `switch` 收拢为 `HANDLERS` 消息表映射(`export const HANDLERS`,每条 `{ require?, handler }`)。`require` 字段做 payload 必填校验,缺字段抛错由 service-worker 统一 catch。新增消息只需往表里加一行,不用动路由逻辑。`TIMER_TICK`/`TIMER_FINAL`/`TIMER_START`/`TIMER_STOP` 均带 `problemKey`,支持按题维度计时。

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
| `GET_STATUS` | 状态汇总(LLM/统计/当前 session)。activeSession 优先取「当前激活 LeetCode tab 对应的 session」,回退到「仍打开着的 LeetCode tab 的未 AC session」 |
| `GET_NOTES` / `GET_NOTE` | 列表 / 单条 |
| `GET_DUE_REVIEWS` | 到期复习 |
| `GET_SETTINGS` / `SAVE_SETTINGS` | 配置读写 |
| `GET_STATS` | 统计 |
| `CLEAR_STATS` | 清空 AC/复习计数(`acceptedProblems`、`totalReviewsDone`、`streakDays`);笔记不删,`totalNotes` 因派生保留 |
| `GENERATE_NOTE` | 触发笔记生成(`payload.problemKey`) |
| `GENERATE_EXPLANATION` | 触发生成「最优方案」AI 解答(`payload.noteId`),结果存入 `note.aiGenerated.explanation`,返回更新后的 Note |
| `REVIEW_GRADE` | 复习评分(`noteId`, `grade`) |
| `SET_CUSTOM_REVIEW` | 自定义下次复习(`noteId`, `days`),覆盖 SM-2 结果,标记 `customSet:true` |
| `DELETE_NOTE` | 删除笔记 |
| `DELETE_NOTES` | 批量删除笔记(`noteIds: string[]`),返回 `{ removed, count }` |
| `UPLOAD_NOTE` | 上传(`noteId`, `uploader`) |
| `BATCH_UPLOAD` | 批量上传(`noteIds: string[]`, `uploader`),返回 `{ results, total, success, failed }` |
| `GET_NOTE_MARKDOWN` | 取笔记 Markdown |
| `TRIGGER_REVIEW_CHECK` | 触发每日复习检查 |

依据:[coordinator.js](../../src/background/coordinator.js) `handleMessage`、[content.js](../../src/content/content.js) `onMessage` 监听。
