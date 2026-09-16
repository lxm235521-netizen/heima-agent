/**
 * Structural validation of generated H3 prompts.
 *
 * This is what separates "the model wrote something" from "the output actually
 * follows the official skill". Checks are derived from the two official guides:
 *   - base-en.txt sections 2, 4.2, 4.4, 4.6, 4.7
 *   - ref-en.txt sections 1, 2, 4
 *
 * Severity model:
 *   error   -> the output violates a hard format rule; trigger a repair pass
 *   warning -> likely wrong or worth a human look; never blocks
 */
import { DURATION_MAX, DURATION_MIN, MODE_FAMILY } from "./prompts.js";

const BASE_FIELDS = ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
const REF_SECTIONS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
];

/** Locate a top-level "field:" style section inside a prompt blob. */
function sectionText(prompt, field) {
  const idx = prompt.indexOf(field);
  if (idx === -1) return "";
  return prompt.slice(idx + field.length).replace(/^:\s*/, "");
}

function isOrdered(prompt, fields) {
  let cursor = -1;
  for (const f of fields) {
    const idx = prompt.indexOf(f);
    if (idx === -1) return { ok: false, missing: f };
    if (idx < cursor) return { ok: false, outOfOrder: f };
    cursor = idx;
  }
  return { ok: true };
}

/**
 * @param {object} out parsed model JSON
 * @returns {{ errors: string[], warnings: string[], stats: object }}
 */
