// 计时器:记录用户在单道题目上的有效活跃时长。
// —— 重构后的计时模型 ——
// 显式状态机:IDLE → TRACKING → PAUSED → TRACKING / IDLE
//   IDLE     未在计时
//   TRACKING 正在计时某题(持有 currentProblemKey,累加 accumulatedActive)
//   PAUSED   页面不可见(切走 tab / 最小化),暂停累加
//
// 监听归属(厘清之前 timer 与 detector 双监听冲突):
//   - visibilitychange 只归 timer 管:浏览器级 tab 切换,不会被 LeetCode 页面内弹窗/编辑器误触发。
//   - 不再监听 blur/focus:LeetCode 提交结果弹窗、代码编辑器聚焦、内嵌 iframe 都会触发 blur,导致误暂停。
//   - problem-detector 不再监听 visibilitychange/focus 触发 detect,只靠 SPA 路由 hook。
//
// 换题(SPA 同 tab 切题):
//   coordinator 发 TIMER_START(新 problemKey)前,先发 TIMER_STOP(旧 problemKey)。
//   timer 收到 TIMER_START 时若仍在 TRACKING 旧题,先 flush 旧题 FINAL 再切到新题,
//   保证旧题计时数据不丢失。
(function () {
  const LCC = window.LCC;
  if (!LCC) return;

  const STATE = { IDLE: "IDLE", TRACKING: "TRACKING", PAUSED: "PAUSED" };

  // —— 计时状态(单题维度,同一时刻只追踪一道题) ——
  let state = STATE.IDLE;
  let currentProblemKey = null;       // 当前计时的题
  let sessionStart = null;            // 本题 session 起始 ts(墙上时钟,仅日志用)
  let accumulatedActive = 0;          // ms,本题有效活跃时长
  let lastActiveTick = null;          // ms,上次活跃起点(用于累加)
  let tickTimer = null;               // setInterval handle

  function now() { return Date.now(); }

  // 计算当前题的有效活跃秒数
  function effectiveElapsedSec() {
    if (state === STATE.IDLE) return 0;
    let total = accumulatedActive;
    if (state === STATE.TRACKING && lastActiveTick) total += now() - lastActiveTick;
    return Math.floor(total / 1000);
  }

  // 上报当前题的 elapsed 到 background
  function reportTick() {
    if (state === STATE.IDLE || !currentProblemKey) return;
    LCC.bg("TIMER_TICK", { elapsedSec: effectiveElapsedSec(), problemKey: currentProblemKey });
  }

  // flush:把当前题最终时长上报后清零状态。用于换题 / STOP / 卸载。
  function flushCurrent() {
    if (state === STATE.IDLE || !currentProblemKey) return;
    reportTick(); // 先报一次最新值
    LCC.bg("TIMER_FINAL", { elapsedSec: effectiveElapsedSec(), problemKey: currentProblemKey });
    LCC.utils.log("info", "timer", `flush ${currentProblemKey}: ${effectiveElapsedSec()}s`);
    // 清零
    state = STATE.IDLE;
    currentProblemKey = null;
    sessionStart = null;
    accumulatedActive = 0;
    lastActiveTick = null;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  // 开始计一道题。若当前还在计别的题,先 flush 旧的(保证旧题数据不丢)。
  function startTracking(problemKey) {
    if (currentProblemKey === problemKey && state !== STATE.IDLE) {
      // 同题重复 START:不重置,只确保在 TRACKING(可能从 PAUSED 恢复)
      if (state === STATE.PAUSED) resume();
      return;
    }
    if (state !== STATE.IDLE) {
      flushCurrent(); // 换题:先上报旧题
    }
    currentProblemKey = problemKey;
    sessionStart = now();
    accumulatedActive = 0;
    lastActiveTick = now();
    state = STATE.TRACKING;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(reportTick, 30000); // 每 30s 上报,供 popup 显示 + 卡壳检测
    LCC.utils.log("info", "timer", `start ${problemKey}`);
  }

  function stopTracking() {
    flushCurrent();
  }

  function pause() {
    if (state !== STATE.TRACKING) return;
    if (lastActiveTick) {
      accumulatedActive += now() - lastActiveTick;
      lastActiveTick = null;
    }
    state = STATE.PAUSED;
    LCC.utils.log("debug", "timer", `pause ${currentProblemKey} @ ${Math.floor(accumulatedActive / 1000)}s`);
  }

  function resume() {
    if (state !== STATE.PAUSED) return;
    lastActiveTick = now();
    state = STATE.TRACKING;
    LCC.utils.log("debug", "timer", `resume ${currentProblemKey}`);
  }

  LCC.timerTracker = {
    start() {
      // —— 监听 background 下发的计时指令 ——
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === "TIMER_START") {
          // 用消息里的 problemKey,兜底用 LCC.state.currentProblemKey
          const pk = (msg.payload && msg.payload.problemKey) || LCC.state.currentProblemKey;
          if (pk) startTracking(pk);
        } else if (msg.type === "TIMER_STOP") {
          stopTracking();
        }
      });

      // —— 页面可见性:浏览器级 tab 切换 / 最小化,唯一可信的"切走"信号 ——
      // 不监听 blur/focus:LeetCode 内部弹窗/编辑器会误触发 blur,导致做题中误暂停。
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          pause();
        } else {
          resume();
          // 兜底:切走期间 timer 可能被 STOP(AC / SPA 换题 STOP 旧题后新题 START 竞态丢失 / 消息乱序),
          // 此时 state=IDLE,resume() 不会重启。若仍在题目页,重新 startTracking,确保切回必定计时。
          // AC 后继续计时只更新 session.elapsedSec,不影响已固定的 durationSec,无副作用。
          if (state === STATE.IDLE && LCC.state.currentProblemKey) {
            LCC.utils.log("info", "timer", `visible from IDLE, restart ${LCC.state.currentProblemKey}`);
            startTracking(LCC.state.currentProblemKey);
          }
        }
      });

      // —— 卸载兜底:页面关闭前 flush,避免最后一次时长丢失 ——
      window.addEventListener("beforeunload", () => flushCurrent(), { once: true });
    },
    effectiveElapsedSec,
    // 暴露给诊断/测试
    getState() { return { state, currentProblemKey, elapsedSec: effectiveElapsedSec() }; },
  };
})();
