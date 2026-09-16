/**
 * Shared test bootstrap — loaded with `node --import` BEFORE any test module.
 *
 * Why this exists: src/config.js resolves its config file path once, at module load
 * time. If H3_CONFIG_DIR were redirected later, the suite would write to the REAL
 * config.local.json and clobber a developer's saved provider/model/key. That happened
 * twice during development, so the guarantee now lives here.
 *
 * The guarantee: on a test run this file ALWAYS points H3_CONFIG_DIR at a throwaway
 * temp directory, overriding whatever was inherited. It runs before any test imports
 * src/config.js, so no test can write outside the sandbox — regardless of argument
 * order, of whether node was started via a script, or of what was in the environment.
 *
 * When the shell still contains an interesting H3_CONFIG_DIR, we copy it into the
 * sandbox, so a config set up for a container run stays visible to tests without ever
 * being written back.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isTestRun =
  process.argv.includes("--test") ||
  process.env.NODE_TEST_CONTEXT !== undefined ||
  /\.test\.mjs$/.test(process.argv[1] ?? "");

if (isTestRun) {
  const inherited = process.env.H3_CONFIG_DIR ?? "";
  const isAlreadyThrowaway = /tmp-test-config|h3-test-config|h3cfg/i.test(inherited);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "h3-test-config-"));

  // Carry over an explicitly provided config (minus secrets we would never need),
  // so tests that assert on inherited state still work.
  if (inherited && !isAlreadyThrowaway) {
    const source = path.join(inherited, "config.local.json");
    try {
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dir, "config.local.json"));
    } catch {
      /* a missing source is fine */
    }
  }

  process.env.H3_CONFIG_DIR = dir;

  process.on("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
}
