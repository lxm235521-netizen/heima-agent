/**
 * Smoke test: boots the real server against the bundled mock model and runs one
 * generation end to end. Useful for verifying a fresh checkout without an API key.
 *
 *   node scripts/smoke.mjs
 */
import "./_isolate.mjs"; // keep config access off the real config.local.json
import { startMockLlm } from "../test/mock-llm.mjs";
import { configureLogin, createConsoleClient } from "../test/helpers.mjs";

const mock = await startMockLlm();
process.env.LLM_BASE_URL = mock.baseUrl;
process.env.OPENAI_API_KEY = "smoke-test-key";
process.env.LLM_MODEL = "mock-vision-model";
process.env.LLM_PLANNER_MODEL = "mock-planner";
// The web console requires a session, so the smoke test logs in like a user would.
configureLogin();

const { startServer } = await import("../src/server.mjs");
const app = await startServer({ port: 0, host: "127.0.0.1" });
const consoleApi = createConsoleClient(app.url);

try {
  const page = await fetch(`${app.url}/`);
  const html = await page.text();
  console.log(`GET  /              -> ${page.status} ${html.includes("H3 分镜提示词智能体") ? "UI ok" : "UI MISSING"}`);

  // The console is gated: assert the gate exists, then log in.
  const anon = await fetch(`${app.url}/api/skill`);
  console.log(`GET  /api/skill 匿名 -> ${anon.status} ${anon.status === 401 ? "(已按预期拒绝)" : "(未拦截!)"}`);

  const skill = await consoleApi.json("/api/skill");
  if (!skill?.sha256_12) throw new Error(`/api/skill 返回异常: ${JSON.stringify(skill).slice(0, 200)}`);
  console.log(`GET  /api/skill     -> ${skill.name} (SKILL.md ${skill.sha256_12["SKILL.md"]}, base ${skill.bytes.base}B, ref ${skill.bytes.ref}B)`);

  const res = await consoleApi.fetch("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "深夜的旧仓库。老陈推开锈迹斑斑的铁门，压低声音：东西还在。",
      durationSec: 8,
      ratio: "16:9",
    }),
  });

  let result = null;
  let stages = 0;
  for (const line of (await res.text()).split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.type === "stage") stages += 1;
    if (event.type === "error") throw new Error(`pipeline error: ${event.message}`);
    if (event.type === "result") result = event.result;
  }

  if (!result) throw new Error("no result event returned");
  console.log(`POST /api/generate  -> 200 (${stages} stages)`);
  console.log(`     mode=${result.mode} duration=${result.durationSec}s shots=${result.shotCount}`);
  console.log(`     validation: ${result.validation.errors.length} errors, ${result.validation.warnings.length} warnings`);
  console.log(`     prompt: ${result.prompt.length} chars, ${result.prompt.slice(0, 60).replace(/\n/g, " ")}...`);
  console.log("\nSMOKE TEST PASSED");
} catch (err) {
  console.error(`\nSMOKE TEST FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => app.server.close(resolve));
  await new Promise((resolve) => mock.server.close(resolve));
}
