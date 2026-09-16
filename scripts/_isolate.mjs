/**
 * Import this FIRST in any ad-hoc script that touches src/config.js:
 *
 *   import "./_isolate.mjs";              // must be the first import
 *   const { loadConfig } = await import("../src/config.js");
 *
 * It points H3_CONFIG_DIR at a throwaway copy of the real config, so a script can
 * exercise the real settings (model, baseUrl, and even the API key when it genuinely
 * needs to call upstream) without ever writing back to config.local.json.
 *
 * Why this exists: this class of mistake happened repeatedly during development —
 * a one-off script would import config.js with the real path and its writes landed in
 * the developer's live configuration, silently changing the saved model.
 *
 * Reading the real config is preserved: the copy is made from it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const REAL = path.join(ROOT, "config.local.json");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h3-script-config-"));

try {
  if (fs.existsSync(REAL)) fs.copyFileSync(REAL, path.join(dir, "config.local.json"));
} catch {
  /* a missing real config just means the script starts from defaults */
}

process.env.H3_CONFIG_DIR = dir;

process.on("exit", () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
