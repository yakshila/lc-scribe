// Uploader 接口 + 注册表(单例)。
//
// 设计:
//  - Uploader 负责把一篇 Note 推送到外部(飞书 / 本地 Markdown / Notion / Obsidian ...)。
//  - coordinator 通过 registry.upload(name, note, opts) 调用,name 对应 settings.uploaders 的 key。
//  - 第三方可 registerUploader(new XxxUploader()) 接入新目标,无需改 coordinator。
//
// 接口约定:
//   uploader.name           唯一名(与 settings.uploaders[name] 对应)
//   uploader.description    描述
//   uploader.needsNetwork   是否需要网络(用于权限提示)
//   async upload(note, opts) -> { success, url?, message? }
//   async test(opts)         -> { success, message? }   供 options 页"测试"

import { logger } from "../utils.js";
import { FeishuUploader } from "./feishu-uploader.js";
import { MarkdownUploader } from "./markdown-uploader.js";

class UploaderRegistry {
  constructor() {
    this._uploaders = [];
    this._initialized = false;
  }

  register(u) {
    if (!u || !u.name) throw new Error("invalid uploader: needs name");
    const i = this._uploaders.findIndex((x) => x.name === u.name);
    if (i >= 0) this._uploaders[i] = u;
    else this._uploaders.push(u);
    logger.info("uploader", `registered uploader: ${u.name}`);
  }

  registerBuiltins() {
    if (this._initialized) return;
    this.register(new FeishuUploader());
    this.register(new MarkdownUploader());
    this._initialized = true;
  }

  list() {
    return this._uploaders.map((u) => ({ name: u.name, description: u.description, needsNetwork: !!u.needsNetwork }));
  }

  getByName(name) {
    return this._uploaders.find((u) => u.name === name) || null;
  }

  async upload(name, note, opts = {}) {
    const u = this.getByName(name);
    if (!u) throw new Error(`uploader not found: ${name}`);
    const cfg = (opts.settings && opts.settings.uploaders && opts.settings.uploaders[name]) || {};
    if (cfg.enabled === false) {
      return { success: false, message: `uploader '${name}' 已禁用` };
    }
    return await u.upload(note, { ...opts, cfg });
  }

  async test(name, opts = {}) {
    const u = this.getByName(name);
    if (!u) throw new Error(`uploader not found: ${name}`);
    const cfg = (opts.settings && opts.settings.uploaders && opts.settings.uploaders[name]) || {};
    return await u.test({ ...opts, cfg });
  }
}

const _registry = new UploaderRegistry();
_registry.registerBuiltins();

export function getUploaderRegistry() {
  return _registry;
}
export { UploaderRegistry };
