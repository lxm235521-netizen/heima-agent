/**
 * Upstream client tests.
 *
 * These exist because a real third-party relay behaved in a way the first
 * implementation could not handle: it ignored `stream: false`, and for that model it
 * returned a usage-only SSE chunk with `choices: []` and no content at all. The
 * planning stage silently degraded as a result.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { parseSseBuffer, chatComplete, chatStream, LLMError } from "../src/llm.js";
import { startMockLlm } from "./mock-llm.mjs";

let mock;

before(async () => {
  mock = await startMockLlm();
});

after(async () => {
  await new Promise((resolve) => mock?.server.close(resolve));
});

const configFor = (behaviour) => {
  if (behaviour) process.env.MOCK_BEHAVIOUR = behaviour;
  else delete process.env.MOCK_BEHAVIOUR;
  return {
    baseUrl: mock.baseUrl,
    apiKey: "test-key",
    model: "mock-planner",
    requestTimeoutMs: 20000,
  };
};

/* ------------------------------------------------------- SSE splitting - */
test("parseSseBuffer: extracts data payloads and keeps the incomplete tail", () => {
  const { payloads, rest } = parseSseBuffer('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
  assert.deepEqual(payloads, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, 'data: {"c"');
});

test("parseSseBuffer: skips [DONE], blank data and comment lines", () => {
  const { payloads } = parseSseBuffer(": keep-alive\n\ndata: [DONE]\n\ndata: \n\ndata: {\"ok\":1}\n\n", { flush: true });
  assert.deepEqual(payloads, ['{"ok":1}']);
});

test("parseSseBuffer: flush returns a frame with no trailing blank line", () => {
  const { payloads, rest } = parseSseBuffer('data: {"last":true}', { flush: true });
  assert.deepEqual(payloads, ['{"last":true}']);
  assert.equal(rest, "");
});

test("parseSseBuffer: tolerates CRLF and multi-line frames", () => {
  const { payloads } = parseSseBuffer('event: message\r\ndata: {"x":1}\r\n\r\n', { flush: true });
  assert.deepEqual(payloads, ['{"x":1}']);
});

/* ------------------------------------------------ chatComplete behaviour */
test("chatComplete: assembles a streamed response into text, usage and model", async () => {
  const config = configFor(null);
  const res = await chatComplete(config, { messages: [{ role: "user", content: "hello" }] });
  assert.ok(res.text.includes("mode"), `expected JSON content, got: ${res.text.slice(0, 120)}`);
  assert.ok(res.usage && res.usage.total_tokens > 0, "usage must be reported");
  assert.equal(typeof res.model, "string");
});

test("chatComplete: asks the provider for a stream, because non-streaming is unreliable", async () => {
  // The mock records the requested stream flag via behaviour "emptynonstream":
  // it returns content only when stream was requested.
  const config = configFor("emptynonstream");
  const res = await chatComplete(config, { messages: [{ role: "user", content: "hello" }] });
  assert.ok(res.text.length > 0, "chatComplete must not depend on the provider honouring stream:false");
  // The planning system prompt is what our caller sends for a plan; here we only
  // assert we got usable content rather than an empty/usage-only reply.
  assert.ok(!res.text.includes("choices"), "raw SSE must never leak into the text");
});

test("chatComplete: a 200 reply with empty choices raises a clear error, never silent emptiness", async () => {
  const config = configFor("emptychoices");
  await assert.rejects(
    () => chatComplete(config, { messages: [{ role: "user", content: "hello" }] }),
    (err) => {
      assert.ok(err instanceof LLMError, `expected an LLMError, got ${err?.name}`);
      assert.match(err.message, /空内容|没有任何 choices/);
      return true;
    },
  );
});

test("chatComplete: an HTTP error carries the status and a readable message", async () => {
  const config = configFor("http401");
  await assert.rejects(
    () => chatComplete(config, { messages: [{ role: "user", content: "hello" }] }),
    (err) => {
      assert.match(err.message, /401/);
      return true;
    },
  );
});

test("chatComplete: missing credentials fail before any network call", async () => {
  await assert.rejects(
    () => chatComplete({ baseUrl: mock.baseUrl, apiKey: "" }, { messages: [{ role: "user", content: "x" }] }),
    /API Key/,
  );
  await assert.rejects(
    () => chatComplete({ baseUrl: "", apiKey: "k" }, { messages: [{ role: "user", content: "x" }] }),
    /baseUrl/,
  );
});

/* --------------------------------------------------------- chatStream --- */
test("chatStream: yields deltas and a final usage record", async () => {
  const config = configFor(null);
  let text = "";
  let usage = null;
  for await (const evt of chatStream(config, { messages: [{ role: "user", content: "hello" }] })) {
    if (evt.delta) text += evt.delta;
    if (evt.usage) usage = evt.usage;
  }
  assert.ok(text.length > 0);
  assert.ok(usage && usage.total_tokens > 0, "streaming must surface usage");
});

test("chatStream: surfaces an upstream error frame as a thrown error", async () => {
  const config = configFor("http401");
  await assert.rejects(async () => {
    for await (const _ of chatStream(config, { messages: [{ role: "user", content: "x" }] })) {
      /* drain */
    }
  }, /401/);
});
