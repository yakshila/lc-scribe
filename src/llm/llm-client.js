// OpenAI 兼容 Chat Completions 客户端。
// 适用于:OpenAI / DeepSeek / 智谱 GLM / Kimi / 通义千问(OpenAI 模式)/ 本地 Ollama 等。
// 调用方需先确保已对该 baseURL 的 origin 拿到 optional_host_permissions。
import { logger } from "../utils.js";

/**
 * 发送一次 chat completion。
 * @param {object} llmSettings  { baseURL, apiKey, model, temperature, maxTokens, timeoutMs }
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} [opts]  { responseFormatJSON?: boolean, signal?: AbortSignal }
 * @returns {Promise<string>} assistant 文本
 */
export async function chatComplete(llmSettings, messages, opts = {}) {
  if (!llmSettings || !llmSettings.baseURL || !llmSettings.apiKey) {
    throw new Error("LLM 未配置:缺少 baseURL 或 apiKey");
  }
  const base = llmSettings.baseURL.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const body = {
    model: llmSettings.model || "gpt-4o-mini",
    messages,
    temperature: llmSettings.temperature != null ? llmSettings.temperature : 0.3,
    max_tokens: llmSettings.maxTokens || 1500,
    stream: false,
  };
  if (opts.responseFormatJSON) {
    body.response_format = { type: "json_object" };
  }

  const timeoutMs = llmSettings.timeoutMs || 30000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const signal = opts.signal || ctrl.signal;

  logger.debug("llm", `POST ${url} model=${body.model}`);
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmSettings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`LLM 请求超时(${timeoutMs}ms)`);
    throw new Error(`LLM 请求失败: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`LLM HTTP ${resp.status}: ${txt.slice(0, 300)}`);
  }
  const data = await resp.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error("LLM 返回为空");
  return content.trim();
}

/** 简单的连通性测试,供 options 页"测试连接"使用 */
export async function testConnection(llmSettings) {
  const reply = await chatComplete(llmSettings, [
    { role: "system", content: "你是连通性测试助手,只回复 ok。" },
    { role: "user", content: "ping" },
  ], {});
  return /ok/i.test(reply);
}

/** 请求可选 host 权限(需在用户手势中调用,如 options 页按钮) */
export async function ensureHostPermission(baseURL) {
  if (!baseURL) return false;
  let origin;
  try {
    origin = new URL(baseURL).origin + "/*";
  } catch {
    return false;
  }
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  return await chrome.permissions.request({ origins: [origin] });
}
