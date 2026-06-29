# Content Scripts 与运行时服务(第 11-12 章)

> 返回 [索引](../../AI_GUIDE.md)。本文件覆盖 Content Scripts 详解、通知与定时器。

## 目录

11. [Content Scripts 详解](#11-content-scripts-详解)
12. [通知与定时器](#12-通知与定时器)

---

## 11. Content Scripts 详解

- [content.js](../../src/content/content.js):建 `window.LCC` 命名空间 + `LCC.bg` 发消息(检测 "Extension context invalidated" 并提示刷新)。启动顺序:page-hook → 监听 page message → problem-detector → timer-tracker → submission-watcher。`bootstrap()` 用 `setTimeout(0)` 等同级脚本就绪后再 `start()`。
- [problem-detector.js](../../src/content/problem-detector.js):hook `history.pushState/replaceState` + `popstate`,`parseProblemSlug` 取 slug,`PROBLEM_ENTERED` 上报;GQL 异步补全 `PROBLEM_META`。DOM 兜底读标题(标记 `partial:true`)。
- [page-hook.js](../../src/content/page-hook.js)(MAIN world):包裹 `fetch`/`XHR`,识别 submit/interpret_solution 请求体(`typedCode`/`lang`,兼容 `data_json`),postMessage 回传 `SUBMIT_REQUEST`/`SUBMIT_RESULT`。`/submissions/detail/<id>/check/` 响应解析 status_code(10=Accepted 等),`runcode_` 前缀判为运行;runtime/memory 多字段兼容(`status_runtime`/`display_runtime`/`status_memory` 等)。
- [submission-watcher.js](../../src/content/submission-watcher.js):合并 pendingSubmit 的 code/lang;DOM MutationObserver 兜底监听结果容器文本(只看结果容器选择器,避免命中统计区 "Accepted: 1.2M")。
- [timer-tracker.js](../../src/content/timer-tracker.js):`visibilitychange`/`blur`/`focus` 降权,每 30s `TIMER_TICK`,`TIMER_STOP` 时 `TIMER_FINAL`。
- [leetcode-api.js](../../src/content/leetcode-api.js):`POST https://leetcode.cn/graphql/`,`credentials:"include"`(自带 cookie);`fetchQuestion` 归一化 ProblemMeta;`readFromPageGlobal` 读 `__NEXT_DATA__` 快速路径。

---

## 12. 通知与定时器

- [notification-manager.js](../../src/background/notification-manager.js):`notify({id,title,message,buttons,onClick,onButton})`,按钮回调存 `pendingActions` Map,`installNotificationListeners` 绑定点击/按钮点击/关闭。`iconUrl` 用相对路径(注释说明不能用 `getURL`/data URI)。
- [alarm-manager.js](../../src/background/alarm-manager.js):
  - `setStuckAlarm(problemKey, minutes)` / `clearStuckAlarm`:卡壳提醒(`stuck:<problemKey>`)。
  - `ensureDailyReviewAlarm(hour)`:每日 `reviewCheckHour` 点触发,`periodInMinutes=24*60` 重复。
  - `installAlarmListener(onStuck, onDailyReview)`。
- 系统通知失败时,coordinator 用 `sendToastToActiveTab` 在 LeetCode 页内弹 toast 兜底(content.js `SHOW_TOAST`)。