export function validateOutput(out) {
  const errors = [];
  const warnings = [];
  const stats = {};

  if (!out || typeof out !== "object") {
    return { errors: ["输出不是 JSON 对象。"], warnings, stats };
  }

  const mode = String(out.mode ?? "").trim();
  const duration = Number(out.duration_sec);
  const prompt = typeof out.prompt === "string" ? out.prompt : "";
  const family = MODE_FAMILY[mode];

  if (!family) {
    errors.push(`mode 缺失或非法："${mode}"。必须是 T2VA / I2VA / FL2VA / L2VA / Ref2VA 之一。`);
  }
  if (!prompt.trim()) errors.push("prompt 为空。");
  if (!Number.isFinite(duration) || duration < DURATION_MIN || duration > DURATION_MAX) {
    errors.push(`duration_sec 必须是 ${DURATION_MIN}-${DURATION_MAX} 之间的数字，当前为 "${out.duration_sec}"。`);
  }
  stats.durationSec = Number.isFinite(duration) ? duration : null;
  stats.mode = mode;
  stats.family = family ?? "unknown";
  stats.words = prompt ? prompt.trim().split(/\s+/).length : 0;
  stats.chars = prompt.length;

  if (!prompt.trim()) return { errors, warnings, stats };

  // --- family vs. content consistency -------------------------------------
  const looksRef = prompt.includes("subject_definitions") || prompt.includes("retention_analysis");
  const looksBase = prompt.includes("integrated_multimodal_description");
  if (family === "base") {
    if (looksRef) {
      errors.push("mode 声明为基础模式，但 prompt 里出现了 subject_definitions/retention_analysis（那是 Ref2VA 六段式）。");
    }
    if (!looksBase) errors.push("基础模式的 prompt 里没有 integrated_multimodal_description 字段。");
    const order = isOrdered(prompt, BASE_FIELDS);
    if (!order.ok && order.missing) errors.push(`基础模式缺少必需字段：${order.missing}。`);
    if (!order.ok && order.outOfOrder) {
      errors.push(`基础模式字段顺序错误：${order.outOfOrder} 出现位置不对，必须按 base-en.txt 的顺序。`);
    }
  }
  if (family === "ref") {
    if (looksBase && !prompt.includes("detailed_description")) {
      errors.push("mode 声明为 Ref2VA，但 prompt 缺少 detailed_description（Ref2VA 必须用六段式）。");
    }
    const order = isOrdered(prompt, REF_SECTIONS);
    if (!order.ok && order.missing) errors.push(`Ref2VA 缺少必需小节：${order.missing}。`);
    if (!order.ok && order.outOfOrder) {
      errors.push(`Ref2VA 小节顺序错误：${order.outOfOrder} 必须严格按 ref-en.txt 的六段顺序。`);
    }
  }

  // --- keyframe alignment instruction --------------------------------------
  const opening = prompt.trimStart().slice(0, 400);
  const alignmentPatterns = {
    I2VA: /For the target video, at 0\.00 seconds into the target video,\s*<Picture 1>\s*\(from \[Shot 1\]\) is fully referenced\./,
    FL2VA: /How the reference pictures align with the target video/,
    L2VA: /How the reference pictures align with the target video/,
  };
  if (family === "base" && mode !== "T2VA") {
    const pattern = alignmentPatterns[mode];
    if (pattern && !pattern.test(opening)) {
      errors.push(`${mode} 的 prompt 第一行必须是官方规定的关键帧对齐指令，当前开头是："${opening.slice(0, 80)}..."`);
    }
  }
  if (mode === "T2VA" && /How the reference pictures align|is fully referenced/.test(opening)) {
    warnings.push("T2VA 不应包含关键帧对齐指令（没有参考图）。");
  }

  // --- shot timeline -------------------------------------------------------
  const shots = [...prompt.matchAll(/\[Shot (\d+)\]/g)].map((m) => Number(m[1]));
  const uniqueShots = [...new Set(shots)];
  stats.shotCount = uniqueShots.length;
  if (uniqueShots.length) {
    if (uniqueShots[0] !== 1) warnings.push(`第一个分镜编号是 [Shot ${uniqueShots[0]}]，应为 [Shot 1]。`);
    for (let i = 0; i < uniqueShots.length; i += 1) {
      if (uniqueShots[i] !== i + 1) {
        warnings.push(`分镜编号不连续：期望 [Shot ${i + 1}]，实际出现 [Shot ${uniqueShots[i]}]。`);
        break;
      }
    }
  }
  const declaredShots = Number(out.shot_count);
  if (Number.isFinite(declaredShots) && uniqueShots.length && declaredShots !== uniqueShots.length) {
    warnings.push(`shot_count 声明为 ${declaredShots}，但 prompt 里出现 ${uniqueShots.length} 个分镜。`);
  }

  // Cut times: [Shot N] At MM:SS.mmm,
  const cuts = [...prompt.matchAll(/\[Shot (\d+)\]\s*At\s+(\d{1,2}):(\d{2})\.(\d{3})/g)].map((m) => ({
    shot: Number(m[1]),
    seconds: Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
  }));
  stats.cutCount = cuts.length;
  let prev = -1;
  for (const cut of cuts) {
    if (cut.seconds <= prev) {
      errors.push(`切镜时间未严格递增：[Shot ${cut.shot}] 的时间 ${cut.seconds.toFixed(3)}s 不大于前一个切点。`);
      break;
    }
    prev = cut.seconds;
  }
  const limit = Number.isFinite(duration) ? duration : DURATION_MAX;
  const tooLate = cuts.find((c) => c.seconds >= limit - 0.001);
  if (tooLate) {
    errors.push(
      `切镜时间 ${tooLate.seconds.toFixed(3)}s 落在视频时长 ${limit}s 之外（必须小于总时长）。`,
    );
  }
  // A single-shot prompt must not carry a timestamp.
  if (uniqueShots.length === 1 && cuts.length === 0) {
    const firstShotHeader = prompt.match(/\[Shot 1\]([^\[]*)/);
    if (firstShotHeader && /\bAt\s+\d{1,2}:\d{2}/.test(firstShotHeader[1].slice(0, 40))) {
      errors.push("[Shot 1] 不应带时间戳，时间戳只用于后续切镜。");
    }
  }

  // --- reference labels ----------------------------------------------------
  const defined = new Set();
  for (const m of prompt.matchAll(/<(Subject|Picture|Video|Audio) (\d+)>/g)) {
    defined.add(`${m[1]} ${m[2]}`);
  }
  stats.referenceLabels = [...defined].map((d) => `<${d}>`);
  if (family === "ref" && defined.size === 0) {
    errors.push("Ref2VA 输出里没有任何参考标签（<Subject N> / <Picture N> / <Video N> / <Audio N>）。");
  }
  if (out.plan_missing_labels) warnings.push(String(out.plan_missing_labels));
  const declaredLabels = Array.isArray(out.reference_labels) ? out.reference_labels : null;
  if (declaredLabels) {
    for (const label of declaredLabels) {
      const norm = String(label).replace(/[<>]/g, "");
      if (!defined.has(norm)) warnings.push(`声明了参考标签 <${norm}>，但 prompt 正文里没有用到。`);
    }
  }
  // In ref mode every label must be introduced in subject_definitions.
  if (family === "ref" && prompt.includes("subject_definitions")) {
    const defBlock = sectionText(prompt, "subject_definitions").split(/\n\s*\n/)[0];
    for (const label of defined) {
      if (!defBlock.includes(`<${label}>`)) {
        warnings.push(`<${label}> 出现在正文但未在 subject_definitions 中定义。`);
      }
    }
  }

  // --- dialogue ------------------------------------------------------------
  const dialogues = [...prompt.matchAll(/<d>([\s\S]*?)<\/d>/g)].map((m) => m[1]);
  stats.dialogueCount = dialogues.length;
  for (const d of dialogues) {
    if (!/^\s*\[[^\]]+\]/.test(d)) {
      errors.push(`台词缺少语言标签：<d>${d.slice(0, 60)}</d> 必须以 <d>[Language] 开头。`);
      break;
    }
  }
  const speakerIds = [...new Set([...prompt.matchAll(/\((S\d+(?:,S\d+)*)\)/g)].map((m) => m[1]))];
  stats.speakerIds = speakerIds;
  if (dialogues.length > 0 && speakerIds.length === 0) {
    warnings.push("存在 <d> 台词，但没有出现任何 (Sx) 说话人编号。");
  }
  if (family === "ref" && /retention_analysis/.test(prompt)) {
    const retention = sectionText(prompt, "retention_analysis").split(/detailed_description/)[0];
    if (/\(S\d+\)/.test(retention)) {
      warnings.push("retention_analysis 中不应出现 (Sx) 说话人编号（见 ref-en.txt 5.4）。");
    }
  }

  // --- audio sections ------------------------------------------------------
  if (prompt.includes("overall_soundscape") && prompt.includes("non_diegetic_music")) {
    const soundscape = sectionText(prompt, "overall_soundscape");
    if (/<d>/.test(soundscape)) warnings.push("overall_soundscape 里不应重复台词（台词属于主描述）。");
  }

  // --- style realism -------------------------------------------------------
  if (family === "ref" && Number.isFinite(duration) && stats.words < 250) {
    warnings.push(`detailed_description 整体偏短（${stats.words} 词），ref-en.txt 建议生成类任务写到 350-500 词。`);
  }
  if (family === "base" && stats.words < 80) {
    warnings.push(`基础模式描述偏短（${stats.words} 词），可能缺少构图/动作/声音细节。`);
  }

  return { errors, warnings, stats };
}

export const __testing = { sectionText, isOrdered };
