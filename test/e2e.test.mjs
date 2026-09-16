/**
 * End-to-end: real HTTP server + real pipeline + a mock OpenAI-compatible model.
 *
 * No API key needed. This is the test that proves the whole chain works:
 * request -> plan -> generate -> extract -> validate -> streamed result event.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import { startMockLlm } from "./mock-llm.mjs";
import { configureLogin, createConsoleClient } from "./helpers.mjs";

let mock;
let app;
let consoleApi;
let base;

/* A tiny real PNG so the vision payload is genuinely an image. */
function makePng(width, height) {
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc32 = (buf) => {
    let crc = -1;
    for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
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
  const raw = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sampleImage = () => ({
  name: "frame.png",
  dataUrl: `data:image/png;base64,${makePng(512, 288).toString("base64")}`,
});

/** Read the NDJSON event stream into an array. */
async function generate(payload) {
  const res = await consoleApi.fetch(`/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /ndjson/);
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

before(async () => {
  mock = await startMockLlm();
  // loadConfig() reads the environment on every request, so setting it here is enough.
  process.env.LLM_BASE_URL = mock.baseUrl;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.LLM_MODEL = "mock-vision-model";
  process.env.LLM_PLANNER_MODEL = "mock-planner";

  // The console requires a session; configure it before the first request.
  configureLogin();

  const { startServer } = await import("../src/server.mjs");
  app = await startServer({ port: 0, host: "127.0.0.1" });
  base = app.url;
  consoleApi = createConsoleClient(base);
  // Fail fast: without this, a broken import in before() leaves every test hanging
  // on a connection to a server that never started.
  assert.ok(base, "test server failed to start");
});

after(async () => {
  await new Promise((resolve) => app?.server.close(resolve));
  await new Promise((resolve) => mock?.server.close(resolve));
});

test("e2e: text-only request produces a validated T2VA/I2VA prompt", async () => {
  delete process.env.MOCK_BEHAVIOUR;
  const events = await generate({ text: "深夜的旧仓库。老陈推开门，压低声音：东西还在。", durationSec: 8, ratio: "16:9" });

  const types = events.map((e) => e.type);
  assert.ok(types.includes("stage"), "expected stage events");
  assert.ok(types.includes("plan"), "expected a plan event");
  assert.ok(types.includes("delta"), "expected streamed deltas");
  assert.ok(types.includes("result"), `expected a result, got: ${JSON.stringify(events.at(-1))}`);
  assert.ok(!types.includes("error"), `no error expected: ${JSON.stringify(events.filter((e) => e.type === "error"))}`);

  const result = events.find((e) => e.type === "result");
  assert.equal(result.result.mode, "I2VA");
  assert.equal(result.result.durationSec, 8);
  assert.equal(result.result.ratio, "16:9");
  assert.ok(result.result.prompt.includes("integrated_multimodal_description"));
  assert.ok(result.result.prompt.includes("overall_soundscape"));
  assert.ok(result.result.prompt.includes("non_diegetic_music"));
  assert.ok(result.result.prompt.includes("<d>[Chinese] 东西还在。</d>"), "dialogue must be preserved verbatim");
  assert.ok(/^\s*For the target video, at 0\.00 seconds/.test(result.result.prompt), "I2VA alignment line must lead");
  assert.deepEqual(result.result.validation.errors, []);
  assert.equal(result.usage.total_tokens > 0, true);
  assert.equal(result.elapsedMs >= 0, true);

  // The plan event must carry the model's own classification, not a regex guess.
  const plan = events.find((e) => e.type === "plan");
  assert.equal(plan.plan.mode, "I2VA");
  assert.equal(plan.plan.dialogue[0].verbatim, "东西还在。");
});

test("e2e: an image request is accepted and reaches the model", async () => {
  delete process.env.MOCK_BEHAVIOUR;
  const events = await generate({ text: "老陈打开手电。", images: [sampleImage()], durationSec: 8 });
  const intake = events.find((e) => e.type === "intake");
  assert.equal(intake.images.length, 1);
  assert.equal(intake.images[0].width, 512);
  assert.equal(intake.images[0].height, 288);
  const result = events.find((e) => e.type === "result");
  assert.ok(result, "expected a result event");
  assert.deepEqual(result.result.validation.errors, []);
});

test("e2e: a fenced JSON reply is extracted from surrounding prose without a repair pass", async () => {
  process.env.MOCK_BEHAVIOUR = "fenced";
  const events = await generate({ text: "面包店开门。", durationSec: 8 });
  delete process.env.MOCK_BEHAVIOUR;
  const result = events.find((e) => e.type === "result");
  assert.ok(result, "expected a result despite the prose and fence");
  assert.ok(["fence-stripped", "balanced-scan"].includes(result.result.extraction));
  assert.equal(result.result.repairs, 0);
  assert.equal(result.result.mode, "T2VA");
  assert.ok(result.result.prompt.includes("integrated_multimodal_description"));
});

test("e2e: unparseable output triggers a repair pass and then succeeds", async () => {
  process.env.MOCK_BEHAVIOUR = "badjson";
  const events = await generate({ text: "面包店开门。", durationSec: 8 });
  delete process.env.MOCK_BEHAVIOUR;
  const stages = events.filter((e) => e.type === "stage").map((e) => e.stage);
  assert.ok(stages.includes("repair"), `expected a repair stage, got ${stages.join(",")}`);
  const result = events.find((e) => e.type === "result");
  assert.ok(result, "the repair pass should rescue the run");
  assert.equal(result.result.repairs, 1);
});

test("e2e: an upstream 401 surfaces as an error event, not a silent fake prompt", async () => {
  process.env.MOCK_BEHAVIOUR = "http401";
  const events = await generate({ text: "面包店开门。", durationSec: 8 });
  delete process.env.MOCK_BEHAVIOUR;
  const error = events.find((e) => e.type === "error");
  assert.ok(error, "expected an error event");
  assert.match(error.message, /401|Key|规划/);
  assert.equal(events.some((e) => e.type === "result"), false);
});

test("e2e: empty input is rejected before any model call", async () => {
  const events = await generate({ text: "   ", images: [] });
  const errors = events.filter((e) => e.type === "error");
  assert.equal(errors.length, 1, `expected exactly one error, got ${JSON.stringify(events)}`);
  assert.match(errors[0].message, /至少/);
  // No planning or generation stage may have run.
  const stages = events.filter((e) => e.type === "stage").map((e) => e.stage);
  assert.deepEqual(stages, ["intake"]);
});

test("e2e: an out-of-range duration is rejected", async () => {
  const events = await generate({ text: "面包店开门。", durationSec: 30 });
  assert.equal(events.at(-1).type, "error");
  assert.match(events.at(-1).message, /4-15/);
});

test("e2e: the config API never leaks the API key", async () => {
  const res = await consoleApi.fetch(`/api/config`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.apiKey, undefined);
  assert.equal(body.apiKeySource, "env");
  assert.equal(body.hasApiKey, true);
  assert.equal(JSON.stringify(body).includes("test-key"), false);
});

test("e2e: the skill endpoint reports the loaded official skill", async () => {
  const res = await consoleApi.fetch(`/api/skill`);
  const body = await res.json();
  assert.equal(body.name, "h3-prompt-writing");
  assert.equal(body.sha256_12["SKILL.md"].length, 12);
  assert.deepEqual(body.modes, ["T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA"]);
});

test("e2e: the UI is served and path traversal cannot reach outside web/", async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /H3 分镜提示词智能体/);

  const css = await fetch(`${base}/app.css`);
  assert.equal(css.status, 200);

  // Unknown and escaping paths fall back to the app shell. What matters is that the
  // response is never a file from outside web/ — assert on the CONTENT, since a
  // traversal attempt returning index.html is fine while returning package.json is not.
  for (const path of ["/../package.json", "/../../etc/passwd", "/%2e%2e/package.json", "/nope.js"]) {
    const res = await fetch(`${base}${path}`);
    const text = await res.text();
    assert.equal(text.includes('"name": "heima-agent"'), false, `${path} leaked package.json`);
    assert.equal(text.includes("root:x:"), false, `${path} leaked /etc/passwd`);
    assert.ok(text.includes("loginGate"), `${path} should have returned the app shell`);
  }
});

test("e2e: health endpoint is live", async () => {
  const res = await consoleApi.fetch(`/api/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});
