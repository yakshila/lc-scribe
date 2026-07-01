// 纯函数 smoke test(无 chrome 依赖)。
// 运行: node tests/smoke.test.mjs
import { parseProblemSlug, formatDuration, extractJSON, truncate } from "../src/utils.js";
import { newNoteSkeleton, deepMerge } from "../src/storage/store.js";
import { noteToMarkdown, validateNote, REVIEW_GRADES } from "../src/storage/schema.js";
import { sm2Init, sm2Next, countDue } from "../src/review/sm2.js";
import { parseNoteGenerationResult, parseCodeAnalysisResult, parseExplanationResult } from "../src/llm/prompts.js";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
function eq(name, a, b) {
  const equal = JSON.stringify(a) === JSON.stringify(b);
  ok(name, equal, equal ? "" : `(got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

console.log("utils:");
ok("parseProblemSlug normal", parseProblemSlug("https://leetcode.cn/problems/two-sum/") === "two-sum");
ok("parseProblemSlug with query", parseProblemSlug("https://leetcode.cn/problems/two-sum/?env=xxx") === "two-sum");
ok("parseProblemSlug none", parseProblemSlug("https://leetcode.cn/problemset/all/") === null);
eq("formatDuration seconds", formatDuration(45), "45秒");
eq("formatDuration minutes", formatDuration(753), "12分33秒");
eq("formatDuration hours", formatDuration(3725), "1时2分5秒");
eq("extractJSON plain", extractJSON('{"a":1}'), { a: 1 });
eq("extractJSON fenced", extractJSON('```json\n{"a":2}\n```'), { a: 2 });
eq("extractJSON with prefix", extractJSON('结果如下:\n{"a":3}\n完'), { a: 3 });
ok("extractJSON invalid", extractJSON("not json") === null);
eq("truncate", truncate("abcdef", 4), "abcd…");

console.log("store / schema:");
const problem = { problemId: 1, titleSlug: "two-sum", title: "两数之和", difficulty: "Easy", tags: ["数组", "哈希表"], url: "https://leetcode.cn/problems/two-sum/", key: "lc:two-sum" };
const note = newNoteSkeleton(problem);
ok("skeleton has id", !!note.id);
ok("skeleton meta", note.meta.problemId === 1 && note.meta.title === "两数之和");
ok("skeleton review empty", note.review.interval === 1 && note.review.repetitions === 0);
const v = validateNote(note);
ok("validate skeleton", v.valid, v.errors.join(";"));
const md = noteToMarkdown(note);
ok("markdown renders", md.includes("# 两数之和") && md.includes("题号: **1**"));
ok("validate bad", !validateNote({}).valid);

console.log("deepMerge:");
const merged = deepMerge({ a: 1, b: { x: 1, y: 2 } }, { b: { y: 20 }, c: 3 });
eq("merge nested", merged, { a: 1, b: { x: 1, y: 20 }, c: 3 });
eq("merge undefined keeps", deepMerge({ a: 1 }, { a: undefined }), { a: 1 });

console.log("SM-2:");
const init = sm2Init();
ok("init interval=1", init.interval === 1);
ok("init ease=2.5", init.ease === 2.5);
ok("init has nextReviewAt", !!init.nextReviewAt);
// grade 5 (easy): repetitions 0->1, interval 1
const after5 = sm2Next(init, 5);
ok("grade5 rep=1", after5.repetitions === 1);
ok("grade5 interval=1", after5.interval === 1);
// grade 5 again: rep 1->2, interval 6
const after5b = sm2Next(after5, 5);
ok("grade5 rep=2", after5b.repetitions === 2);
ok("grade5 interval=6", after5b.interval === 6);
// grade 5 third: interval ~ 6 * ease
const after5c = sm2Next(after5b, 5);
ok("grade5 rep=3", after5c.repetitions === 3);
ok("grade5 interval grows", after5c.interval > 6);
// grade 0 (forgot): reset
const after0 = sm2Next(after5c, 0);
ok("grade0 reset rep=0", after0.repetitions === 0);
ok("grade0 reset interval=1", after0.interval === 1);
// ease never below 1.3
const lowEase = { interval: 1, ease: 1.3, repetitions: 1 };
const afterBad = sm2Next(lowEase, 3);
ok("ease floor", afterBad.ease >= 1.3);
// countDue
const now = Date.now();
const reviews = [
  { nextReviewAt: new Date(now - 86400000).toISOString() }, // 过期
  { nextReviewAt: new Date(now + 86400000).toISOString() }, // 未来
  { nextReviewAt: new Date(now - 1000).toISOString() },     // 刚过期
  { nextReviewAt: null },
];
ok("countDue=2", countDue(reviews) === 2);

console.log("prompts parse:");
const noteGen = parseNoteGenerationResult('{"intuition":"哈希","approach":"遍历","algorithm":"hash","dataStructures":["hash"],"complexity":{"time":"O(n)","space":"O(n)"},"pitfalls":["边界"],"lessonsLearned":[],"patterns":[],"relatedProblems":[],"summary":"一句","alternativeApproaches":["暴力"],"commonMistakes":[],"interviewTips":"讲清"}');
ok("noteGen parsed", noteGen && noteGen.approach.intuition === "哈希" && noteGen.approach.complexity.time === "O(n)");
const codeAn = parseCodeAnalysisResult('{"keyLines":[{"line":3,"note":"建表"}],"comments":["可读性好"]}');
ok("codeAn parsed", codeAn && codeAn.keyLines.length === 1 && codeAn.keyLines[0].line === 3);
ok("codeAn bad returns null", parseCodeAnalysisResult("nope") === null);

console.log("explanation parse:");
const explRaw = '{"plainExplanation":"两数之和","optimalApproach":{"name":"哈希表","idea":"一次遍历","steps":["建表","查补数"],"whyOptimal":"O(n)最优","complexity":{"time":"O(n)","space":"O(n)"}},"analogy":"查字典","keyInsight":"补数","commonPitfalls":["漏判自身"],"codeTemplate":"for x in nums:"}';
const expl = parseExplanationResult(explRaw);
ok("expl parsed", expl && expl.explanation && expl.explanation.plainExplanation === "两数之和");
ok("expl optimalApproach", expl && expl.explanation.optimalApproach.name === "哈希表" && expl.explanation.optimalApproach.steps.length === 2);
ok("expl complexity", expl && expl.explanation.optimalApproach.complexity.time === "O(n)");
ok("expl null on bad", parseExplanationResult("nope") === null);

console.log("noteGen betterApproach parse:");
const noteGenBA = parseNoteGenerationResult('{"intuition":"i","approach":"a","algorithm":"al","dataStructures":[],"complexity":{"time":"O(n^2)","space":"O(1)"},"pitfalls":[],"lessonsLearned":[],"patterns":[],"relatedProblems":[],"summary":"s","alternativeApproaches":[],"betterApproach":{"name":"哈希表","idea":"一次遍历","steps":["建表"],"whyBetter":"O(n^2)变O(n)","analogy":"字典","complexity":{"time":"O(n)","space":"O(n)"},"userComplexity":{"time":"O(n^2)","space":"O(1)"}},"commonMistakes":[],"interviewTips":"t"}');
ok("betterApproach parsed", noteGenBA && noteGenBA.aiGenerated.betterApproach && noteGenBA.aiGenerated.betterApproach.name === "哈希表");
ok("betterApproach whyBetter", noteGenBA && noteGenBA.aiGenerated.betterApproach.whyBetter === "O(n^2)变O(n)");
ok("betterApproach null on absent", noteGen && noteGen.aiGenerated.betterApproach === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
