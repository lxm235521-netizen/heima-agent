/**
 * Drive a real browser through the console login, over the Chrome DevTools Protocol.
 *
 * Written because "the login button does nothing" cannot be diagnosed from the DOM
 * alone — it needs the browser's console, its network log, and a real click.
 *
 *   node scripts/browser-login-check.mjs [url]
 *
 * Set CHROME_PATH to override the browser binary. Requires Chrome/Edge 111+ for
 * --headless=new.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


const CHROME =
  process.env.CHROME_PATH ??
  [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error("找不到 Chrome/Edge，可用 CHROME_PATH 指定。");
  process.exit(1);
}

// argv: [node, script, url, username, password]
// Parsed explicitly rather than by destructuring with defaults, which silently
// mis-assigned the password during development and produced a confusing 401.
const urlArg = process.argv[2] ?? "http://127.0.0.1:8787/";
const user = process.env.H3_TEST_USER ?? process.argv[3] ?? "admin";
const pass = process.env.H3_TEST_PASS ?? process.argv[4] ?? "";

if (!pass) {
  console.error("用法: node scripts/browser-login-check.mjs <url> <用户名> <密码>");
  process.exit(1);
}
console.log(`目标: ${urlArg}\n账号: ${user} / 密码长度 ${pass.length}`);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "h3-cdp-"));
const port = 9223 + Math.floor(Math.random() * 200);

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--window-size=1200,800",
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the debugging endpoint answers. */
async function waitForDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome 调试端口未就绪");
}

/** Minimal CDP client over one WebSocket. */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const events = [];
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, events, close: () => socket.close() };
}

const logs = [];
const requests = [];

