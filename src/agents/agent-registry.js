// Agent 接口 + 注册表(单例)。
//
// 设计:
//  - Agent 是一个具备若干"能力(capability)"的独立工作单元。
//  - coordinator 不直接调用某个 agent,而是按 capability 调度:
//      registry.runCapability("note-generation", ctx)
//    这样后续接入第三方 agent 时,只需注册一个声明了相同 capability 的实现即可替换/增强。
//  - ctx 是共享上下文对象 { note, session, problem, settings, failedAttempts }。
//    agent 既可读取 ctx,也可就地修改 ctx.note(把产出写回笔记),实现多 agent 流水线。
//
// 扩展点:第三方可调用 registerAgent(new MyAgent()) 注入自定义 agent。

import { logger } from "../utils.js";
import { NoteAgent } from "./note-agent.js";
import { CodeAnalysisAgent } from "./code-analysis-agent.js";
import { ReviewAgent } from "./review-agent.js";

class AgentRegistry {
  constructor() {
    this._agents = [];
    this._initialized = false;
  }

  register(agent) {
    if (!agent || !agent.name || !Array.isArray(agent.capabilities)) {
      throw new Error("invalid agent: needs name + capabilities");
    }
    // 同名替换
    const i = this._agents.findIndex((a) => a.name === agent.name);
    if (i >= 0) {
      this._agents[i] = agent;
      logger.info("agent", `replaced agent: ${agent.name}`);
    } else {
      this._agents.push(agent);
      logger.info("agent", `registered agent: ${agent.name} (caps: ${agent.capabilities.join(",")})`);
    }
  }

  registerBuiltins() {
    if (this._initialized) return;
    this.register(new NoteAgent());
    this.register(new CodeAnalysisAgent());
    this.register(new ReviewAgent());
    this._initialized = true;
  }

  list() {
    return this._agents.map((a) => ({
      name: a.name,
      description: a.description,
      capabilities: a.capabilities,
    }));
  }

  findByName(name) {
    return this._agents.find((a) => a.name === name) || null;
  }

  findByCapability(capability) {
    return this._agents.find((a) => a.capabilities.includes(capability)) || null;
  }

  async runByName(name, ctx) {
    const a = this.findByName(name);
    if (!a) throw new Error(`agent not found: ${name}`);
    return await a.run(ctx);
  }

  async runCapability(capability, ctx) {
    const a = this.findByCapability(capability);
    if (!a) throw new Error(`no agent for capability: ${capability}`);
    logger.info("agent", `run capability '${capability}' via agent '${a.name}'`);
    return await a.run(ctx);
  }
}

const _registry = new AgentRegistry();
_registry.registerBuiltins();

export function getAgentRegistry() {
  return _registry;
}
export { AgentRegistry };
