/**
 * The generation pipeline.
 *
 *   intake -> [plan] -> generate -> extract -> validate -> [repair] -> result
 *
 * Design decisions worth knowing:
 *  - Mode selection is a MODEL task, not a regex guess. Classifying I2VA vs.
 *    Ref2VA (is this picture the actual first frame, or a look/storyboard
 *    reference?) needs to see the image; a keyword rule would get it wrong.
 *  - The guide layer is chosen AFTER classification, so a Ref2VA request never
 *    pays the token cost of the base guide and vice versa.
 *  - Validation failures feed a repair pass instead of failing the request.
 *  - There is no silent fallback to a synthetic prompt. If the model is wrong,
 *    we surface it.
 */
import { chatComplete, chatStream, buildUserContent, LLMError } from "./llm.js";
import {
  buildPlanSystemPrompt,
  buildPlanUserMessage,
  buildSystemPrompt,
  buildGenerateUserMessage,
  buildRepairUserMessage,
  loadSkill,
  MODE_FAMILY,
  MODES,
  DURATION_MAX,
  DURATION_MIN,
} from "./prompts.js";
import { extractJson } from "./json-extract.js";
import { validateOutput } from "./validate.js";
import { parseImages } from "./images.js";

function repairList(problems) {
  return problems.slice(0, 12);
}

async function completeJson(config, { system, messages, model, signal, label }) {
  const res = await chatComplete(config, {
    messages: [{ role: "system", content: system }, ...messages],
    model,
    signal,
  });
  const parsed = extractJson(res.text);
  if (!parsed.ok) {
    const err = new Error(`${label} 阶段返回的不是可解析的 JSON：${parsed.error}`);
    err.raw = res.text;
    err.usage = res.usage;
    throw err;
  }
  return { value: parsed.value, strategy: parsed.strategy, usage: res.usage, raw: res.text };
}

/**
 * @param {object} config resolved runtime config
 * @param {object} payload { text, images, ratio, durationSec, mode, deepDive }
 * @param {AbortSignal} [signal]
 * @yields {{type: string, [key: string]: any}}
 */
