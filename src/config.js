/**
 * Runtime configuration: provider presets, env-var discovery, local overrides.
 *
 * Design note: the model must be multimodal (vision) because the H3 skill needs to
 * inspect reference images to fill <Picture N> definitions and keyframe anchors.
 */
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Where config.local.json lives. Overridable because a container may run with a
 * read-only application filesystem, with the writable state on a mounted volume.
 */
const CONFIG_DIR = process.env.H3_CONFIG_DIR
  ? path.resolve(process.env.H3_CONFIG_DIR)
  : ROOT;
const CONFIG_FILE = path.join(CONFIG_DIR, "config.local.json");

/**
 * Provider presets. Every one of these speaks the OpenAI /chat/completions
 * protocol, so a single client implementation covers all of them.
 * `envKey` lists the environment variable names checked, in priority order.
 */
export const PROVIDER_PRESETS = {
  newapi: {
    label: "NewAPI / OneAPI 中转站（第三方算力）",
    baseUrl: "http://localhost:3000/v1",
    envKey: ["NEWAPI_API_KEY", "H3_UPSTREAM_API_KEY", "ONEAPI_API_KEY"],
    visionModel: "qwen-vl-max",
    altModels: ["gpt-4o", "gemini-2.0-flash", "claude-3-5-sonnet"],
    hint: "把 baseUrl 改成你的 NewAPI 地址（记得带 /v1），Key 用 NewAPI 的令牌 sk-xxx。模型名要填 NewAPI 里真实可用的、且支持图片的模型。",
  },
  minimax: {
    label: "MiniMax 开放平台（与 H3 同厂，推荐）",
    baseUrl: "https://api.minimaxi.com/v1",
    envKey: ["MINIMAX_API_KEY", "MINIMAX_GROUP_ID"],
    visionModel: "MiniMax-M2",
    altModels: ["MiniMax-Text-01", "abab6.5s-chat"],
    hint: "国内站 api.minimaxi.com；海外站 api.minimax.io。M2 为多模态模型。",
  },
  qwen: {
    label: "阿里云通义千问 DashScope（视觉能力强）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    envKey: ["DASHSCOPE_API_KEY", "QWEN_API_KEY", "ALIYUN_API_KEY"],
    visionModel: "qwen-vl-max-latest",
    altModels: ["qwen-vl-plus", "qwen3-vl-plus"],
    hint: "兼容模式 endpoint 必须带 /compatible-mode/v1。",
  },
  zhipu: {
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    envKey: ["ZHIPUAI_API_KEY", "GLM_API_KEY", "ZHIPU_API_KEY"],
    visionModel: "glm-4v-plus",
    altModels: ["glm-4v", "glm-4.5v"],
    hint: "GLM-4V 系列支持图片输入。",
  },
  moonshot: {
    label: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    envKey: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    visionModel: "moonshot-v1-32k-vision-preview",
    altModels: ["moonshot-v1-8k-vision-preview"],
    hint: "需选用带 vision 的模型名才能读图。",
  },
  siliconflow: {
    label: "硅基流动 SiliconFlow（一个 Key 多用模型）",
    baseUrl: "https://api.siliconflow.cn/v1",
    envKey: ["SILICONFLOW_API_KEY", "SF_API_KEY"],
    visionModel: "Qwen/Qwen2.5-VL-72B-Instruct",
    altModels: ["Qwen/Qwen2.5-VL-32B-Instruct"],
    hint: "模型名是完整路径形式。",
  },
  deepseek: {
    label: "DeepSeek（注意：不支持图片输入）",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: ["DEEPSEEK_API_KEY"],
    visionModel: "deepseek-chat",
    altModels: ["deepseek-reasoner"],
    hint: "纯文本模型，图片会被忽略。你的分镜+图片场景不建议用它。",
    textOnly: true,
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    envKey: ["OPENAI_API_KEY"],
    visionModel: "gpt-4o",
    altModels: ["gpt-4o-mini", "gpt-4.1"],
    hint: "需要能访问 api.openai.com 的网络环境。",
  },
  custom: {
    label: "自定义 OpenAI 兼容服务",
    baseUrl: "",
    envKey: ["OPENAI_API_KEY", "LLM_API_KEY", "API_KEY"],
    visionModel: "",
    altModels: [],
    hint: "任何兼容 /chat/completions 的服务，例如 vLLM、Ollama（http://localhost:11434/v1）、One-API。",
  },
};

