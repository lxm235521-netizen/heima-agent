/**
 * OpenAI-compatible adapter: turns this agent into a channel that NewAPI (or any
 * OpenAI-compatible gateway / SDK / chat client) can call as if it were a model.
 *
 *   POST /v1/chat/completions
 *   POST /v1/images/generations
 *   GET  /v1/models
 *
 * Why /v1/images/generations also exists: NewAPI has a dedicated image channel type
 * and a "文生图" relay path. Presenting the same engine through both surfaces means
 * the H3 prompt can be consumed as a chat model *or* plugged into an existing
 * text-to-image node without re-plumbing the downstream workflow.
 */
import crypto from "node:crypto";
import { createFieldExtractor } from "./incremental-json.js";
import { MODES, DURATION_MAX } from "./prompts.js";

/* --------------------------------------------------------------- auth --- */

/** Constant-time bearer check. Returns true when inbound auth is disabled. */
export function authorize(req, config) {
  const expected = String(config.serverApiKey ?? "");
  if (!expected) return true;
  const header = String(req.headers.authorization ?? "");
  const token = header.replace(/^Bearer\s+/i, "").trim() || String(req.headers["x-api-key"] ?? "").trim();
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function openAiError(res, status, message, { type = "invalid_request_error", code = null } = {}) {
  const body = JSON.stringify({ error: { message, type, code, param: null } });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

export function corsPreflight(res) {
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, x-api-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
  });
  res.end();
}

/* ------------------------------------------------------ request parsing - */

/**
 * Flatten one OpenAI message's `content` into text plus images.
 * Handles the plain-string form and the multimodal parts array, accepting both the
 * OpenAI `image_url` shape and the Responses-style `input_image` shape.
 */
function flattenContent(content) {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };

  const texts = [];
  const images = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      if (typeof part === "string") texts.push(part);
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    } else if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) images.push({ dataUrl: url, name: `image-${images.length + 1}` });
    } else if (part.type === "input_image" && part.image_url) {
      images.push({ dataUrl: part.image_url, name: `image-${images.length + 1}` });
    } else if (typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return { text: texts.join("\n"), images };
}

/**
 * Recognise caller directives that should outrank automatic mode selection.
 * Two forms are supported so it works from both a chat box and an API call:
 *   - an explicit system instruction: "Use Ref2VA"
 *   - an inline marker anywhere in the text: mode:Ref2VA, 模式=Ref2VA, --mode Ref2VA
 * @returns {{ mode: string|null, by: string }}
 */
export function detectForcedMode(text) {
  const source = String(text ?? "");
  const modes = MODES.join("|");
  // A mode id may be followed by a non-word character or by CJK; a trailing Latin
  // letter or digit means it is part of a longer word (e.g. "Ref2VAx"), so reject it.
  const end = `(?![A-Za-z0-9])`;

  // Explicit system-level instruction (checked first: it is the stronger signal).
  // The Chinese verb "用" is a literal alternative rather than relying on \b, which
  // does not hold between two CJK characters ("请用 I2VA").
  const instruction = new RegExp(`(?:\\b(?:use|respond\\s+with|answer\\s+using)|用)\\s*(${modes})${end}`, "i");
  const hit = instruction.exec(source);
  if (hit) {
    const mode = MODES.find((m) => m.toLowerCase() === hit[1].toLowerCase());
    if (mode) return { mode, by: "system 指令" };
  }

  // Inline marker: accepts "mode:Ref2VA", "模式=FL2VA" and "--mode I2VA".
  const marker = new RegExp(`(?:--mode|mode|模式)\\s*(?:[:=：]|\\s)\\s*(${modes})${end}`, "i");
  const markerHit = marker.exec(source);
  if (markerHit) {
    const mode = MODES.find((m) => m.toLowerCase() === markerHit[1].toLowerCase());
    if (mode) return { mode, by: "文本标记" };
  }
  return { mode: null, by: "" };
}

/**
 * Parse an OpenAI chat completion request into H3 pipeline input.
 *
 * Only the LAST user message is treated as the material to rewrite; earlier user
 * turns are passed along as conversation context. That matches how the H3 skill is
 * meant to be used (rewrite this request) rather than treating the whole history as
 * one giant prompt.
 */