try {
  await waitForDevtools();
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(urlArg)}`, { method: "PUT" })
  ).json();
  const cdp = await connect(target.webSocketDebuggerUrl);

  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");

  // Collect console output and page errors.
  cdp.events.length = 0;
  await sleep(3500);

  for (const ev of cdp.events) {
    if (ev.method === "Runtime.consoleAPICalled") {
      logs.push(`[console.${ev.params.type}] ${ev.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
    } else if (ev.method === "Runtime.exceptionThrown") {
      const d = ev.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${d.exception?.description ?? d.text}`);
    } else if (ev.method === "Log.entryAdded") {
      const e = ev.params.entry;
      logs.push(`[${e.level}] ${e.text}${e.url ? ` (${e.url})` : ""}`);
    } else if (ev.method === "Network.requestWillBeSent") {
      requests.push(ev.params.request.url);
    } else if (ev.method === "Network.responseReceived") {
      const r = ev.params.response;
      requests.push(`<- ${r.status} ${r.url}`);
    }
  }

  console.log("=== 页面加载阶段的控制台输出 ===");
  if (!logs.length) console.log("  (无输出，说明没有 JS 报错)");
  for (const line of logs) console.log("  " + line);

  console.log("\n=== 网络请求 ===");
  for (const line of requests) console.log("  " + line);

  // Inspect the login wiring before clicking.
  const probe = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const form = document.getElementById("loginForm");
      const gate = document.getElementById("loginGate");
      const btn = document.getElementById("loginSubmit");
      const err = document.getElementById("loginError");
      return JSON.stringify({
        hasForm: !!form,
        gateHidden: gate ? gate.hidden : null,
        btnHidden: btn ? btn.hidden : null,
        btnType: btn ? btn.type : null,
        errorText: err ? err.textContent : null,
        errorHidden: err ? err.hidden : null,
        sessionProbe: typeof window.fetch,
      });
    })()`,
    returnByValue: true,
  });
  console.log("\n=== 点击前状态 ===");
  console.log("  " + probe.result.value);

  // Test 1: does clicking with EMPTY fields produce visible feedback?
  // This is the regression: native `required` validation used to swallow the click, so
  // the user saw neither a request nor a message.
  const emptyClick = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      document.getElementById("loginUser").value = "";
      document.getElementById("loginPass").value = "";
      const err = document.getElementById("loginError");
      err.hidden = true; err.textContent = "";
      document.getElementById("loginSubmit").click();
      return JSON.stringify({
        errorShown: !err.hidden,
        errorText: err.textContent,
      });
    })()`,
    returnByValue: true,
  });
  console.log("\n=== 空字段点「登录」===");
  const emptyState = JSON.parse(emptyClick.result.value);
  console.log(`  是否给出提示: ${emptyState.errorShown ? "是" : "否（这就是「点了没反应」）"}`);
  console.log(`  提示内容: ${JSON.stringify(emptyState.errorText)}`);

  // Test 2: fill in real credentials and submit.
  //
  // The assignment and the submit MUST happen in one evaluation. Splitting them lets
  // the browser's password autofill rewrite the field in between, which produced an
  // otherwise baffling 401 during development.
  requests.length = 0;
  const submitResult = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const u = document.getElementById("loginUser");
      const p = document.getElementById("loginPass");
      u.value = ${JSON.stringify(user)};
      p.value = ${JSON.stringify(pass)};
      const readBack = p.value;
      document.getElementById("loginForm").requestSubmit();
      return JSON.stringify({ expected: ${pass.length}, actual: readBack.length, matched: readBack === ${JSON.stringify(pass)} });
    })()`,
    returnByValue: true,
  });
  await sleep(2500);

  // First, watch the field for ~600ms after assignment to see whether something (the
  // browser's credential autofill) rewrites it. This is the step that made an earlier
  // diagnosis wrong, so observe it rather than assume.
  const drift = await cdp.send("Runtime.evaluate", {
    expression: `(() => new Promise((resolve) => {
      const p = document.getElementById("loginPass");
      const seen = [];
      p.value = ${JSON.stringify(pass)};
      const t0 = Date.now();
      const timer = setInterval(() => {
        seen.push(Date.now() - t0 + "ms:" + p.value.length);
        if (Date.now() - t0 > 600) {
          clearInterval(timer);
          resolve(JSON.stringify({ expected: ${pass.length}, samples: seen }));
        }
      }, 60);
    }))()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const driftState = JSON.parse(drift.result.value);
  console.log("\n=== 赋值后 600ms 内密码框长度变化（期望恒为 " + driftState.expected + "）===");
  console.log("  " + driftState.samples.join("  "));
  if (driftState.samples.some((s) => !s.endsWith(`:${driftState.expected}`))) {
    console.log("  ⚠ 字段被外部改写 —— 浏览器自动填充覆盖了脚本赋值");
  }

  // Capture the request payload and the response, which is what actually explains a
  // rejection — the status alone does not.
  for (const ev of cdp.events) {
    if (ev.method === "Network.requestWillBeSent" && ev.params.request.url.includes("/api/login")) {
      console.log(`  请求体: ${ev.params.request.postData ?? "(无)"}`);
    }
    if (ev.method === "Network.responseReceived" && ev.params.response.url.includes("/api/login")) {
      console.log(`  响应: HTTP ${ev.params.response.status}`);
    }
  }

  const after = await cdp.send("Runtime.evaluate", {
    expression: `(() => JSON.stringify({
      gateHidden: document.getElementById("loginGate").hidden,
      gateDisplay: getComputedStyle(document.getElementById("loginGate")).display,
      appHidden: document.getElementById("app").hidden,
      appDisplay: getComputedStyle(document.getElementById("app")).display,
      errorText: document.getElementById("loginError").textContent,
      errorDisplay: getComputedStyle(document.getElementById("loginError")).display,
      build: document.getElementById("loginForm")?.dataset.build ?? null,
    }))()`,
    returnByValue: true,
  });
  console.log("\n=== 提交后状态 ===");
  const finalState = JSON.parse(after.result.value);
  console.log(`  页面版本标记: ${finalState.build}`);
  console.log(`  登录页: hidden=${finalState.gateHidden} display=${finalState.gateDisplay}`);
  console.log(`  控制台: hidden=${finalState.appHidden} display=${finalState.appDisplay}`);
  console.log(`  错误区: display=${finalState.errorDisplay} 内容=${JSON.stringify(finalState.errorText)}`);
  const entered = finalState.gateDisplay === "none" && finalState.appDisplay !== "none";
  console.log(
    entered
      ? "\n✓ 登录成功，已进入控制台"
      : `\n✗ 未进入控制台（${finalState.errorText || "无提示"}）`,
  );

  if (logs.length) {
    console.log("\n=== 控制台输出 ===");
    const late = cdp.events.filter(
      (e) => e.method === "Runtime.exceptionThrown" || e.method === "Log.entryAdded" || e.method === "Runtime.consoleAPICalled",
    );
    for (const ev of late.slice(-10)) {
      if (ev.method === "Runtime.exceptionThrown") {
        console.log("  [EXCEPTION] " + (ev.params.exceptionDetails.exception?.description ?? ev.params.exceptionDetails.text));
      } else if (ev.method === "Log.entryAdded") {
        console.log(`  [${ev.params.entry.level}] ${ev.params.entry.text}`);
      } else {
        console.log(`  [console.${ev.params.type}] ${ev.params.args.map((a) => a.value ?? "").join(" ")}`);
      }
    }
  }

  cdp.close();
} finally {
  chrome.kill();
  await sleep(500);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
