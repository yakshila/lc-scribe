// 飞书(Feishu)自定义机器人 Webhook 上传器。
// 配置(settings.uploaders.feishu):{ enabled, webhook, botName }
// 上传形式:发送一张 interactive 卡片(标题 + lark_md 正文)。
//
// 注意:飞书 webhook 域名(open.feishu.cn)需在 options 页授权 optional host permission。
// 若机器人开了签名校验,需额外实现 HMAC-SHA256,本示例仅支持无签名 webhook(可在机器人配置关闭)。
import { noteToMarkdown } from "../storage/schema.js";
import { ensureHostPermission } from "../llm/llm-client.js";
import { truncate, logger } from "../utils.js";

const FEISHU_HOST = "https://open.feishu.cn";

export class FeishuUploader {
  constructor() {
    this.name = "feishu";
    this.description = "通过飞书自定义机器人 Webhook 上传笔记卡片。";
    this.needsNetwork = true;
  }

  async upload(note, opts = {}) {
    const cfg = opts.cfg || {};
    if (!cfg.webhook) return { success: false, message: "未配置飞书 webhook 地址" };
    const has = await chrome.permissions.contains({ origins: [`${FEISHU_HOST}/*`] });
    if (!has) {
      return { success: false, message: `未授权访问 ${FEISHU_HOST},请在设置页点击"授权"。` };
    }
    const card = buildCard(note, cfg.botName);
    const body = { msg_type: "interactive", card };
    let resp;
    try {
      resp = await fetch(cfg.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      logger.error("feishu", "fetch failed", e);
      return { success: false, message: `网络错误: ${e.message}` };
    }
    const data = await resp.json().catch(() => ({}));
    if (data.code === 0 || data.StatusCode === 0 || resp.ok) {
      return { success: true, message: "已发送到飞书" };
    }
    return { success: false, message: `飞书返回: code=${data.code} msg=${data.msg || ""}` };
  }

  async test(opts = {}) {
    const cfg = opts.cfg || {};
    if (!cfg.webhook) return { success: false, message: "未配置 webhook" };
    const granted = await ensureHostPermission(FEISHU_HOST).catch(() => false);
    if (!granted) return { success: false, message: "未授权访问飞书域名" };
    const body = {
      msg_type: "text",
      content: { text: `[${cfg.botName || "LC Scribe"}] 连接测试 ✅` },
    };
    try {
      const resp = await fetch(cfg.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (data.code === 0 || resp.ok) return { success: true, message: "测试消息已发送" };
      return { success: false, message: `飞书返回: code=${data.code} msg=${data.msg || ""}` };
    } catch (e) {
      return { success: false, message: `网络错误: ${e.message}` };
    }
  }
}

function buildCard(note, botName) {
  const m = note.meta;
  const md = truncate(noteToMarkdown(note), 2800);
  const headerTemplate = m.difficulty === "Hard" ? "red" : m.difficulty === "Medium" ? "orange" : "green";
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `LeetCode 笔记 · ${m.title || m.titleSlug}` },
      template: headerTemplate,
    },
    elements: [
      {
        tag: "div",
        fields: [
          { is_short: true, text: { tag: "lark_md", content: `**题号**: ${m.problemId}` } },
          { is_short: true, text: { tag: "lark_md", content: `**难度**: ${m.difficulty}` } },
          { is_short: true, text: { tag: "lark_md", content: `**标签**: ${(m.tags || []).join(", ") || "—"}` } },
          { is_short: true, text: { tag: "lark_md", content: `**用时**: ${fmtDur(note.solving && note.solving.durationSec)}` } },
        ],
      },
      { tag: "hr" },
      { tag: "div", text: { tag: "lark_md", content: md } },
      {
        tag: "note",
        elements: [{ tag: "plain_text", content: `由 ${botName || "LC Scribe"} 自动同步` }],
      },
    ],
  };
}

function fmtDur(sec) {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return m > 0 ? `${m}分${r}秒` : `${r}秒`;
}