/**
 * First non-empty value wins.
 *
 * Accepts numbers and booleans as well as strings: values loaded from
 * config.local.json are real JSON types, so `repairPasses: 2` arrives as a number.
 * Only a bare `typeof v === "string"` check would silently drop it and fall back to
 * the default, which is how a saved setting can appear not to apply.
 */
function nonEmpty(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "boolean") return v;
  }
  return "";
}

/** Read persisted local overrides, tolerating a missing or corrupt file. */
function readLocalFile() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function detectProviderFromEnv() {
  for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (id === "custom") continue;
    if (nonEmpty(...preset.envKey.map((k) => process.env[k]))) return id;
  }
  if (nonEmpty(process.env.LLM_BASE_URL)) return "custom";
  return "";
}

/**
 * Coerce a numeric setting.
 *
 * Written out rather than using `Number(x || fallback)`, which silently discards a
 * legitimate 0 (repairPasses = 0 means "no repair passes" and must survive a round
 * trip through the config API).
 */
function toNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve the effective runtime config.
 * Precedence: local file (saved from the UI) > environment > preset default.
 */
export function loadConfig() {
  const local = readLocalFile();
  const envProvider = detectProviderFromEnv();
  const providerId = nonEmpty(local.provider, envProvider, "custom");
  const preset = PROVIDER_PRESETS[providerId] || PROVIDER_PRESETS.custom;

  const envApiKey = nonEmpty(...preset.envKey.map((k) => process.env[k]));
  const envBaseUrl = nonEmpty(...preset.envKey.map((k) => process.env[`${k}_BASE_URL`]));
  const sharedBaseUrl = nonEmpty(
    // Provider-specific first, then the generic OpenAI-compatible variables.
    process.env.H3_UPSTREAM_BASE_URL,
    process.env.LLM_BASE_URL,
    process.env.OPENAI_BASE_URL,
    process.env.OPENAI_API_BASE,
  );

  const model = nonEmpty(local.model, process.env.LLM_MODEL, process.env.OPENAI_MODEL, preset.visionModel);
  const plannerModel = nonEmpty(local.plannerModel, process.env.LLM_PLANNER_MODEL, model);

  return {
    provider: providerId,
    providerLabel: preset.label,
    baseUrl: nonEmpty(local.baseUrl, envBaseUrl, sharedBaseUrl, preset.baseUrl),
    apiKey: nonEmpty(local.apiKey, envApiKey),
    model,
    plannerModel,
    // Kept so the UI can warn before the user wastes a call.
    textOnlyProvider: Boolean(preset.textOnly),
    requestTimeoutMs: toNumber(
      nonEmpty(local.requestTimeoutMs, process.env.LLM_TIMEOUT_MS),
      180000,
      { min: 1000, max: 3600000 },
    ),
    // 0 is a meaningful value here ("never retry"), so it must not be replaced.
    repairPasses: toNumber(nonEmpty(local.repairPasses, process.env.LLM_REPAIR_PASSES), 1, { min: 0, max: 5 }),
    deepDive: Boolean(local.deepDive),
    apiKeySource: nonEmpty(local.apiKey) ? "saved" : envApiKey ? "env" : "none",
    savedPath: CONFIG_FILE,
    // --- inbound (this server acting as an OpenAI-compatible model) ---
    // When empty, /v1/* is left open. Set H3_SERVER_API_KEY before exposing the
    // service beyond localhost, otherwise anyone can spend your upstream quota.
    serverApiKey: nonEmpty(local.serverApiKey, process.env.H3_SERVER_API_KEY),
    publicModelId: nonEmpty(local.publicModelId, process.env.H3_MODEL_ID, "h3-prompt-writing"),
    // --- web UI login ---
    // Only the HASH is ever persisted. H3_WEB_PASSWORD is an optional startup override
    // so a deployment can keep the plaintext out of the config file entirely.
    webUsername: nonEmpty(local.webUsername, process.env.H3_WEB_USERNAME, "admin"),
    webPasswordHash: nonEmpty(local.webPasswordHash),
    webPasswordOverride: nonEmpty(process.env.H3_WEB_PASSWORD),
  };
}

/** True when the current process is a test runner rather than the real service. */
function isTestProcess() {
  return process.argv.includes("--test") || process.env.NODE_TEST_CONTEXT !== undefined;
}

