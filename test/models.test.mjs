/**
 * Model switching tests.
 *
 * Two things are worth protecting here:
 *  - a curated entry must resolve to a model id the upstream actually serves, falling
 *    through its candidate list, because dated aliases get retired without notice;
 *  - switching must persist, so the next generation uses the new model.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { startMockLlm } from "./mock-llm.mjs";
import { configureLogin, createConsoleClient } from "./helpers.mjs";
import { CURATED_MODELS, matchCuratedModel, resolveCuratedModel } from "../src/config.js";

let mock;
let app;
let base;
let consoleApi;

const FOUR = ["gemini-3.1-pro-preview", "gpt-6-astra", "claude-opus-4-8", "deepseek-v4.1-flash"];

before(async () => {
  mock = await startMockLlm();
  process.env.LLM_BASE_URL = mock.baseUrl;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.LLM_MODEL = "deepseek-v4.1-flash";
  delete process.env.LLM_PLANNER_MODEL;

  // The console requires a session; configure it before the first request.
  configureLogin();

  const { startServer } = await import("../src/server.mjs");
  app = await startServer({ port: 0, host: "127.0.0.1" });
  base = app.url;
  consoleApi = createConsoleClient(base);
  assert.ok(base, "test server failed to start");
});

after(async () => {
  await new Promise((resolve) => app?.server.close(resolve));
  await new Promise((resolve) => mock?.server.close(resolve));
  const dir = process.env.H3_CONFIG_DIR;
  if (dir) fs.rmSync(`${dir}/config.local.json`, { force: true });
});

/* ------------------------------------------------------- unit: curation */
test("the four requested models are all offered as one-click presets", () => {
  const allCandidates = CURATED_MODELS.flatMap((m) => m.candidates);
  for (const model of FOUR) {
    assert.ok(allCandidates.includes(model), `${model} must be reachable from a curated preset`);
  }
});

test("resolveCuratedModel prefers a candidate the upstream serves", () => {
  // First candidate matches.
  assert.equal(resolveCuratedModel("gemini", ["gemini-3.1-pro-preview"]).model, "gemini-3.1-pro-preview");
  // First candidate is retired upstream: fall through to the next one that exists.
  const { model, usedFallback } = resolveCuratedModel("gemini", ["gemini-3.8-flash"]);
  assert.equal(model, "gemini-3.8-flash");
  assert.equal(usedFallback, false, "an available candidate is not a fallback");
});

test("resolveCuratedModel flags a true fallback when nothing matches", () => {
  const resolved = resolveCuratedModel("gemini", ["unrelated-model"]);
  assert.equal(resolved.model, "gemini-3.1-pro-preview", "falls back to the preferred id");
  assert.equal(resolved.usedFallback, true);
});

test("resolveCuratedModel with no upstream list uses the preferred id", () => {
  const resolved = resolveCuratedModel("claude", []);
  assert.equal(resolved.model, "claude-opus-4-8");
  assert.equal(resolved.usedFallback, false, "an empty list means unknown, not missing");
});

test("resolveCuratedModel rejects an unknown preset instead of guessing", () => {
  assert.equal(resolveCuratedModel("nope", []), null);
});

test("matchCuratedModel maps a concrete model back to its preset", () => {
  assert.equal(matchCuratedModel("gpt-6-astra"), "gpt");
  assert.equal(matchCuratedModel("deepseek-v4.1-flash"), "deepseek");
  assert.equal(matchCuratedModel("brand-new-model"), null);
  assert.equal(matchCuratedModel(""), null);
});