export function parseChatRequest(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) throw new Error("messages 不能为空。");

  const systemTexts = [];
  const userTurns = [];
  const images = [];

  for (const message of messages) {
    const { text, images: msgImages } = flattenContent(message?.content);
    if (message?.role === "system" || message?.role === "developer") systemTexts.push(text);
    else if (message?.role === "user") userTurns.push({ text, images: msgImages });
  }

  if (!userTurns.length) throw new Error("messages 中至少需要一条 user 消息。");

  const last = userTurns.at(-1);
  images.push(...last.images);

  const earlier = userTurns.slice(0, -1).filter((t) => t.text.trim());
  const context =
    earlier.length > 0
      ? `## 之前的对话（仅作上下文，不是本次要改写的素材）\n\n${earlier.map((t) => t.text.trim()).join("\n\n---\n\n")}\n`
      : "";

  const systemHint = systemTexts.join("\n\n").trim();
  const material = [context, last.text].filter(Boolean).join("\n");

  // An explicit instruction may live in the system message or in the user's text.
  const forced = detectForcedMode(systemHint) ?? { mode: null, by: "" };
  const forcedFinal = forced.mode ? forced : detectForcedMode(last.text);

  return {
    text: material,
    images,
    systemHint,
    forcedMode: forcedFinal?.mode ?? null,
    forcedBy: forcedFinal?.by ?? "",
    requestedFormat: detectResponseFormat(systemHint, last.text),
  };
}

/** Response shape requested by the caller: "plain" (default), "json" or "markdown". */
export function detectResponseFormat(systemHint, userText) {
  for (const source of [systemHint, userText]) {
    const text = String(source ?? "");
    if (/(?:format|form|输出|返回|响应)\s*[:=：]?\s*json\b/i.test(text) || /json\s*(?:格式|格式输出)/i.test(text)) {
      return "json";
    }
    if (/markdown|\bmd\b/i.test(text) && /(?:format|格式|输出|返回)/i.test(text)) return "markdown";
  }
  return "plain";
}

/* ----------------------------------------------------------- formatting - */

function metaLines(result) {
  const lines = [`mode: ${result.mode}`, `duration: ${result.durationSec}s`];
  if (result.ratio) lines.push(`ratio: ${result.ratio}`);
  if (result.shotCount) lines.push(`shots: ${result.shotCount}`);
  if (result.forcedMode) lines.push(`mode_forced_by: ${result.forcedBy || "caller"}`);
  if (result.validation?.errors?.length) lines.push(`validation_errors: ${result.validation.errors.length}`);
  if (result.validation?.warnings?.length) lines.push(`validation_warnings: ${result.validation.warnings.length}`);
  return lines;
}

/** The Chinese advisory line, when the model produced one. */
function notesLine(result) {
  return result.notesZh ? `说明：${result.notesZh}` : "";
}

/** The metadata footer. HTML comments keep it out of the prompt the user copies. */
function headPlain(result) {
  const parts = [`<!-- H3 Prompt Writing | ${metaLines(result).join(" | ")} -->`];
  if (notesLine(result)) parts.push(`说明：${notesLine(result)}`);
  return parts.join("\n");
}

/** The validation footer, when the run finished with unresolved errors. */
function tailPlain(result) {
  const errors = result.validation?.errors ?? [];
  if (!errors.length) return "";
  return ["", "<!-- 校验未通过项：", ...errors.map((e) => `  - ${e}`), "-->"].join("\n");
}

/**
 * Render the plain-text body: the prompt itself, followed by a metadata footer.
 *
 * The metadata deliberately goes AFTER the prompt rather than before it. That makes
 * the canonical order identical to the streaming order (body, then the things only
 * known once the run ends), so the streaming and non-streaming paths can produce
 * byte-identical text without buffering the prompt.
 */
export function formatPlainBody(result, { preambles = true } = {}) {
  const meta = preambles ? headPlain(result) : "";
  let out = result.prompt;
  if (meta) out += `\n\n${meta}`;
  out += tailPlain(result);
  return out;
}

/** Render the JSON body, matching the shape the web UI already consumes. */
export function formatJsonBody(result) {
  return JSON.stringify(
    {
      mode: result.mode,
      duration_sec: result.durationSec,
      ratio: result.ratio || null,
      shot_count: result.shotCount,
      prompt: result.prompt,
      notes_zh: result.notesZh || "",
      speak_map: result.speakMap ?? [],
      forced_mode: result.forcedMode ?? null,
      validation: result.validation,
    },
    null,
    2,
  );
}