/**
 * Refuse to persist configuration from a test process unless the config directory has
 * explicitly been pointed at a throwaway location.
 *
 * This is the last line of defence, and it exists because it kept happening: a test
 * that imported this module before redirecting H3_CONFIG_DIR would overwrite the
 * developer's real config.local.json, silently changing their saved model. Test
 * isolation is set up in test/setup.mjs; this guard makes a mistake there loud instead
 * of destructive.
 */
function assertWritableConfig() {
  if (process.env.H3_ALLOW_CONFIG_WRITE === "1") return;
  if (!isTestProcess()) return;
  const dir = String(process.env.H3_CONFIG_DIR ?? "");
  if (/tmp-test-config|h3-test-config|h3cfg/i.test(dir)) return;
  throw new Error(
    "拒绝从测试进程写入真实配置：H3_CONFIG_DIR 未指向临时目录。" +
      "请通过 `npm test` 运行（它会加载 test/setup.mjs 完成隔离）。",
  );
}

/** Write overrides to config.local.json. Passing null/"" for a field clears it. */
export function saveConfig(patch = {}) {
  assertWritableConfig();
  const local = readLocalFile();
  const allowed = [
    "provider",
    "baseUrl",
    "apiKey",
    "model",
    "plannerModel",
    "requestTimeoutMs",
    "repairPasses",
    "deepDive",
    "serverApiKey",
    "publicModelId",
    // webUsername is configurable; the password is only ever written as a hash.
    "webUsername",
    "webPasswordHash",
  ];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === "") delete local[key];
    else local[key] = value;
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(local, null, 2) + "\n", "utf8");
  return loadConfig();
}

/**
 * Curated models offered as one-click switches in the UI.
 *
 * Why the indirection instead of plain model ids: relay deployments rename and retire
 * models constantly (`gemini-3.1-pro-preview` is a dated alias that will disappear).
 * Each entry therefore carries a stable label plus an ordered list of concrete model
 * ids to try, and the UI shows whether the upstream actually advertises it.
 *
 * `vision: false` entries exist to be shown honestly: picking one degrades the
 * image-driven modes, and the UI says so instead of failing mysteriously.
 */
export const CURATED_MODELS = [
  {
    id: "gemini",
    label: "Gemini 3.1 Pro",
    hint: "综合最稳，读图强，适合 Ref2VA 六段式",
    vision: true,
    candidates: ["gemini-3.1-pro-preview", "gemini-3.1-pro", "gemini-3-pro-preview", "gemini-3.8-flash"],
  },
  {
    id: "gpt",
    label: "GPT-6 Astra",
    hint: "指令遵循好，长提示词结构稳定",
    vision: true,
    candidates: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5"],
  },
  {
    id: "claude",
    label: "Claude Opus 4.8",
    hint: "文笔与细节描写最强，适合文学化改写",
    vision: true,
    candidates: ["claude-opus-4-8", "claude-opus-4", "claude-sonnet-4"],
  },
  {
    id: "deepseek",
    label: "DeepSeek V4.1 Flash",
    hint: "最便宜最快；能读图，但只支持流式",
    vision: true,
    candidates: ["deepseek-v4.1-flash", "deepseek-v4.1", "deepseek-chat"],
  },
];

/** How long an upstream /v1/models answer is reused. */
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
let modelCache = { at: 0, key: "", allowed: [], error: "" };

/**
 * Ask the configured upstream which models it serves.
 *
 * Deliberately tolerant: a relay that blocks /v1/models or returns junk yields an
 * empty list and an error string, never a thrown error — the UI falls back to the
 * curated names.
 */
