/**
 * The whole product promise rests on the official skill being present and
 * unmodified. These tests pin it to the recorded upstream commit hash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { ROOT } from "../src/config.js";
import { loadSkill, MODES, MODE_FAMILY, buildSystemPrompt } from "../src/prompts.js";

const MANIFEST = path.join(ROOT, "skills", "h3-prompt-writing", "MANIFEST.json");

test("official skill files exist and match the recorded hashes", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  assert.ok(manifest.commit, "MANIFEST.json must record the upstream commit");
  const entries = Object.entries(manifest.files);
  assert.ok(entries.length >= 3, "expected at least SKILL.md and the two reference guides");

  for (const [rel, meta] of entries) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `missing ${rel}`);
    const buf = fs.readFileSync(file);
    assert.equal(buf.length, meta.bytes, `${rel} size drifted from upstream`);
    const sha = createHash("sha256").update(buf).digest("hex");
    assert.equal(sha, meta.sha256, `${rel} content drifted from upstream commit ${manifest.commit}`);
  }
});

test("loadSkill exposes both guides with content", () => {
  const skill = loadSkill();
  assert.ok(skill.skill.includes("H3 Prompt Writing"));
  assert.ok(skill.base.includes("integrated_multimodal_description"));
  assert.ok(skill.base.includes("For the target video, at 0.00 seconds into the target video"));
  assert.ok(skill.ref.includes("subject_definitions"));
  assert.ok(skill.ref.includes("retention_analysis"));
  assert.equal(skill.info.sha256_12["SKILL.md"].length, 12);
});

test("system prompts embed the official guide verbatim, and only the relevant one", () => {
  const skill = loadSkill();
  const BASE_MARKER = "### 2.1 Part One Is the Instruction"; // base-en.txt only
  const REF_MARKER = "## 4. `retention_analysis`"; // ref-en.txt only

  const baseSystem = buildSystemPrompt("base", "test-model");
  // The guide is injected verbatim, not summarised.
  assert.ok(baseSystem.includes(skill.base.slice(0, 400)), "base guide must be embedded verbatim");
  assert.ok(baseSystem.includes(BASE_MARKER), "base guide section 2.1 must be present");
  assert.ok(!baseSystem.includes(REF_MARKER), "base mode must not ship the full ref guide");

  const refSystem = buildSystemPrompt("ref", "test-model");
  assert.ok(refSystem.includes(skill.ref.slice(0, 400)), "ref guide must be embedded verbatim");
  assert.ok(refSystem.includes(REF_MARKER), "ref guide section 4 must be present");
  assert.ok(!refSystem.includes(BASE_MARKER), "ref mode must not ship the full base guide");

  // Both keep the official workflow and output rules, and both declare their mode.
  for (const system of [baseSystem, refSystem]) {
    assert.ok(system.includes("Avoid plot summaries"), "official output rules must survive trimming");
    assert.ok(system.includes("Selected mode family for this request"));
  }
  assert.ok(baseSystem.includes("base-en.txt"));
  assert.ok(refSystem.includes("ref-en.txt"));
});

test("mode taxonomy matches the official five modes", () => {
  assert.deepEqual(MODES, ["T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA"]);
  assert.deepEqual(Object.values(MODE_FAMILY), ["base", "base", "base", "base", "ref"]);
});
