// Markdown 导出器:把笔记渲染成 .md 文件并触发浏览器下载。
// 不需要网络;依赖 chrome.downloads 权限。
import { noteToMarkdown } from "../storage/schema.js";
import { logger } from "../utils.js";

export class MarkdownUploader {
  constructor() {
    this.name = "markdown";
    this.description = "把笔记导出为本地 Markdown 文件。";
    this.needsNetwork = false;
  }

  async upload(note, opts = {}) {
    if (!note) return { success: false, message: "无笔记" };
    const md = noteToMarkdown(note);
    const m = note.meta || {};
    const filename = sanitize(`LeetCode-${m.problemId || "x"}-${m.titleSlug || "note"}.md`);
    // data URL,UTF-8 安全编码
    const url = "data:text/markdown;charset=utf-8," + encodeURIComponent(md);
    return new Promise((resolve) => {
      chrome.downloads.download({ url, filename, saveAs: !opts.cfg || opts.cfg.autoDownload !== true }, (id) => {
        if (chrome.runtime.lastError) {
          logger.error("markdown", "download error", chrome.runtime.lastError);
          resolve({ success: false, message: chrome.runtime.lastError.message });
        } else {
          resolve({ success: true, message: `已下载 ${filename}`, downloadId: id });
        }
      });
    });
  }

  async test() {
    return { success: true, message: "Markdown 导出无需测试(纯本地下载)。" };
  }
}

function sanitize(s) {
  return String(s).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "-");
}