export async function listUpstreamModels(config, { force = false } = {}) {
  const key = `${config.baseUrl}|${config.apiKey ? "k" : ""}`;
  if (!force && modelCache.key === key && Date.now() - modelCache.at < MODEL_CACHE_TTL_MS) {
    return { models: modelCache.allowed, error: modelCache.error, cached: true };
  }

  let models = [];
  let error = "";
  if (!config.baseUrl || !config.apiKey) {
    error = "未配置 baseUrl 或 API Key";
  } else {
    try {
      const res = await fetch(`${String(config.baseUrl).replace(/\/+$/, "")}/models`, {
        headers: { authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        error = `上游 /models 返回 HTTP ${res.status}`;
      } else {
        const body = await res.json();
        models = (body?.data ?? [])
          .map((m) => (typeof m === "string" ? m : m?.id))
          .filter((id) => typeof id === "string" && id);
      }
    } catch (err) {
      error = `无法访问上游 /models：${err.message}`;
    }
  }

  modelCache = { at: Date.now(), key, allowed: models, error };
  return { models, error, cached: false };
}

/** Turn the curated catalogue into UI rows, marking upstream availability. */
export function describeCuratedModels(upstreamIds) {
  const available = new Set(upstreamIds ?? []);
  const known = available.size > 0;
  return CURATED_MODELS.map((entry) => {
    const resolved = entry.candidates.find((c) => available.has(c)) ?? entry.candidates[0];
    return {
      id: entry.id,
      label: entry.label,
      hint: entry.hint,
      vision: entry.vision,
      model: resolved,
      // null means "cannot tell" (upstream list unavailable), not "missing".
      available: known ? available.has(resolved) : null,
      candidates: entry.candidates,
    };
  });
}

/**
 * Pick a usable model id for a curated entry, preferring one the upstream advertises.
 * @returns {{ model: string, usedFallback: boolean, candidates: string[] }}
 */
export function resolveCuratedModel(entryId, upstreamIds) {
  const entry = CURATED_MODELS.find((e) => e.id === entryId);
  if (!entry) return null;
  const available = new Set(upstreamIds ?? []);
  const known = available.size > 0;
  const hit = known ? entry.candidates.find((c) => available.has(c)) : entry.candidates[0];
  const model = hit ?? entry.candidates[0];
  return { model, usedFallback: known && !hit, candidates: entry.candidates, label: entry.label };
}

/**
 * Which curated entry the current model corresponds to, if any.
 * Used by the UI to highlight the active quick-switch button.
 */
export function matchCuratedModel(model) {
  const current = String(model ?? "");
  if (!current) return null;
  for (const entry of CURATED_MODELS) {
    if (entry.candidates.includes(current)) return entry.id;
  }
  return null;
}

/**
 * Switch models from the UI.
 *
 * A model id can be given directly, or a curated entry id can be resolved against the
 * upstream catalogue — falling through the entry's candidate list so a retired dated
 * alias does not break the switch.
 *
 * Validates BEFORE persisting: rejecting after the write would leave a broken model in
 * config.local.json while telling the caller the switch failed.
 *
 * @param {{ entryId?: string, model?: string, plannerModel?: string, upstreamIds?: string[] }} choice
 */
export function saveModelChoice(choice = {}) {
  const patch = {};

  if (choice.entryId) {
    const resolved = resolveCuratedModel(choice.entryId, choice.upstreamIds);
    if (!resolved) throw new Error(`未知的模型预设：${choice.entryId}`);
    patch.model = resolved.model;
  } else if (choice.model !== undefined) {
    const model = String(choice.model).trim();
    // An explicit but blank model is a caller mistake, not a request to clear it.
    // Falling back to the environment here would silently hide the bug.
    if (!model) throw new Error("模型名不能为空。");
    patch.model = model;
  }

  if (choice.plannerModel !== undefined) {
    patch.plannerModel = String(choice.plannerModel).trim();
  }

  return { config: saveConfig(patch), patch };
}

/** Strip the secret before anything reaches the browser. */
export function publicConfig(config) {
  return {
    provider: config.provider,
    providerLabel: config.providerLabel,
    baseUrl: config.baseUrl,
    model: config.model,
    plannerModel: config.plannerModel,
    // Which quick-switch button should look active, and whether the upstream
    // advertises the model we are about to use.
    curatedModelId: matchCuratedModel(config.model),
    apiKeySource: config.apiKeySource,
    hasApiKey: Boolean(config.apiKey),
    textOnlyProvider: config.textOnlyProvider,
    requestTimeoutMs: config.requestTimeoutMs,
    repairPasses: config.repairPasses,
    deepDive: config.deepDive,
    publicModelId: config.publicModelId,
    // Never the value itself; only whether inbound /v1/* calls are protected.
    hasServerApiKey: Boolean(config.serverApiKey),
    // Login state for the UI. The hash itself never leaves the server.
    webUsername: config.webUsername,
    webLoginEnabled: Boolean(config.webPasswordHash || config.webPasswordOverride),
    savedPath: path.relative(ROOT, config.savedPath).replace(/\\/g, "/"),
  };
}
