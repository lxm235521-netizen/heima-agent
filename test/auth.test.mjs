/**
 * Web console authentication tests.
 *
 * The important property is that the two surfaces stay independent:
 *   - the console needs a session and can reconfigure the service
 *   - /v1/* needs the API key and spends upstream quota
 * A web session must NOT be able to call /v1/* without the key, and an API key must
 * NOT be able to read or change configuration.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  SESSION_COOKIE,
  clearAttempts,
  clearSessions,
  hashPassword,
  loginAllowed,
  parseCookies,
  recordFailure,
  sessionCookie,
  verifyPassword,
} from "../src/auth.mjs";
import { startMockLlm } from "./mock-llm.mjs";

const USER = "admin";
const PASS = "a-strong-test-password";
const API_KEY = "sk-console-test-key";

let mock;
let app;
let base;

/** Collect Set-Cookie into a cookie header value. */
function cookieFrom(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map((c) => c.split(";")[0]).join("; ");
}

const login = (username = USER, password = PASS) =>
  fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

before(async () => {
  clearSessions();
  clearAttempts();

  mock = await startMockLlm();
  process.env.LLM_BASE_URL = mock.baseUrl;
  process.env.OPENAI_API_KEY = "upstream-key";
  process.env.LLM_MODEL = "mock-vision-model";

  // Bootstrap the console password the way a deployment actually does it: through the
  // environment on first start. There is deliberately NO unauthenticated way to set the
  // first password — otherwise a freshly deployed box would accept an anonymous
  // config write, which is exactly the window an attacker waits for.
  process.env.H3_WEB_USERNAME = USER;
  process.env.H3_WEB_PASSWORD = PASS;

  const { startServer } = await import("../src/server.mjs");
  app = await startServer({ port: 0, host: "127.0.0.1" });
  base = app.url;

  // Now that a session is possible, set the API key through the console API.
  const first = await login();
  assert.equal(first.status, 200, "env-configured credentials must allow login");
  const cookie = cookieFrom(first);

  const res = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ serverApiKey: API_KEY }),
  });
  assert.equal(res.status, 200, "an authenticated session must be able to configure");

  clearSessions();
  clearAttempts();
});

after(async () => {
  await new Promise((resolve) => app?.server.close(resolve));
  await new Promise((resolve) => mock?.server.close(resolve));
});

/* ------------------------------------------------------------- bootstrap */
test("login is unavailable until a password is configured", async () => {
  // A fresh install has no password. The server must refuse, not allow anonymous setup.
  const { createServer } = await import("../src/server.mjs");
  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "h3-nologin-"));
  const previousDir = process.env.H3_CONFIG_DIR;
  const previousPass = process.env.H3_WEB_PASSWORD;
  process.env.H3_CONFIG_DIR = isolatedDir;
  delete process.env.H3_WEB_PASSWORD;

  const bare = createServer();
  await new Promise((resolve) => bare.listen(0, "127.0.0.1", resolve));
  const bareBase = `http://127.0.0.1:${bare.address().port}`;

  try {
    const session = await (await fetch(`${bareBase}/api/session`)).json();
    assert.equal(session.loginEnabled, false);
    assert.equal(session.authenticated, false);

    // Critically: no anonymous config write on a fresh box.
    const write = await fetch(`${bareBase}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "attacker" }),
    });
    assert.equal(write.status, 503, "a fresh install must not accept an anonymous config write");

    const loginAttempt = await fetch(`${bareBase}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "anything" }),
    });
    assert.equal(loginAttempt.status, 503);
  } finally {
    await new Promise((resolve) => bare.close(resolve));
    process.env.H3_CONFIG_DIR = previousDir;
    if (previousPass !== undefined) process.env.H3_WEB_PASSWORD = previousPass;
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------- hashing */
test("passwords are stored as a salted hash, never plaintext", () => {
  const hash = hashPassword(PASS);
  assert.match(hash, /^scrypt\$/);
  assert.equal(hash.includes(PASS), false, "the hash must not contain the password");
  assert.equal(verifyPassword(PASS, hash), true);
  assert.equal(verifyPassword("wrong", hash), false);
  assert.equal(verifyPassword(PASS, "garbage"), false);
  assert.equal(verifyPassword(PASS, ""), false);
});

test("the same password hashes differently each time (unique salt)", () => {
  const a = hashPassword(PASS);
  const b = hashPassword(PASS);
  assert.notEqual(a, b, "two hashes of one password must differ");
  assert.equal(verifyPassword(PASS, a), true);
  assert.equal(verifyPassword(PASS, b), true);
});

test("session cookies are opaque and not derived from the password", () => {
  const cookie = sessionCookie("token-abc", { secure: false });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(cookie.includes("Secure"), false, "Secure must be omitted on plain HTTP");
  assert.match(sessionCookie("token-abc", { secure: true }), /Secure/);
});

test("parseCookies handles a realistic header", () => {
  const parsed = parseCookies("a=1; h3_session=xyz; b=2");
  assert.equal(parsed[SESSION_COOKIE], "xyz");
});

/* ------------------------------------------------------------ throttling */
test("repeated failures block further attempts", () => {
  clearAttempts();
  const key = "test-client";
  assert.equal(loginAllowed(key).allowed, true);
  for (let i = 0; i < 7; i += 1) recordFailure(key);
  assert.equal(loginAllowed(key).allowed, true, "under the threshold, still allowed");
  recordFailure(key);
  const gate = loginAllowed(key);
  assert.equal(gate.allowed, false, "the 8th failure must lock the client out");
  assert.ok(gate.retryAfterSec > 0);
  clearAttempts();
});

/* ------------------------------------------------------- session routes */
test("GET /api/session reports login state and never leaks a hash", async () => {
  const anon = await fetch(`${base}/api/session`);
  const body = await anon.json();
  assert.equal(body.loginEnabled, true);
  assert.equal(body.authenticated, false);
  assert.equal(JSON.stringify(body).includes("scrypt"), false, "the hash must never be sent");
});

test("a wrong password is rejected without saying which part was wrong", async () => {
  const wrongPass = await login(USER, "nope");
  assert.equal(wrongPass.status, 401);
  const body = await wrongPass.json();
  assert.match(body.error, /用户名或密码/);

  const wrongUser = await login("someone-else", PASS);
  assert.equal(wrongUser.status, 401);
  assert.match((await wrongUser.json()).error, /用户名或密码/);
});

test("a correct password issues a working session", async () => {
  const res = await login();
  assert.equal(res.status, 200);
  const cookie = cookieFrom(res);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));

  // The cookie carries an opaque token, not the credentials.
  assert.equal(cookie.includes(PASS), false);

  const session = await fetch(`${base}/api/session`, { headers: { cookie } });
  const body = await session.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.username, USER);

  const config = await fetch(`${base}/api/config`, { headers: { cookie } });
  assert.equal(config.status, 200, "an authenticated session must reach the console APIs");
});

