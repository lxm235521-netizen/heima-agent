/**
 * Tests for the inbound OpenAI-compatible surface — the half NewAPI calls.
 *
 * These assertions are deliberately written against the OpenAI wire format rather
 * than our own internals, because the contract that matters is "NewAPI can talk to
 * this like a normal model".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import {
  authorize,
  createTextStreamer,
  detectForcedMode,
  detectResponseFormat,
  formatResult,
  parseChatRequest,
} from "../src/openai-api.mjs";
import { createFieldExtractor, extractField, decodePartialJsonString } from "../src/incremental-json.js";

/* The config directory is redirected by test/setup.mjs (loaded via --import) before
 * any module is evaluated, so the real config.local.json is never touched. */
const { startMockLlm } = await import("./mock-llm.mjs");
const { configureLogin, createConsoleClient } = await import("./helpers.mjs");

const AUTH_KEY = "sk-test-inbound-key";

let mock;
let app;
let consoleApi;
let base;

/* ---------------------------------------------------------- helpers ---- */
function makePng(width, height) {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc32 = (buf) => {
    let crc = -1;
    for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    return (crc ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(height * (1 + width * 3)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const pngDataUrl = (w = 512, h = 288) => `data:image/png;base64,${makePng(w, h).toString("base64")}`;

const authed = (extra = {}) => ({ authorization: `Bearer ${AUTH_KEY}`, ...extra });

async function chat(body, { headers = {}, raw = false } = {}) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { res, text: await res.text() };
}

/* ------------------------------------------------------------- setup --- */
before(async () => {
  mock = await startMockLlm();
  process.env.LLM_BASE_URL = mock.baseUrl;
  process.env.OPENAI_API_KEY = "upstream-key";
  process.env.LLM_MODEL = "mock-vision-model";
  process.env.LLM_PLANNER_MODEL = "mock-planner";

  // The console requires a session; configure it before the first request.
  configureLogin();

  const { startServer } = await import("../src/server.mjs");
  app = await startServer({ port: 0, host: "127.0.0.1" });
  base = app.url;
  consoleApi = createConsoleClient(base);
  assert.ok(base, "test server failed to start");

  // Turn on inbound auth through the same endpoint the UI uses.
  const saved = await consoleApi.fetch(`/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverApiKey: AUTH_KEY, publicModelId: "h3-prompt-writing" }),
  });
  assert.equal(saved.status, 200);
});

after(async () => {
  await new Promise((resolve) => app?.server.close(resolve));
  await new Promise((resolve) => mock?.server.close(resolve));
});

/* -------------------------------------------------------- unit: parsing */
test("detectForcedMode: inline marker in the user text", () => {
  assert.equal(detectForcedMode("用这张图 mode:Ref2VA 改写").mode, "Ref2VA");
  assert.equal(detectForcedMode("--mode I2VA").mode, "I2VA");
  assert.equal(detectForcedMode("模式=FL2VA").mode, "FL2VA");
  assert.equal(detectForcedMode("普通的一段小说").mode, null);
});

test("detectForcedMode: a system-level instruction outranks nothing but is recognised", () => {
  assert.equal(detectForcedMode("Always use Ref2VA for this task.").mode, "Ref2VA");
  assert.equal(detectForcedMode("请用 I2VA").mode, "I2VA");
});

test("detectResponseFormat: json / markdown / plain", () => {
  assert.equal(detectResponseFormat("", "请返回 json 格式"), "json");
  assert.equal(detectResponseFormat("format: json", ""), "json");
  assert.equal(detectResponseFormat("", "用 markdown 格式输出"), "markdown");
  assert.equal(detectResponseFormat("", "把这段小说改写成提示词"), "plain");
});

test("parseChatRequest: collects a system hint, the last user turn and its images", () => {
  const parsed = parseChatRequest({
    messages: [
      { role: "system", content: "Use Ref2VA. 输出 json 格式" },
      { role: "user", content: "第一轮：先随便聊聊" },
      {
        role: "user",
        content: [
          { type: "text", text: "深夜的旧仓库，老陈推开门。" },
          { type: "image_url", image_url: { url: pngDataUrl() } },
        ],
      },
    ],
  });
  assert.equal(parsed.forcedMode, "Ref2VA");
  assert.equal(parsed.forcedBy, "system 指令");
  assert.equal(parsed.requestedFormat, "json");
  assert.equal(parsed.images.length, 1);
  assert.match(parsed.images[0].dataUrl, /^data:image\/png;base64,/);
  // The earlier turn is context, the last turn is the material.
  assert.match(parsed.text, /第一轮/);
  assert.match(parsed.text, /深夜的旧仓库/);
});

test("parseChatRequest: rejects a request with no user message", () => {
  assert.throws(() => parseChatRequest({ messages: [{ role: "system", content: "hi" }] }), /user/);
  assert.throws(() => parseChatRequest({}), /messages/);
});

test("parseChatRequest: accepts the Responses-style input_image shape", () => {
  const parsed = parseChatRequest({
    messages: [{ role: "user", content: [{ type: "input_image", image_url: pngDataUrl() }] }],
  });
  assert.equal(parsed.images.length, 1);
});

/* ------------------------------------------------- unit: auth + stream */
test("authorize: disabled when no key is set, strict when set", () => {
  assert.equal(authorize({ headers: {} }, { serverApiKey: "" }), true);
  assert.equal(authorize({ headers: {} }, { serverApiKey: AUTH_KEY }), false);
  assert.equal(authorize({ headers: { authorization: "Bearer wrong" } }, { serverApiKey: AUTH_KEY }), false);
  assert.equal(authorize({ headers: { authorization: `Bearer ${AUTH_KEY}` } }, { serverApiKey: AUTH_KEY }), true);
  assert.equal(authorize({ headers: { "x-api-key": AUTH_KEY } }, { serverApiKey: AUTH_KEY }), true);
});

test("createTextStreamer: streamed chunks concatenate to exactly formatResult()", () => {
  const result = {
    mode: "I2VA",
    durationSec: 8,
    ratio: "16:9",
    shotCount: 2,
    prompt:
      'integrated_multimodal_description: [Shot 1] 中文与 "quotes"\n第二行\n\noverall_soundscape: 环境音。\n\nnon_diegetic_music: N/A',
    notesZh: "已按官方规范改写。",
    validation: { errors: [], warnings: [] },
  };
  const streamer = createTextStreamer("plain");
  const chunks = [];
  // Feed the model's raw JSON as it would actually stream, one character at a time.
  // `prompt` is deliberately not the first key: the marker must still be located.
  const raw = `{"mode":"I2VA","notes_zh":"x","prompt":${JSON.stringify(result.prompt)}}`;
  for (const ch of raw) chunks.push(...streamer.push({ type: "delta", text: ch }));
  chunks.push(...streamer.finish({ type: "result", result }));

  const joined = chunks.join("");
  assert.equal(joined, formatResult(result, "plain"));
  assert.equal(joined.split(result.prompt).length - 1, 1, "the prompt must appear exactly once");
  // The prompt leads (so a streaming client sees it appear), metadata follows as an
  // HTML comment so it never contaminates the prompt the user copies.
  assert.ok(joined.startsWith("integrated_multimodal_description"), "the prompt must lead the message");
  assert.match(joined, /<!-- H3 Prompt Writing \| mode: I2VA/, "the footer must carry the metadata");
  assert.ok(joined.indexOf("<!-- H3") > joined.indexOf(result.prompt), "metadata must sit after the prompt");
});

test("createTextStreamer: the invariant holds when no deltas arrive at all", () => {
  const result = {
    mode: "T2VA",
    durationSec: 5,
    ratio: "1:1",
    shotCount: 1,
    prompt: "integrated_multimodal_description: [Shot 1] ...",
    notesZh: "",
    validation: { errors: ["某条校验错误"], warnings: [] },
  };
  const streamer = createTextStreamer("plain");
  const chunks = streamer.finish({ type: "result", result });
  const joined = chunks.join("");
  assert.equal(joined, formatResult(result, "plain"));
  assert.match(joined, /校验未通过项/, "validation errors must reach a plain-text caller");
});

test("createTextStreamer: json format emits nothing until the run finishes", () => {
  const result = { mode: "T2VA", durationSec: 8, prompt: "x", validation: { errors: [], warnings: [] } };
  const streamer = createTextStreamer("json");
  assert.deepEqual(streamer.push({ type: "delta", text: '{"prompt":"x"}' }), []);
  const tail = streamer.finish({ type: "result", result });
  assert.equal(tail.length, 1);
  assert.equal(JSON.parse(tail[0]).mode, "T2VA");
});

/* ----------------------------------------- unit: incremental extractor */
test("createFieldExtractor: converges exactly and never retracts", () => {
  const value = "line1\nline2 \"quoted\" 中文\ttab\\slash";
  const raw = `{"other":1,"prompt":${JSON.stringify(value)},"tail":"z"}`;
  const extract = createFieldExtractor("prompt");
  let out = "";
  let prevLength = 0;
  for (let i = 1; i <= raw.length; i += 1) {
    const increment = extract(raw.slice(0, i));
    // The increment is only ever new text: appending must never require a retraction.
    out += increment;
    assert.ok(out.length >= prevLength);
    prevLength = out.length;
  }
  assert.equal(out, value);
});

test("createFieldExtractor: tolerates escapes split across chunk boundaries", () => {
  const raw = `{"prompt":"abc\\u4e2d\\n\\"done\\""}`;
  const extract = createFieldExtractor("prompt");
  let out = "";
  for (let i = 1; i <= raw.length; i += 1) out += extract(raw.slice(0, i));
  assert.equal(out, 'abc中\n"done"');
});

test("extractField / decodePartialJsonString: partial buffers are handled", () => {
  assert.equal(extractField('{"prompt":"abc"}', "prompt"), "abc");
  assert.equal(extractField('{"prompt":"abc', "prompt"), "abc");
  assert.equal(extractField('{"prompt":"abc\\', "prompt"), "abc");
  assert.equal(extractField('{"mode":"T2VA"}', "prompt"), "");
  assert.equal(decodePartialJsonString("plain"), "plain");
  assert.equal(decodePartialJsonString("dangling\\"), null);
});

/* ------------------------------------------------------- route: models  */
test("GET /v1/models requires auth and lists the exposed model", async () => {
  const denied = await fetch(`${base}/v1/models`);
  assert.equal(denied.status, 401);
  const body = await denied.json();
  assert.equal(body.error.code, "invalid_api_key");

  const ok = await fetch(`${base}/v1/models`, { headers: authed() });
  assert.equal(ok.status, 200);
  const list = await ok.json();
  assert.equal(list.object, "list");
  assert.equal(list.data[0].id, "h3-prompt-writing");
  assert.equal(list.data[0].object, "model");
  assert.equal(list.data[0].h3.accepts_images, true);
  assert.deepEqual(list.data[0].h3.modes, ["T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA"]);

  const one = await fetch(`${base}/v1/models/h3-prompt-writing`, { headers: authed() });
  assert.equal(one.status, 200);
  const missing = await fetch(`${base}/v1/models/nope`, { headers: authed() });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "model_not_found");
});

/* --------------------------------------------- route: chat completions */
test("POST /v1/chat/completions (non-streaming) returns an OpenAI envelope", async () => {
  const { res, text } = await chat(
    { model: "h3-prompt-writing", messages: [{ role: "user", content: "深夜的旧仓库。老陈推开门，压低声音：东西还在。" }] },
    { headers: authed() },
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);

  const body = JSON.parse(text);
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "h3-prompt-writing");
  assert.match(body.id, /^chatcmpl-/);
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.ok(body.usage.total_tokens > 0);

  const content = body.choices[0].message.content;
  assert.ok(content.includes("integrated_multimodal_description"), content.slice(0, 200));
  assert.ok(content.includes("<d>[Chinese] 东西还在。</d>"), "dialogue must survive verbatim");
  // The metadata footer must be present but must not be part of the prompt body.
  assert.match(content, /<!-- H3 Prompt Writing \| mode: I2VA/);
  assert.ok(content.startsWith("For the target video"), "the prompt itself must lead the content");
});

test("POST /v1/chat/completions (streaming) is valid SSE and reassembles to the same text", async () => {
  const streamed = await chat(
    {
      model: "h3-prompt-writing",
      stream: true,
      messages: [{ role: "user", content: "深夜的旧仓库。老陈推开门。" }],
    },
    { headers: authed() },
  );
  assert.equal(streamed.res.status, 200);
  assert.match(streamed.res.headers.get("content-type"), /text\/event-stream/);

  const frames = streamed.text
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data:"))
    .map((f) => JSON.parse(f.slice(5).trim()));

  assert.equal(frames[0].choices[0].delta.role, "assistant");
  assert.equal(frames.at(-1).choices[0].finish_reason, "stop");
  assert.ok(frames.every((f) => f.object === "chat.completion.chunk"));
  assert.ok(frames.every((f) => f.id === frames[0].id), "every chunk must share one id");

  const assembled = frames.map((f) => f.choices[0].delta.content ?? "").join("");
  assert.ok(assembled.includes("integrated_multimodal_description"));

  // The streamed text must equal what the non-streaming call would have produced.
  const nonStream = await chat(
    { model: "h3-prompt-writing", messages: [{ role: "user", content: "深夜的旧仓库。老陈推开门。" }] },
    { headers: authed() },
  );
  assert.equal(assembled, JSON.parse(nonStream.text).choices[0].message.content);
});

test("POST /v1/chat/completions honours an inline json format directive", async () => {
  const { text } = await chat(
    { model: "h3-prompt-writing", messages: [{ role: "user", content: "面包店开门。请返回 json 格式。" }] },
    { headers: authed() },
  );
  const parsed = JSON.parse(JSON.parse(text).choices[0].message.content);
  assert.ok(parsed.prompt.includes("integrated_multimodal_description"));
  assert.ok(parsed.validation);
  assert.equal(parsed.mode, "I2VA");
});

test("POST /v1/chat/completions honours a forced mode from the system message", async () => {
  const { text } = await chat(
    {
      model: "h3-prompt-writing",
      messages: [
        { role: "system", content: "You are an image generation helper. Always use Ref2VA." },
        { role: "user", content: "深夜的旧仓库，老陈推开门。" },
      ],
    },
    { headers: authed() },
  );
  const content = JSON.parse(text).choices[0].message.content;
  // The mock answers Ref2VA for ref-family system prompts, and the mode must be reported.
  assert.match(content, /mode: Ref2VA/);
  assert.match(content, /mode_forced_by: system 指令/);
  for (const section of [
    "subject_definitions",
    "summary",
    "retention_analysis",
    "detailed_description",
    "overall_soundscape",
    "non_diegetic_music",
  ]) {
    assert.ok(content.includes(section), `forced Ref2VA output must contain ${section}`);
  }
});

test("POST /v1/chat/completions accepts images in the user message", async () => {
  const { text } = await chat(
    {
      model: "h3-prompt-writing",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "把这张图作为首帧，老陈打开手电。" },
            { type: "image_url", image_url: { url: pngDataUrl(640, 360) } },
          ],
        },
      ],
    },
    { headers: authed() },
  );
  const content = JSON.parse(text).choices[0].message.content;
  assert.ok(content.includes("integrated_multimodal_description"));
  assert.ok(!content.includes("error"), content.slice(0, 200));
});

test("POST /v1/chat/completions rejects an empty request and a bad body", async () => {
  const empty = await chat({ model: "m", messages: [{ role: "user", content: "   " }] }, { headers: authed() });
  assert.equal(empty.res.status, 400);
  assert.match(empty.text, /至少/);

  const noUser = await chat({ model: "m", messages: [{ role: "system", content: "x" }] }, { headers: authed() });
  assert.equal(noUser.res.status, 400);

  const badJson = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: authed({ "content-type": "application/json" }),
    body: "{not json",
  });
  assert.equal(badJson.status, 400);
});

test("POST /v1/chat/completions rejects a wrong bearer token", async () => {
  const { res } = await chat(
    { model: "m", messages: [{ role: "user", content: "hi" }] },
    { headers: { authorization: "Bearer sk-wrong" } },
  );
  assert.equal(res.status, 401);
});

/* ---------------------------------------------------- route: images --- */
test("POST /v1/images/generations returns an OpenAI image envelope carrying the prompt", async () => {
  const res = await fetch(`${base}/v1/images/generations`, {
    method: "POST",
    headers: authed({ "content-type": "application/json" }),
    body: JSON.stringify({ model: "h3-prompt-writing", prompt: "深夜的旧仓库，老陈推开门，压低声音：东西还在。", size: "1024x1024" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data[0].b64_json, "expected a b64_json payload");
  const decoded = Buffer.from(body.data[0].b64_json, "base64").toString("utf8");
  assert.match(decoded, /mode: (Ref2VA|I2VA)/);
  assert.match(decoded, /subject_definitions|integrated_multimodal_description/);
  assert.equal(body.data[0].h3.validation.errors.length, 0);

  const empty = await fetch(`${base}/v1/images/generations`, {
    method: "POST",
    headers: authed({ "content-type": "application/json" }),
    body: JSON.stringify({ prompt: "" }),
  });
  assert.equal(empty.status, 400);
});

/* ------------------------------------------------ route: not found ---- */
test("/v1/unknown returns an OpenAI-shaped 404 rather than an HTML error", async () => {
  const res = await fetch(`${base}/v1/embeddings`, { method: "POST", headers: authed() });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "not_found");
});

test("the health endpoint and the app shell stay reachable without a session", async () => {
  // Container health checks and the login page must work before anyone logs in.
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200, "health checks must not require a session");
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
});
