/**
 * Config resolution tests.
 *
 * The important case here is a saved value being silently ignored: config.local.json
 * holds real JSON types, so `repairPasses: 2` arrives as a number, and a truthiness
 * or string-only check would drop it and fall back to the default.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/* test/setup.mjs (loaded via --import) points H3_CONFIG_DIR at a temp directory
 * before src/config.js is evaluated, so these writes never touch the real file. */
const CONFIG_DIR = process.env.H3_CONFIG_DIR;
assert.ok(CONFIG_DIR, "test/setup.mjs must have redirected H3_CONFIG_DIR");

const { saveConfig, loadConfig, publicConfig, PROVIDER_PRESETS } = await import("../src/config.js");

const CONFIG_FILE = path.join(CONFIG_DIR, "config.local.json");

before(() => {
  fs.rmSync(CONFIG_FILE, { force: true });
});

after(() => {
  fs.rmSync(CONFIG_FILE, { force: true });
});

test("a saved repairPasses round trips, including the meaningful value 0", () => {
  for (const value of [2, 0, 1, 3]) {
    saveConfig({ repairPasses: value });
    assert.equal(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")).repairPasses, value, "written to disk");
    assert.equal(loadConfig().repairPasses, value, `repairPasses=${value} must survive the round trip`);
  }
});

test("a saved boolean round trips", () => {
  saveConfig({ deepDive: true });
  assert.equal(loadConfig().deepDive, true);
  saveConfig({ deepDive: "" });
  assert.equal(loadConfig().deepDive, false);
});

test("out-of-range numbers are clamped rather than rejected", () => {
  saveConfig({ repairPasses: 99 });
  assert.equal(loadConfig().repairPasses, 5);
  saveConfig({ repairPasses: -3 });
  assert.equal(loadConfig().repairPasses, 0);
  saveConfig({ requestTimeoutMs: 10 });
  assert.equal(loadConfig().requestTimeoutMs, 1000, "a sub-second timeout would break every call");
});

test("non-numeric input falls back to the default", () => {
  saveConfig({ repairPasses: "not-a-number" });
  assert.equal(loadConfig().repairPasses, 1);
});

test("string settings round trip and an empty string clears them", () => {
  saveConfig({ baseUrl: "https://newapi.example.com/v1", model: "qwen-vl-max" });
  let config = loadConfig();
  assert.equal(config.baseUrl, "https://newapi.example.com/v1");
  assert.equal(config.model, "qwen-vl-max");

  saveConfig({ baseUrl: "" });
  config = loadConfig();
  assert.notEqual(config.baseUrl, "https://newapi.example.com/v1", "clearing must fall back to the preset");
});

test("the NewAPI preset exists and points at an OpenAI-compatible path", () => {
  const preset = PROVIDER_PRESETS.newapi;
  assert.ok(preset, "a newapi preset must be available for third-party relay deployments");
  assert.ok(preset.baseUrl.endsWith("/v1"), `baseUrl must end in /v1, got ${preset.baseUrl}`);
  assert.ok(preset.envKey.includes("NEWAPI_API_KEY"));
});

test("publicConfig never exposes either secret", () => {
  saveConfig({ apiKey: "sk-upstream-secret", serverApiKey: "sk-inbound-secret" });
  const pub = publicConfig(loadConfig());
  const serialized = JSON.stringify(pub);
  assert.equal(serialized.includes("sk-upstream-secret"), false);
  assert.equal(serialized.includes("sk-inbound-secret"), false);
  assert.equal(pub.hasApiKey, true);
  assert.equal(pub.hasServerApiKey, true);
  assert.equal(pub.apiKey, undefined);
  assert.equal(pub.serverApiKey, undefined);
});

test("inbound auth is reported as off when no server key is configured", () => {
  saveConfig({ serverApiKey: "" });
  const previous = process.env.H3_SERVER_API_KEY;
  delete process.env.H3_SERVER_API_KEY;
  try {
    const pub = publicConfig(loadConfig());
    assert.equal(pub.hasServerApiKey, false);
  } finally {
    if (previous !== undefined) process.env.H3_SERVER_API_KEY = previous;
  }
});

test("the exposed model id is configurable", () => {
  saveConfig({ publicModelId: "h3-storyboard" });
  assert.equal(loadConfig().publicModelId, "h3-storyboard");
  assert.equal(publicConfig(loadConfig()).publicModelId, "h3-storyboard");
});