/* ------------------------------------------------- console requires login */
test("the console API refuses an anonymous caller", async () => {
  for (const path of ["/api/config", "/api/providers", "/api/models", "/api/skill"]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 401, `${path} must require a session`);
  }
});

test("changing configuration requires a session", async () => {
  const res = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "attacker-model" }),
  });
  assert.equal(res.status, 401);

  // And nothing changed.
  const login2 = await login();
  const cookie = cookieFrom(login2);
  const config = await (await fetch(`${base}/api/config`, { headers: { cookie } })).json();
  assert.notEqual(config.model, "attacker-model");
});

test("the app shell stays public so the login form can render", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200, "index.html must be reachable without a session");
  assert.match(await res.text(), /loginGate/);
});

/* ------------------------------------------ the two surfaces are separate */
test("a web session does NOT grant access to /v1/*", async () => {
  const res = await login();
  const cookie = cookieFrom(res);
  const api = await fetch(`${base}/v1/models`, { headers: { cookie } });
  assert.equal(api.status, 401, "a web login must not be usable as an API key");
});

test("the API key does NOT grant access to the console", async () => {
  const res = await fetch(`${base}/api/config`, { headers: { authorization: `Bearer ${API_KEY}` } });
  assert.equal(res.status, 401, "an API key must not read configuration");
});

test("/v1/* still works with its own key while the console is locked down", async () => {
  const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${API_KEY}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data[0].id, "h3-prompt-writing");
});

/* --------------------------------------------------------------- logout */
test("logout invalidates the session immediately", async () => {
  const res = await login();
  const cookie = cookieFrom(res);
  assert.equal((await fetch(`${base}/api/config`, { headers: { cookie } })).status, 200);

  const out = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
  assert.equal(out.status, 200);

  assert.equal(
    (await fetch(`${base}/api/config`, { headers: { cookie } })).status,
    401,
    "the old cookie must stop working after logout",
  );
});

test("the login form must not rely on native `required` validation", async () => {
  // Regression: with `required` on the inputs, the browser cancelled the submit event
  // entirely, so clicking 登录 with empty fields produced NO request and NO message —
  // indistinguishable from a dead button. Validation now lives in the submit handler.
  const html = await (await fetch(`${base}/`)).text();
  const form = html.slice(html.indexOf('id="loginForm"'), html.indexOf("</form>"));
  assert.equal(/required/.test(form), false, "the login inputs must not use native required");
  assert.match(form, /autocomplete="off"/, "autofill must be off so it cannot overwrite input");
  assert.match(form, /id="loginError"/, "there must be a visible place to show validation errors");
});

test("the health endpoint stays open for container health checks", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
});
