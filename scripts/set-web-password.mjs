/**
 * Set the web console password.
 *
 *   node scripts/set-web-password.mjs <username> <password>
 *   node scripts/set-web-password.mjs admin 'my-new-password'
 *
 * Writes ONLY a scrypt hash into config.local.json — the plaintext is never persisted.
 * This is intentionally a real, kept script rather than a one-off: rotating the console
 * password is a normal operation, and doing it by hand invites mistakes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "../src/auth.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const CONFIG = path.join(ROOT, "config.local.json");

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error("用法: node scripts/set-web-password.mjs <用户名> <密码>");
  process.exit(1);
}
if (password.length < 8) {
  console.error("密码至少 8 位。");
  process.exit(1);
}

let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
} catch {
  /* first run: start from an empty config */
}

config.webUsername = username;
config.webPasswordHash = hashPassword(password);
fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + "\n", "utf8");

console.log(`已设置网页登录：用户名 ${username}`);
console.log(`密码已哈希后写入 config.local.json（明文不落盘）。`);
console.log(`哈希算法: scrypt (N=16384, r=8, p=1)，每个安装独立随机盐。`);
