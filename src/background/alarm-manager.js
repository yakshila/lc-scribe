// 定时器管理:封装 chrome.alarms
// - 卡壳提醒:每道题进入时设置 15min(可配)alarm,AC 时清除
// - 每日复习检查:每天 reviewCheckHour 点触发
import { logger } from "../utils.js";

export const ALARM_STUCK_PREFIX = "stuck:"; // + problemKey
export const ALARM_DAILY_REVIEW = "daily-review";

/** 为某道题设置"卡壳"提醒 */
export function setStuckAlarm(problemKey, minutes) {
  const name = ALARM_STUCK_PREFIX + problemKey;
  const delayInMin = Math.max(1, Math.floor(minutes));
  chrome.alarms.create(name, { delayInMinutes: delayInMin });
  logger.debug("alarm", `stuck alarm set for ${problemKey} in ${delayInMin} min`);
}

export function clearStuckAlarm(problemKey) {
  chrome.alarms.clear(ALARM_STUCK_PREFIX + problemKey);
}

/** 设置每日复习检查 alarm(每天 reviewCheckHour 点) */
export function ensureDailyReviewAlarm(hour) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  const delayInMin = Math.max(1, Math.floor((next.getTime() - now.getTime()) / 60000));
  // periodInMinutes = 24*60 保证每天重复
  chrome.alarms.create(ALARM_DAILY_REVIEW, { delayInMinutes: delayInMin, periodInMinutes: 24 * 60 });
  logger.debug("alarm", `daily review alarm set, next in ${delayInMin} min`);
}

export function installAlarmListener(onStuck, onDailyReview) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm) return;
    if (alarm.name.startsWith(ALARM_STUCK_PREFIX)) {
      const problemKey = alarm.name.slice(ALARM_STUCK_PREFIX.length);
      onStuck(problemKey);
    } else if (alarm.name === ALARM_DAILY_REVIEW) {
      onDailyReview();
    }
  });
}