/* ---------------------------------------------------- route: catalogue */
test("GET /api/models lists the presets and the upstream catalogue", async () => {
  const res = await consoleApi.fetch(`/api/models`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(Array.isArray(body.curated) && body.curated.length === CURATED_MODELS.length);
  for (const entry of body.curated) {
    assert.equal(typeof entry.label, "string");
    assert.equal(typeof entry.model, "string");
    assert.ok(entry.model.length > 0, "an entry must never expose an empty model id");
    assert.ok(Array.isArray(entry.candidates));
  }

  assert.equal(body.upstream.reachable, true, `upstream should be reachable: ${body.upstream.error}`);
  assert.ok(body.upstream.count >= 4);
  // Every curated preset must be verifiable against the mocked catalogue.
  for (const entry of body.curated) {
    assert.equal(entry.available, true, `${entry.label} (${entry.model}) should be advertised`);
  }
});

test("GET /api/models reports the currently active preset", async () => {
  const body = await (await consoleApi.fetch(`/api/models`)).json();
  assert.equal(body.curatedModelId, "deepseek");
  assert.equal(body.current, "deepseek-v4.1-flash");
});

/* ------------------------------------------------------ route: switch */
test("PUT /api/model switches by preset and persists", async () => {
  const res = await consoleApi.fetch(`/api/model`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entryId: "gemini" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, "gemini-3.1-pro-preview");
  assert.equal(body.curatedModelId, "gemini");
  assert.equal(body.applied.model, "gemini-3.1-pro-preview");

  // Persisted across a fresh read, which is what the next generation will use.
  const config = await (await consoleApi.fetch(`/api/config`)).json();
  assert.equal(config.model, "gemini-3.1-pro-preview");

  const models = await (await consoleApi.fetch(`/api/models`)).json();
  assert.equal(models.curatedModelId, "gemini", "the switcher must reflect the new active preset");
});

test("PUT /api/model switches every one of the four presets", async () => {
  for (const entryId of ["gpt", "claude", "deepseek", "gemini"]) {
    const res = await consoleApi.fetch(`/api/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId }),
    });
    assert.equal(res.status, 200, `switching to ${entryId} failed`);
    const body = await res.json();
    assert.ok(FOUR.includes(body.model), `${entryId} resolved to an unexpected model: ${body.model}`);
    assert.equal(body.curatedModelId, entryId);
  }
});

test("PUT /api/model accepts a raw model name for anything not in the presets", async () => {
  const res = await consoleApi.fetch(`/api/model`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "some-other-model" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, "some-other-model");
  assert.equal(body.curatedModelId, null, "a custom model highlights no preset button");
});

test("PUT /api/model can set a cheaper planner model, and clear it back", async () => {
  let body = await (
    await consoleApi.fetch(`/api/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "gemini", plannerModel: "deepseek-v4.1-flash" }),
    })
  ).json();
  assert.equal(body.model, "gemini-3.1-pro-preview");
  assert.equal(body.plannerModel, "deepseek-v4.1-flash");

  body = await (
    await consoleApi.fetch(`/api/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plannerModel: "" }),
    })
  ).json();
  assert.equal(body.plannerModel, "gemini-3.1-pro-preview", "clearing falls back to the generation model");
});

test("PUT /api/model reports enough for the UI to move the highlight", async () => {
  // Regression: the switcher used to update only the model name, not curatedModelId,
  // so the previously active chip stayed highlighted after a switch.
  const res = await consoleApi.fetch(`/api/model`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entryId: "claude" }),
  });
  const body = await res.json();
  assert.equal(body.model, "claude-opus-4-8");
  assert.equal(
    body.curatedModelId,
    "claude",
    "the response must identify the active preset so the UI can move the highlight",
  );

  // And the reverse switch must move it back.
  const back = await (
    await consoleApi.fetch(`/api/model`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "deepseek" }),
    })
  ).json();
  assert.equal(back.curatedModelId, "deepseek");
  assert.notEqual(back.curatedModelId, body.curatedModelId, "the highlight target must actually change");
});

test("PUT /api/model rejects an empty model rather than silently keeping the old one", async () => {
  const before = (await (await consoleApi.fetch(`/api/config`)).json()).model;
  const res = await consoleApi.fetch(`/api/model`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "   " }),
  });
  assert.equal(res.status, 400);
  const after = (await (await consoleApi.fetch(`/api/config`)).json()).model;
  assert.equal(after, before, "a rejected switch must not change the stored model");
});

test("PUT /api/model rejects an unknown preset", async () => {
  const res = await consoleApi.fetch(`/api/model`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entryId: "does-not-exist" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /未知/);
});

/* -------------------------------------------- generation uses the choice */
test("the generation pipeline actually uses the switched model", async () => {
  await consoleApi.fetch(`/api/model`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entryId: "claude" }),
  });

  // The mock echoes the requested model into every reply, so if the pipeline ignored
  // the switch this would still say the previous model.
  const res = await consoleApi.fetch(`/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "面包店开门。", durationSec: 8 }),
  });
  const events = (await res.text())
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const result = events.find((e) => e.type === "result");
  assert.ok(result, `expected a result: ${JSON.stringify(events.filter((e) => e.type === "error"))}`);
  assert.equal(result.result.validation.errors.length, 0);
});
