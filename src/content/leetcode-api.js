// LeetCode (leetcode.cn) GraphQL 客户端 —— 在 content script 中运行,自带 cookie。
(function () {
  const LCC = window.LCC;
  if (!LCC) return;

  const GRAPHQL_URL = "https://leetcode.cn/graphql/";

  async function graphql(query, variables) {
    const resp = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ query, variables, operationName: null }),
      credentials: "include",
      // content script 自带 leetcode.cn 的 cookie;referer/origin 由浏览器自动带上(同源)
    });
    if (!resp.ok) throw new Error(`leetcode graphql ${resp.status}`);
    const json = await resp.json();
    if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
    return json.data;
  }

  const QUESTION_QUERY = `
    query questionData($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionId
        questionFrontendId
        title
        titleSlug
        translatedTitle
        content
        difficulty
        isPaidOnly
        topicTags { name translatedName slug }
        hints { content }
        sampleTestCase
      }
    }`;

  /** 根据 slug 拉取题目元数据,返回归一化后的 ProblemMeta */
  LCC.leetcodeApi = {
    async fetchQuestion(titleSlug) {
      const data = await graphql(QUESTION_QUERY, { titleSlug });
      const q = data && data.question;
      if (!q) return null;
      return {
        problemId: Number(q.questionFrontendId || q.questionId),
        titleSlug: q.titleSlug,
        title: q.translatedTitle || q.title,
        difficulty: q.difficulty,
        tags: (q.topicTags || []).map((t) => t.translatedName || t.name),
        isPaid: !!q.isPaidOnly,
        url: `https://leetcode.cn/problems/${q.titleSlug}/`,
        related: [],
        fetchedAt: new Date().toISOString(),
        key: `lc:${q.titleSlug}`,
      };
    },

    /** 从页面 window 全局对象里读题目(leetcode.cn 会把题目数据挂在 window 上),作为快速路径 */
    readFromPageGlobal(titleSlug) {
      try {
        // leetcode.cn 题目页 SPA 会把数据塞到 __NEXT_DATA__ 或 window 题目 store
        const w = window;
        const nd = w.__NEXT_DATA__;
        if (nd && nd.props && nd.props.pageProps) {
          const q = nd.props.pageProps.question;
          if (q && q.titleSlug === titleSlug) {
            return {
              problemId: Number(q.questionFrontendId || q.questionId),
              titleSlug: q.titleSlug,
              title: q.translatedTitle || q.title,
              difficulty: q.difficulty,
              tags: (q.topicTags || []).map((t) => t.translatedName || t.name),
              isPaid: !!q.isPaidOnly,
              url: `https://leetcode.cn/problems/${q.titleSlug}/`,
              related: [],
              fetchedAt: new Date().toISOString(),
              key: `lc:${q.titleSlug}`,
            };
          }
        }
      } catch (e) {
        LCC.utils.log("warn", "lc-api", "readFromPageGlobal failed", e);
      }
      return null;
    },

    graphql,
  };
})();