export async function* runGeneration(config, payload, signal) {
  const started = Date.now();
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const addUsage = (u) => {
    if (!u) return;
    usage.prompt_tokens += Number(u.prompt_tokens ?? 0) || 0;
    usage.completion_tokens += Number(u.completion_tokens ?? 0) || 0;
    usage.total_tokens += Number(u.total_tokens ?? 0) || 0;
  };

  const skill = loadSkill();
  yield { type: "stage", stage: "intake", message: "正在解析输入与校验图片" };

  const text = String(payload?.text ?? "");
  if (!text.trim() && !(payload?.images ?? []).length) {
    yield { type: "error", message: "请至少提供小说/分镜文字，或上传一张参考图。" };
    return;
  }

  let images = [];
  let imageWarnings = [];
  try {
    ({ images, warnings: imageWarnings } = parseImages(payload?.images));
  } catch (err) {
    yield { type: "error", message: err.message };
    return;
  }

  const requestedDuration = Number(payload?.durationSec) || 0;
  if (requestedDuration && (requestedDuration < DURATION_MIN || requestedDuration > DURATION_MAX)) {
    yield { type: "error", message: `目标时长必须是 ${DURATION_MIN}-${DURATION_MAX} 秒。H3 单次生成上限为 15 秒。` };
    return;
  }
  let ratio = String(payload?.ratio ?? "").trim();
  let durationSec = requestedDuration;
  let mode = String(payload?.mode ?? "auto").trim();
  let plan = null;

  // The OpenAI-compatible adapter may force a mode (NewAPI image channels, or an
  // explicit directive in the caller's text). An explicit request outranks the planner.
  const forcedMode = String(payload?.forcedMode ?? "").trim();
  const forcedBy = String(payload?.forcedBy ?? "").trim();
  if (MODES.includes(forcedMode)) {
    mode = forcedMode;
  }

  const deepDive = payload?.deepDive ?? config.deepDive;

  // Tell the model about decisions that were made outside its own judgement, so it
  // does not contradict them in the output.
  const directives = [];
  if (MODES.includes(forcedMode)) directives.push(`模式已被调用方指定为 ${forcedMode}${forcedBy ? `（${forcedBy}）` : ""}`);
  if (requestedDuration) directives.push(`用户指定时长 ${requestedDuration} 秒`);
  if (payload?.ratio) directives.push(`用户指定画幅 ${payload.ratio}`);
  const systemHint = [String(payload?.systemHint ?? "").trim(), directives.length ? `硬性要求：${directives.join("；")}。` : ""]
    .filter(Boolean)
    .join("\n\n");

  for (const w of imageWarnings) yield { type: "warning", message: w };
  yield {
    type: "intake",
    images: images.map(({ index, name, mime, width, height, bytes }) => ({ index, name, mime, width, height, bytes })),
    skill: skill.info,
  };

  // ---------------------------------------------------------------- planning
  if (!deepDive) {
    yield { type: "stage", stage: "plan", message: `正在分析素材并判定模式（${config.plannerModel}）` };
    try {
      const planSystem = buildPlanSystemPrompt(config.plannerModel);
      const planUser = buildPlanUserMessage({ text, images, ratio, durationSec, systemHint });
      const planRes = await completeJson(config, {
        system: planSystem,
        messages: [{ role: "user", content: buildUserContent({ text: planUser, images }) }],
        model: config.plannerModel,
        signal,
        label: "规划",
      });
      plan = planRes.value;
      addUsage(planRes.usage);
      yield { type: "plan", plan, strategy: planRes.strategy };
    } catch (err) {
      yield {
        type: "warning",
        message: `规划阶段失败（${err.message}），将退化为一次性生成，模式由生成阶段自行判定。`,
      };
      plan = null;
    }
  } else {
    yield { type: "stage", stage: "plan", message: "深度模式：跳过独立规划，一次性完成分析与改写" };
  }

  if (plan) {
    const planMode = String(plan.mode ?? "").trim();
    // A caller-forced mode is not overridden by the planner's own guess.
    if (mode === "auto" && MODES.includes(planMode)) mode = planMode;
    if (!durationSec && Number(plan.duration_sec) >= DURATION_MIN && Number(plan.duration_sec) <= DURATION_MAX) {
      durationSec = Number(plan.duration_sec);
    }
    if (!ratio && plan.ratio) ratio = String(plan.ratio);
    const confidence = Number(plan.confidence);
    if (Number.isFinite(confidence) && confidence < 0.55) {
      yield {
        type: "warning",
        message: `模式判定置信度偏低（${confidence}）：${plan.mode_reason ?? ""}。如果不符预期，请在上方手动指定模式后重跑。`,
      };
    }
    if (Array.isArray(plan.unspecified) && plan.unspecified.length) {
      yield { type: "warning", message: `以下信息用户未交代，已按合理方式补全：${plan.unspecified.join("；")}` };
    }
  }

  if (mode === "auto" || !MODES.includes(mode)) {
    // No plan and no explicit mode: fall back to the cheapest correct guess and say so.
    mode = images.length ? "I2VA" : "T2VA";
    if (images.length) {
      yield {
        type: "warning",
        message: `无法自动判定模式，已按 I2VA 处理（把第 1 张图当作首帧）。如果这只是一张形象/风格参考图，请手动选择 Ref2VA 重跑。`,
      };
    }
  }

  const family = MODE_FAMILY[mode];
  const targetDuration = durationSec || DURATION_MAX;
  yield {
    type: "stage",
    stage: "generate",
    message: `正在按官方 ${family === "ref" ? "ref-en.txt 六段式" : "base-en.txt"} 规范改写为 ${mode} 提示词`,
    mode,
    family,
    durationSec: targetDuration,
    ratio,
  };

  const system = buildSystemPrompt(family, config.model);
  const userMessage = buildGenerateUserMessage({ text, images, plan, ratio, durationSec: targetDuration, systemHint });

  /**
   * One generation attempt, as an async generator so it can forward stream deltas.
   * `yield*` delegates to it and resolves to the accumulated raw text.
   */
  async function* attempt(extraMessages) {
    const messages = [{ role: "user", content: buildUserContent({ text: userMessage, images }) }, ...extraMessages];
    let raw = "";
    let stageUsage = null;
    for await (const evt of chatStream(config, {
      messages: [{ role: "system", content: system }, ...messages],
      model: config.model,
      signal,
    })) {
      if (evt.delta) {
        raw += evt.delta;
        yield { type: "delta", text: evt.delta };
      }
      if (evt.usage) stageUsage = evt.usage;
    }
    addUsage(stageUsage);
    return raw;
  }

  let raw = "";
  try {
    raw = yield* attempt([]);
  } catch (err) {
    yield { type: "error", message: err instanceof LLMError ? err.message : `生成失败：${err.message}` };
    return;
  }

  let parsed = extractJson(raw);
  let validation = parsed.ok ? validateOutput(parsed.value) : null;
  let repairs = 0;

  const maxRepairs = Number(config.repairPasses ?? 1);
  while ((!parsed.ok || validation.errors.length) && repairs < maxRepairs) {
    repairs += 1;
    const problems = parsed.ok ? repairList(validation.errors) : [`JSON 解析失败：${parsed.error}`];
    yield { type: "stage", stage: "repair", message: `校验未通过，正在自动修复（第 ${repairs} 次）`, problems };
    try {
      raw = yield* attempt([
        { role: "assistant", content: String(raw).slice(0, 60000) },
        { role: "user", content: buildRepairUserMessage({ raw, problems }) },
      ]);
    } catch (err) {
      yield { type: "error", message: `修复阶段失败：${err.message}` };
      return;
    }
    parsed = extractJson(raw);
    validation = parsed.ok ? validateOutput(parsed.value) : null;
  }

  if (!parsed.ok) {
    yield {
      type: "error",
      message: `模型连续 ${1 + repairs} 次未返回合法 JSON（${parsed.error}）。可尝试换用更强的模型，或开启「深度模式」。`,
      raw: String(raw).slice(0, 20000),
    };
    return;
  }

  const out = parsed.value;
  // A caller-forced mode wins over whatever the model claimed, so the metadata the
  // caller sees always matches the format that was actually requested.
  const finalMode = MODES.includes(forcedMode)
    ? forcedMode
    : MODES.includes(String(out.mode))
      ? String(out.mode)
      : mode;

  yield {
    type: "result",
    result: {
      mode: finalMode,
      family: MODE_FAMILY[finalMode] ?? family,
      durationSec: Number(out.duration_sec) || targetDuration,
      ratio: String(out.ratio ?? ratio ?? ""),
      shotCount: Number(out.shot_count) || validation.stats.shotCount || 0,
      prompt: String(out.prompt ?? ""),
      notesZh: String(out.notes_zh ?? ""),
      speakMap: Array.isArray(out.speak_map) ? out.speak_map : [],
      validation: { errors: validation.errors, warnings: validation.warnings, stats: validation.stats },
      plan,
      extraction: parsed.strategy,
      repairs,
      forcedMode: MODES.includes(forcedMode) ? forcedMode : null,
      forcedBy: MODES.includes(forcedMode) ? forcedBy || null : null,
    },
    usage,
    elapsedMs: Date.now() - started,
  };
}