/**
 * Canonical rendering, split into the pieces the streaming path needs.
 *
 * For plain text: `head` is empty, `body` is the prompt, `tail` is the metadata and
 * validation footer. Keeping the metadata in the tail is what lets the streaming and
 * non-streaming paths agree byte for byte — see createTextStreamer.
 *
 * @returns {{head: string, body: string, tail: string, full: string}}
 */
export function renderParts(result, format = "plain") {
  if (format === "json") {
    const full = formatJsonBody(result);
    return { head: "", body: full, tail: "", full };
  }
  if (format === "markdown") {
    const full = [
      `## H3 提示词（${result.mode}）`,
      "",
      "```text",
      result.prompt,
      "```",
      "",
      `> ${metaLines(result).join(" · ")}`,
    ].join("\n");
    return { head: "", body: full, tail: "", full };
  }
  const head = "";
  const body = result.prompt;
  const meta = headPlain(result);
  const tail = (meta ? `\n\n${meta}` : "") + tailPlain(result);
  return { head, body, tail, full: head + body + tail };
}

/** The canonical rendering for a non-streaming reply. */
export function formatResult(result, format = "plain") {
  return renderParts(result, format).full;
}

/**
 * Bridges the pipeline's event stream to the text the caller receives.
 *
 * Invariant (asserted by tests): concatenating every chunk returned by push() and
 * finish() yields exactly formatResult(result, format) — streaming and non-streaming
 * callers see byte-identical text.
 *
 * How plain mode satisfies that while still streaming: the metadata is not known
 * until the run ends, so push() emits a short opening marker before the prompt and
 * finish() sends `head.slice(marker.length)`. The metadata therefore leads the
 * message, and the prompt still streams live.
 *
 * For "json" / "markdown" nothing is emitted until the run finishes, because a
 * half-written JSON document is useless to a caller.
 */
export function createTextStreamer(format) {
  const extract = createFieldExtractor("prompt");
  let raw = "";
  // Characters of the canonical body already handed to the caller.
  let streamedBody = 0;
  let result = null;

  return {
    /**
     * Feed one pipeline event.
     * @param {{type:string,[k:string]:any}} event
     * @returns {string[]} text chunks to forward to the caller, in order
     */
    push(event) {
      if (format !== "plain" || event.type !== "delta") return [];
      raw += event.text;
      const increment = extract(raw);
      if (!increment) return [];
      streamedBody += increment.length;
      return [increment];
    },

    /**
     * Terminal event. Sends whatever body remains plus the footer, which together
     * complete the canonical rendering.
     */
    finish(resultEvent) {
      result = resultEvent.result;
      const { head, body, tail, full } = renderParts(result, format);

      if (format !== "plain") {
        // Nothing was streamed: hand over the whole canonical rendering.
        return full ? [full] : [];
      }

      const chunks = [];
      if (head) chunks.push(head);

      // Clamp: if the model's streamed text drifted from its own final JSON, the
      // authoritative body is used for whatever was never delivered.
      const bodyDone = Math.max(0, Math.min(streamedBody, body.length));
      const bodyRemainder = body.slice(bodyDone);
      if (bodyRemainder) chunks.push(bodyRemainder);
      if (tail) chunks.push(tail);

      if (process.env.H3_DEBUG_STREAMER) {
        console.error("[streamer]", JSON.stringify({ ok: chunks.join("") === full, bodyDone, bodyLen: body.length }));
      }
      return chunks;
    },

    get result() {
      return result;
    },
  };
}

/** Shape of a non-streaming /v1/chat/completions response. */
export function chatCompletionResponse({ id, model, text, usage, created = Math.floor(Date.now() / 1000) }) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: usage
      ? {
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        }
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function newCompletionId(prefix = "chatcmpl") {
  return `${prefix}-${crypto.randomBytes(12).toString("hex")}`;
}

/** The single model id this server exposes, plus conservative metadata. */
export function modelList(config) {
  const id = config.publicModelId || "h3-prompt-writing";
  return {
    object: "list",
    data: [
      {
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "heima-agent",
        // Extensions are ignored by NewAPI; they document the contract for humans.
        h3: {
          description: "把小说/分镜片段+图片改写为 MiniMax H3 分镜提示词",
          modes: MODES,
          max_duration_sec: DURATION_MAX,
          accepts_images: true,
          upstream_model: config.model,
        },
      },
    ],
  };
}

export const __testing = { flattenContent, metaLines };
