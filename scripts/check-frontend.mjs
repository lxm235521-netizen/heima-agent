/**
 * Front-end logic check.
 *
 * web/app.js is a browser module that touches the DOM at import time, so this
 * script stubs a minimal DOM, imports it, and then exercises the ONE piece of
 * non-obvious front-end logic: the incremental JSON string decoder that renders
 * the prompt live while the model is still streaming.
 *
 *   node scripts/check-frontend.mjs
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

/* ------------------------------------------------------------- DOM stub */
const makeElement = () => ({
  addEventListener() {},
  appendChild() {},
  append() {},
  replaceChildren() {},
  querySelectorAll: () => [],
  classList: { add() {}, remove() {}, toggle() {} },
  style: {},
  dataset: {},
  value: "",
  textContent: "",
  hidden: false,
  showModal() {},
  close() {},
  focus() {},
  files: [],
});
globalThis.document = {
  getElementById: makeElement,
  createElement: makeElement,
  createDocumentFragment: makeElement,
  querySelector: () => null,
  querySelectorAll: () => [],
  createRange: () => ({ selectNodeContents() {} }),
  body: makeElement(),
  cookie: "",
};
// app.js attaches global diagnostics (window "error"/"unhandledrejection"/"beforeunload")
// and uses getSelection for the clipboard fallback. Stubbing these keeps the check
// honest: if the module ever depends on a browser API that is missing, importing it
// here fails loudly instead of silently at runtime in someone's browser.
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  location: { href: "http://127.0.0.1:8787/", pathname: "/" },
};
// Node 24 already defines a read-only `navigator`; only stub it when absent.
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
  });
}
globalThis.Image = class { set src(_) {} };
globalThis.FileReader = class {};
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

/* ------------------------------------------------------- import app.js */
// A .mjs copy so Node treats the browser module as ESM.
const TMP = "web/.__syntax_check.mjs";
writeFileSync(TMP, readFileSync("web/app.js", "utf8"));
let mod;
try {
  mod = await import("../web/.__syntax_check.mjs");
} finally {
  rmSync(TMP, { force: true });
}
console.log("app.js parses and imports as an ES module: ok");
const { extractStreamingField } = mod.__test;

/* ------------------------------- incremental decoder, char by char ---- */
const promptValue =
  "integrated_multimodal_description: [Shot 1] Live-action, cinematic, the baker (S1) says: <d>[Chinese] 早上好。</d>\n\noverall_soundscape: Room tone.\n\nnon_diegetic_music: N/A";
const full = JSON.stringify({ mode: "I2VA", duration_sec: 8, prompt: promptValue, notes_zh: "ok" });

let last = "";
let threw = null;
for (let i = 1; i <= full.length; i += 1) {
  try {
    last = extractStreamingField(full.slice(0, i), "prompt");
  } catch (err) {
    threw = `at offset ${i}: ${err.message}`;
    break;
  }
}
assert.equal(threw, null, `extractor threw: ${threw}`);
assert.equal(last, promptValue, "streaming extractor did not converge on the exact value");
console.log(`extractStreamingField: converged exactly over ${full.length} partial-buffer steps, never threw`);

/* ---------------------------------------------------- escape handling - */
const escaped = JSON.stringify({ prompt: 'line1\nline2 with "quotes" and a tab\there and a \\ backslash' });
assert.equal(
  extractStreamingField(escaped, "prompt"),
  'line1\nline2 with "quotes" and a tab\there and a \\ backslash',
);
console.log("extractStreamingField: \\n, \\\", \\t and \\\\ decoded correctly");

/* ------------------------------------------------- incomplete escapes - */
// A chunk boundary landing mid-escape must degrade to the previous value, not throw.
const midEscape = '{"prompt":"abc\\';
assert.equal(extractStreamingField(midEscape, "prompt"), "", "dangling backslash must be tolerated");
const midUnicode = '{"prompt":"abc\\u00';
assert.equal(extractStreamingField(midUnicode, "prompt"), "", "partial \\uXXXX must be tolerated");
const okUnicode = '{"prompt":"abc\\u4e2d"}';
assert.equal(extractStreamingField(okUnicode, "prompt"), "abc中", "complete \\uXXXX must decode");
console.log("extractStreamingField: partial escapes tolerated, complete escapes decoded");

/* --------------------------------------------------------- robustness - */
assert.equal(extractStreamingField('{"mode":"T2VA"', "prompt"), "");
assert.equal(extractStreamingField("", "prompt"), "");
assert.equal(extractStreamingField('{"prompt":123}', "prompt"), "");
console.log("extractStreamingField: missing, empty and non-string values are safe");

console.log("\nFRONT-END LOGIC CHECK PASSED");
