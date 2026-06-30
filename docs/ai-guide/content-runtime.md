# Content Scripts 与运行时服务(第 11-12 章)

> 返回 [索引](../../AI_GUIDE.md)。本文件覆盖 Content Scripts 详解、通知与定时器。

## 目录

11. [Content Scripts 详解](#11-content-scripts-详解)
12. [通知与定时器](#12-通知与定时器)

---

## 11. Content Scripts 详解

- [content.js](../../src/content/content.js):建 `window.LCC` 命名空间 + `LCC.bg` 发消息(检测 "Extension context invalidated" 并提示刷新)。启动顺序:page-hook → 监听 page message → problem-detector → timer-tracker → submission-watcher。`bootstrap()` 用 `setTimeout(0)` 等同级脚本就绪后再 `start()`。
- [problem-detector.js](../../src/content/problem-detector.js):hook `history.pushState/replaceState` + `popstate`,`parseProblemSlug` 取 slug,`PROBLEM_ENTERED` 上报;GQL 异步补全 `PROBLEM_META`。DOM 兜底读标题(标记 `partial:true`)。**额外监听 `visibilitychange`/`focus`**:切浏览器 tab 回来 / 最小化恢复时重新 `detect`(SPA 可能在隐藏期间已换题,且后台 tab 的 history hook 定时器可能被限流)。
- [page-hook.js](../../src/content/page-hook.js)(MAIN world):包裹 `fetch`/`XHR`,识别 submit/interpret_solution 请求体(`typedCode`/`lang`,兼容 `data_json`),postMessage 回传 `SUBMIT_REQUEST`/`SUBMIT_RESULT`。`/submissions/detail/<id>/check/` 响应解析 status_code(10=Accepted 等),`runcode_` 前缀判为运行;runtime/memory 多字段兼容(`status_runtime`/`display_runtime`/`status_memory` 等)。
- [submission-watcher.js](../../src/content/submission-watcher.js):合并 pendingSubmit 的 code/lang;DOM MutationObserver 兜底监听结果容器文本(只看结果容器选择器,避免命中统计区 "Accepted: 1.2M")。
- [timer-tracker.js](../../src/content/timer-tracker.js):`visibilitychange`/`blur`/`focus` 降权,每 30s `TIMER_TICK`,`TIMER_STOP` 时 `TIMER_FINAL`。
- [leetcode-api.js](../../src/content/leetcode-api.js):`POST https://leetcode.cn/graphql/`,`credentials:"include"`(自带 cookie);`fetchQuestion` 归一化 ProblemMeta;`readFromPageGlobal` 读 `__NEXT_DATA__` 快速路径。

---

## 12. 通知与定时器

- [notification-manager.js](../../src/background/notification-manager.js):`notify({id,title,message,buttons,onClick,onButton,requireInteraction})`,按钮回调存 `pendingActions` Map,`installNotificationListeners` 绑定点击/按钮点击/关闭。`iconUrl` 用相对路径(注释说明不能用 `getURL`/data URI)。**带按钮的通知默认 `requireInteraction:true`**(常驻直到用户操作,避免按钮被自动消失吞掉)。
- [alarm-manager.js](../../src/background/alarm-manager.js):
  - `setStuckAlarm(problemKey, minutes)` / `clearStuckAlarm`:卡壳提醒(`stuck:<problemKey>`)。
  - `ensureDailyReviewAlarm(hour)`:每日 `reviewCheckHour` 点触发,`periodInMinutes=24*60` 重复。
  - `installAlarmListener(onStuck, onDailyReview)`:`onAlarm` 监听器为 **async 并 await 回调**(MV3 SW 会等异步完成再休眠,避免 `notify()` 未完成就被杀导致通知不弹出)。
- 每日复习通知(`runDailyReviewCheck`):带「生成 AI 解答」/「稍后」按钮。点「生成 AI 解答」对到期题(限 `maxDuePerDay`)并发触发 `generateExplanationFor` 并打开复习页;点主体只打开复习页。
- **每天只提醒一次**:`runDailyReviewCheck` 用 `stats.lastReviewNotifiedDate`(YYYY-MM-DD)去重,同一天内 SW 多次唤醒(浏览器打开/从最小化恢复/切 tab 触发 SW 重启)都不重复弹。`initCoordinator` 的 `setTimeout(runDailyReviewCheck, 5000)` 保证 SW 每次唤醒都检查一次。
- **复习数据契约修复**:`saveReview(noteId, review)` 把 `noteId` 写进 review 对象本身(`{ ...review, noteId }`),否则 `listReviews()` 用 `Object.values` 取出的 review 不含 noteId,`getDueReviews` 里 `noteMap.get(r.noteId)` 永远 undefined,导致复习 tab 不显示任何待复习题。
- **自定义复习节奏**:`setCustomReview(noteId, days)` 允许用户手动指定 N 天后复习,覆盖 SM-2 算法结果(保留 ease/repetitions/reviewHistory,只改 interval + nextReviewAt,标记 `customSet:true`)。消息 `SET_CUSTOM_REVIEW`,UI 在笔记详情页「自定义下次复习」输入框。
- 系统通知失败时,coordinator 用 `sendToastToActiveTab` 在 LeetCode 页内弹 toast 兜底(content.js `SHOW_TOAST`)。
- **页面内进度 toast**([content.js](../../src/content/content.js) `showToast`):支持 `id` 复用(同 id 更新内容不重建元素)、`state`(`loading`/`success`/`error`/`info`/`warn`,loading 显示 CSS spinner)、`sticky`(常驻不自动消失,等后续 update)。`toastElements` Map 缓存 `id -> element`,`removeToast` 同步清 Map 与定时器。
- **笔记生成进度反馈**([coordinator.js](../../src/background/coordinator.js) `runNoteGenerationWithProgress`):点通知/toast「生成笔记」按钮或 `autoGenerate` 时,先弹 loading toast(`gen-note-<problemKey>`,sticky+spinner),生成完成更新为 success 态带「查看笔记」按钮(`view-note` action 打开 `note-viewer.html?id=<noteId>`),失败更新为 error 态显示错误。解决"点按钮后通知消失、几十秒黑盒无反馈"。
- toast 按钮消息 `TOAST_BUTTON` 支持 action:`generate-note`(走进度反馈)、`view-note`(打开笔记详情页)、`later`(无操作)。
