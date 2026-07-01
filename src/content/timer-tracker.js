// 计时器:记录用户在题目页停留时间。
// 起算点:进入题目页(PROBLEM_ENTERED)。
// 暂停/继续:可选,目前用页面可见性 + 失焦降权估算"有效用时"。
// 终点:AC 提交(由 submission-watcher 触发 SUBMIT_RESULT 后 background 回传 STOP_TIMER)。
(function () {
  const LCC = window.LCC;
  if (!LCC) return;

  let startedAt = null;
  let accumulatedActive = 0; // ms,有效活跃时长
  let lastActiveTick = null;
  let active = true;
  let tickTimer = null;

  function now() {
    return Date.now();
  }

  function setActive(v) {
    if (v === active) return;
    if (v) {
      active = true;
      lastActiveTick = now();
    } else {
      active = false;
      if (lastActiveTick) {
        accumulatedActive += now() - lastActiveTick;
        lastActiveTick = null;
      }
    }
  }

  function tick() {
    if (!active || !startedAt) return;
    // 每 30s 上报一次当前用时,供 background 做 15min 卡壳检测 + popup 实时显示
    const elapsed = effectiveElapsedSec();
    LCC.bg("TIMER_TICK", { elapsedSec: elapsed, problemKey: LCC.state.currentProblemKey });
  }

  function effectiveElapsedSec() {
    if (!startedAt) return 0;
    let total = accumulatedActive;
    if (active && lastActiveTick) total += now() - lastActiveTick;
    return Math.floor(total / 1000);
  }

  LCC.timerTracker = {
    start() {
      // 监听 background 指令
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === "TIMER_START") {
          startedAt = now();
          accumulatedActive = 0;
          lastActiveTick = now();
          active = true;
          LCC.state.sessionStartedAt = new Date(startedAt).toISOString();
          if (tickTimer) clearInterval(tickTimer);
          tickTimer = setInterval(tick, 30000);
          LCC.utils.log("info", "timer", "started at", LCC.state.sessionStartedAt);
        } else if (msg.type === "TIMER_STOP") {
          const elapsed = effectiveElapsedSec();
          LCC.bg("TIMER_FINAL", { elapsedSec: elapsed, problemKey: LCC.state.currentProblemKey });
          if (tickTimer) {
            clearInterval(tickTimer);
            tickTimer = null;
          }
          LCC.utils.log("info", "timer", "stopped, effective", elapsed, "s");
        } else if (msg.type === "TIMER_PAUSE") {
          setActive(false);
        } else if (msg.type === "TIMER_RESUME") {
          setActive(true);
        }
      });
      // 页面可见性:切走视为暂停
      document.addEventListener("visibilitychange", () => {
        setActive(!document.hidden);
      });
      window.addEventListener("blur", () => setActive(false));
      window.addEventListener("focus", () => setActive(true));
    },
    effectiveElapsedSec,
  };
})();
