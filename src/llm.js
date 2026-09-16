/**
 * A minimal OpenAI-compatible chat client.
 *
 * Deliberately dependency-free and protocol-thin: every provider we target
 * (MiniMax, DashScope compatible-mode, GLM, Moonshot, SiliconFlow, OpenAI,
 * vLLM, Ollama, One-API) accepts POST {baseUrl}/chat/completions with the
 * same body shape. Only streaming vs. non-streaming and vision content blocks
 * matter here.
 */

export class LLMError extends Error {
  constructor(message, { status = 0, body = "" } = {}) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.body = body;
  }
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl).replace(/\/+$/, "")}${suffix}`;
}

/** OpenAI-style multimodal content: a text block plus one image block per image. */
export function buildUserContent({ text, images = [] }) {
  if (!images.length) return text ?? "";
  const content = [];
  if (text && String(text).trim()) content.push({ type: "text", text: String(text) });
  for (const img of images) {
    content.push({ type: "image_url", image_url: { url: img.dataUrl } });
  }
  return content;
}

function extractMessageText(payload) {
  const choice = payload?.choices?.[0];
  const msg = choice?.message;
  const content = msg?.content;
  if (typeof content === "string" && content.trim()) return content;
  // Some providers return an array of parts even in non-streaming mode.
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("")
      .trim();
    if (joined) return joined;
  }
  // Last resort: some reasoning models only fill reasoning_content.
  if (typeof msg?.reasoning_content === "string" && msg.reasoning_content.trim()) {
    return msg.reasoning_content;
  }
  const finish = choice?.finish_reason ? ` (finish_reason=${choice.finish_reason})` : "";
  throw new LLMError(`模型返回了空内容${finish}，请检查模型名是否为多模态模型。`);
}

function errorFromResponse(status, text) {
  let detail = text;
  try {
    const j = JSON.parse(text);
    detail = j?.error?.message || j?.message || j?.base_resp?.status_msg || text;
  } catch {
    /* keep raw */
  }
  let hint = "";
  if (status === 401) hint = "（API Key 无效或未配置）";
  else if (status === 403) hint = "（无权限，可能未开通该模型）";
  else if (status === 404) hint = "（模型名或 baseUrl 路径不对）";
  else if (status === 429) hint = "（限流或余额不足）";
  return new LLMError(`上游返回 HTTP ${status}${hint}: ${String(detail).slice(0, 500)}`, {
    status,
    body: text,
  });
}

function requestInit(config, body, extraHeaders = {}) {
  if (!config.apiKey) {
    throw new LLMError("未配置 API Key。请在页面右上角「模型设置」里填写，或设置相应的环境变量。");
  }
  if (!config.baseUrl) {
    throw new LLMError("未配置 baseUrl。请在「模型设置」里填写 OpenAI 兼容服务的地址。");
  }
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

/**
 * Split an SSE buffer into complete `data:` payloads, returning the unconsumed tail.
 *
 * Kept public because some relays ignore `stream: false` and answer a non-streaming
 * request with an SSE body. Feeding that to JSON.parse is exactly what makes a
 * planning call fail against such a provider.
 *
 * @returns {{ payloads: string[], rest: string }}
 */
export function parseSseBuffer(buffer, { flush = false } = {}) {
  const frames = buffer.split(/\r?\n\r?\n/);
  const rest = flush ? "" : frames.pop() ?? "";
  const payloads = [];

  for (const frame of frames) {
    for (const line of frame.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      payloads.push(data);
    }
  }
  return { payloads, rest };
}

/** Collapse a set of OpenAI streaming chunks into one non-streaming-style payload. */
function assembleStreamedChunks(payloads) {
  let content = "";
  let reasoning = "";
  let id = "";
  let model = "";
  let usage = null;
  let finishReason = null;
  let sawChoice = false;

  for (const data of payloads) {
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      continue;
    }
    if (evt?.error) throw errorFromResponse(200, JSON.stringify(evt.error));
    if (typeof evt?.id === "string" && evt.id) id ||= evt.id;
    if (typeof evt?.model === "string" && evt.model) model ||= evt.model;
    if (evt?.usage) usage = evt.usage;

    const choice = evt?.choices?.[0];
    if (!choice) continue;
    sawChoice = true;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? choice.message;
    if (typeof delta?.content === "string") content += delta.content;
    if (typeof delta?.reasoning_content === "string") reasoning += delta.reasoning_content;
  }

  if (!sawChoice && !content) throw new LLMError("上游返回的流式响应里没有任何 choices。");
  return {
    payload: {
      id,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: content || reasoning }, finish_reason: finishReason },
      ],
      usage,
    },
  };
}

/**
 * Non-streaming completion. Returns { text, usage, model }.
 *
 * Robustness decision: this requests a STREAM from the provider and assembles it,
 * rather than asking for `stream: false`.
 *
 * Why: relays are inconsistent about non-streaming. One observed production relay
 * answers a `stream: false` request for a given model with a single usage-only SSE
 * chunk (`choices: []`, `completion_tokens: 0`) and no content at all, while the
 * streaming path works perfectly. Asking for a stream and reassembling works on both
 * kinds of provider and leaves exactly one upstream code path to maintain.
 *
 * A body that comes back as plain JSON is still accepted, so nothing is lost.
 */
export async function chatComplete(config, { messages, model = config.model, maxTokens, signal }) {
  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await fetch(joinUrl(config.baseUrl, "/chat/completions"), {
    ...requestInit(config, body),
    signal: signal ?? AbortSignal.timeout(config.requestTimeoutMs ?? 180000),
  });

  const text = await res.text();
  if (!res.ok) throw errorFromResponse(res.status, text);

  const contentType = String(res.headers.get("content-type") ?? "");
  const looksLikeSse = /event-stream/i.test(contentType) || text.trimStart().startsWith("data:");

  let payload;
  if (looksLikeSse) {
    const { payloads } = parseSseBuffer(text.endsWith("\n\n") ? text : `${text}\n\n`, { flush: true });
    if (!payloads.length) throw new LLMError(`上游返回了 SSE 但没有可用数据：${text.slice(0, 300)}`);
    ({ payload } = assembleStreamedChunks(payloads));
  } else {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new LLMError(`上游返回的不是 JSON: ${text.slice(0, 300)}`);
    }
  }

  if (payload?.error) throw errorFromResponse(res.status, JSON.stringify(payload.error));
  return {
    text: extractMessageText(payload),
    usage: payload?.usage ?? null,
    model: payload?.model ?? model,
  };
}

/**
 * Streaming completion. Async-generator yielding { delta } chunks,
 * ending with { usage } when the provider reports it.
 */
export async function* chatStream(config, { messages, model = config.model, maxTokens, signal }) {
  const body = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (maxTokens) body.max_tokens = maxTokens;

  const res = await fetch(joinUrl(config.baseUrl, "/chat/completions"), {
    ...requestInit(config, body),
    signal: signal ?? AbortSignal.timeout(config.requestTimeoutMs ?? 180000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw errorFromResponse(res.status, text);
  }
  if (!res.body) throw new LLMError("上游没有返回流式响应体。");

  const decoder = new TextDecoder();
  let buffer = "";
  let sawContent = false;

  /** Consume one batch of complete SSE frames. */
  function* consume(payloads) {
    for (const data of payloads) {
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (evt?.error) throw errorFromResponse(200, JSON.stringify(evt.error));
      const choice = evt?.choices?.[0];
      const delta = choice?.delta?.content ?? choice?.message?.content;
      if (typeof delta === "string" && delta) {
        sawContent = true;
        yield { delta };
      }
      if (evt?.usage) yield { usage: evt.usage };
    }
  }

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const { payloads, rest } = parseSseBuffer(buffer);
    buffer = rest;
    yield* consume(payloads);
  }

  // Flush a trailing frame that arrived without its blank-line terminator, which a
  // few relays do on the final chunk.
  const { payloads: tail } = parseSseBuffer(buffer, { flush: true });
  yield* consume(tail);

  if (!sawContent) {
    throw new LLMError(
      "流式响应中没有收到任何文本。常见原因：模型名不是多模态模型、baseUrl 不兼容流式，或内容被上游安全策略拦截。",
    );
  }
}
