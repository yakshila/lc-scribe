// SM-2 间隔重复算法(SuperMemo 2)
// 输入当前复习状态 + 评分(0-5),返回新的复习状态。
// grade: 0-2 视为"未掌握",重置 repetitions;3-5 视为"掌握",推进间隔。
// 参考: https://www.supermemo.com/en/blog/application-of-a-computer-to-improve-the-results-obtained-in-working-with-the-supermemo-method

import { nowISO } from "../utils.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} state  { interval, ease, repetitions, lastReviewedAt }
 * @param {0|1|2|3|4|5} grade
 * @returns {object} 新的复习状态(含 nextReviewAt ISO)
 */
export function sm2Next(state = {}, grade) {
  let { interval = 1, ease = 2.5, repetitions = 0 } = state;
  const g = Number(grade);
  if (Number.isNaN(g) || g < 0 || g > 5) {
    throw new Error(`sm2: grade must be 0-5, got ${grade}`);
  }

  if (g < 3) {
    // 未掌握:重新开始
    repetitions = 0;
    interval = 1;
  } else {
    // 掌握:推进
    repetitions += 1;
    if (repetitions === 1) interval = 1;
    else if (repetitions === 2) interval = 6;
    else interval = Math.round((interval * ease) * 10) / 10;
  }

  // ease 调整:仅掌握时调整;下限 1.3
  if (g >= 3) {
    ease = ease + (0.1 - (5 - g) * (0.08 + (5 - g) * 0.02));
  } else {
    // 不掌握时不改动 ease(SM-2 原版仅在 q>=3 时更新 EF)
  }
  if (ease < 1.3) ease = 1.3;
  ease = Math.round(ease * 100) / 100;

  const now = Date.now();
  const next = new Date(now + interval * DAY_MS);
  return {
    algorithm: "SM-2",
    interval,
    ease,
    repetitions,
    lastReviewedAt: nowISO(),
    nextReviewAt: next.toISOString(),
    reviewHistory: [...(state.reviewHistory || []), { date: nowISO(), grade: g, interval }],
  };
}

/** 初始化一条笔记的复习状态:学完当天,1 天后复习 */
export function sm2Init() {
  const now = Date.now();
  return {
    algorithm: "SM-2",
    interval: 1,
    ease: 2.5,
    repetitions: 0,
    lastReviewedAt: nowISO(),
    nextReviewAt: new Date(now + 1 * DAY_MS).toISOString(),
    reviewHistory: [],
  };
}

/** 给定复习状态列表,返回今天到期(含过期)的数量 */
export function countDue(reviews, now = Date.now()) {
  return reviews.filter((r) => r.nextReviewAt && new Date(r.nextReviewAt).getTime() <= now).length;
}
