import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const REPO = "MiniMax-AI/MiniMax-H3";
const REF = process.env.H3_REF || "main";
const RAW = `https://raw.githubusercontent.com/${REPO}/${REF}`;
const API = `https://api.github.com/repos/${REPO}/commits/${REF}`;

const files = [
  "skills/h3-prompt-writing/SKILL.md",
  "skills/h3-prompt-writing/references/base-en.txt",
  "skills/h3-prompt-writing/references/ref-en.txt",
  "skills/h3-prompt-writing/agents/openai.yaml",
];

let commit = null;
try {
  const r = await fetch(API, { headers: { "user-agent": "heima-agent" }, signal: AbortSignal.timeout(25000) });
  if (r.ok) { const j = await r.json(); commit = j.sha || null; }
} catch {}

const manifest = { source: `https://github.com/${REPO}/tree/${REF}/skills`, ref: REF, commit, downloaded_at: new Date().toISOString(), files: {} };

await mkdir("skills/h3-prompt-writing/references", { recursive: true });
await mkdir("skills/h3-prompt-writing/agents", { recursive: true });

for (const f of files) {
  const dest = "skills/" + f.slice("skills/".length);
  try {
    const r = await fetch(`${RAW}/${f}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.log(`SKIP ${f} -> HTTP ${r.status}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    await writeFile(dest, buf);
    manifest.files[dest] = { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
    console.log(`OK   ${dest}  ${buf.length} bytes`);
  } catch (e) { console.log(`FAIL ${f}: ${e.message}`); }
}
await writeFile("skills/h3-prompt-writing/MANIFEST.json", JSON.stringify(manifest, null, 2) + "\n");
console.log("commit=" + commit);
