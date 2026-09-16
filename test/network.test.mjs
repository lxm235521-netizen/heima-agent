/**
 * Network exposure tests for a publicly reachable deployment.
 *
 * Two surfaces with two independent guards:
 *   - the web console: reachable from anywhere, requires a session
 *   - /v1/*:           reachable from anywhere, requires the API key
 *
 * Neither credential may substitute for the other. This file was originally written for
 * an earlier loopback-only console rule; that rule was replaced by session auth once the
 * service needed to be usable from a remote browser, so the assertions now describe the
 * session model instead.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { startMockLlm } from "./mock-llm.mjs";
import { configureLogin, createConsoleClient, TEST_WEB_PASS, TEST_WEB_USER } from "./helpers.mjs";

const INBOUND_KEY = "sk-network-test-key";

let mock;
let app;
let base;
let consoleApi;

before(async () => {
  mock = await startMockLlm();
  process.env.LLM_BASE_URL = mock.baseUrl;
  process.env.OPENAI_API_KEY = "upstream-key";
  process.env.LLM_MODEL = "mock-vision-model";

  configureLogin();

  const { startServer } = await import("../src/server.mjs");
  app = await startServer({ port: 0, host: "127.0.0.1" });
  base = app.url;
  consoleApi = createConsoleClient(base);
  assert.ok(base, "test server failed to start");

  const res = await consoleApi.fetch("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serverApiKey: INBOUND_KEY }),
  });
  assert.equal(res.status, 200, "an authenticated session must be able to set the API key");
});

after(async () => {
  await new Promise((resolve) => app?.server.close(resolve));
  await new Promise((resolve) => mock?.server.close(resolve));
});

/* ------------------------------------------------------------- console */
test("the console requires a session from every origin", async () => {
  for (const path of ["/api/config", "/api/providers", "/api/models", "/api/skill", "/api/model"]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 401, `${path} must refuse an anonymous caller`);
  }
});

test("the app shell is public so the login form can render", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /loginGate/);
});

test("a session grants console access", async () => {
  for (const path of ["/api/config", "/api/models", "/api/skill"]) {
    const res = await consoleApi.fetch(path);
    assert.equal(res.status, 200, `${path} should work with a session`);
  }
});

/* --------------------------------------------------------------- /v1/* */
test("/v1/* requires the API key", async () => {
  const anon = await fetch(`${base}/v1/models`);
  assert.equal(anon.status, 401, "an anonymous caller must be rejected on credentials");

  const wrong = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer sk-wrong" } });
  assert.equal(wrong.status, 401);

  const authed = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${INBOUND_KEY}` } });
  assert.equal(authed.status, 200, "an authenticated caller must be allowed from anywhere");
  assert.equal((await authed.json()).data[0].id, "h3-prompt-writing");
});

test("a failed auth response never echoes the expected key", async () => {
  const res = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer sk-wrong" } });
  assert.equal((await res.text()).includes(INBOUND_KEY), false);
});

/* ------------------------------------------- credentials are not portable */
test("a web session cannot be used as an API key", async () => {
  const res = await consoleApi.fetch("/v1/models");
  assert.equal(res.status, 401, "the console cookie must not authorize /v1/*");
});

test("the API key cannot be used to read or change configuration", async () => {
  const read = await fetch(`${base}/api/config`, { headers: { authorization: `Bearer ${INBOUND_KEY}` } });
  assert.equal(read.status, 401);

  const write = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${INBOUND_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "attacker-model" }),
  });
  assert.equal(write.status, 401);

  const config = await consoleApi.json("/api/config");
  assert.notEqual(config.model, "attacker-model", "the config must be unchanged");
});

/* -------------------------------------------------------------- health */
test("health checks work without a session, for container orchestration", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
});

/* ---------------------------------------------------------- login brute force */
test("the login route throttles repeated failures instead of allowing unlimited guesses", async () => {
  const attempt = () =>
    fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: TEST_WEB_USER, password: "wrong-password" }),
    });

  let sawThrottle = false;
  for (let i = 0; i < 12; i += 1) {
    const res = await attempt();
    if (res.status === 429) {
      sawThrottle = true;
      const body = await res.json();
      assert.ok(body.retryAfterSec > 0);
      break;
    }
  }
  assert.equal(sawThrottle, true, "repeated wrong passwords must eventually be throttled");

  // The correct password must also be refused while throttled — that is the point.
  const correct = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: TEST_WEB_USER, password: TEST_WEB_PASS }),
  });
  assert.equal(correct.status, 429, "a throttled client stays throttled even with the right password");
});
