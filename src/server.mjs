/**
 * Zero-dependency HTTP server.
 *
 * Endpoints
 *   GET    /                      -> the single-page UI
 *   GET    /api/health            -> liveness
 *   GET    /api/skill             -> loaded official skill metadata + hashes
 *   GET    /api/config            -> effective config, secrets stripped
 *   PUT    /api/config            -> persist provider/model/key overrides
 *   GET    /api/providers         -> preset catalogue for the settings panel
 *   POST   /api/generate          -> NDJSON event stream (the pipeline)
 *
 * Only Node built-ins are used, so there is nothing to install.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ROOT,
  PROVIDER_PRESETS,
  loadConfig,
  saveConfig,
  publicConfig,
  listUpstreamModels,
  describeCuratedModels,
  resolveCuratedModel,
  saveModelChoice,
  CURATED_MODELS,
} from "./config.js";
import { loadSkill, MODES, MODE_FAMILY, DURATION_MIN, DURATION_MAX, MAX_IMAGES } from "./prompts.js";
import { runGeneration } from "./generate.mjs";
import {
  authorize,
  chatCompletionResponse,
  createTextStreamer,
  corsPreflight,
  modelList,
  newCompletionId,
  openAiError,
  parseChatRequest,
} from "./openai-api.mjs";
import {
  SESSION_COOKIE,
  clearCookie,
  clearSessions,
  createSession,
  describeRequest,
  destroySession,
  getSession,
  hashPassword,
  shouldUseSecureCookie,
  loginAllowed,
  parseCookies,
  recordFailure,
  recordSuccess,
  sessionCookie,
  verifyPassword,
} from "./auth.mjs";

const WEB_DIR = path.join(ROOT, "web");
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES / 1048576}MB 上限。`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Resolve a URL path to a file inside web/, or null when it escapes or is absent. */
function resolveWebFile(urlPath) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const target = path.resolve(WEB_DIR, rel);
  // Path-traversal guard: the resolved file must stay inside web/.
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + path.sep)) return null;
  return fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;
}

/**
 * Send the app shell.
 *
 * `no-store` (not merely `no-cache`) so the browser cannot reuse a previously saved
 * copy at all. During development a cached shell repeatedly made a shipped fix look
 * like it had no effect, which is indistinguishable from a broken feature. The shell is
 * a few KB on a loopback/LAN link, so refusing to cache it costs nothing.
 */
function sendAppShell(res) {
  fs.readFile(path.join(WEB_DIR, "index.html"), (err, data) => {
    if (err) {
      sendJson(res, 500, { error: "index.html 缺失" });
      return;
    }
    res.writeHead(200, {
      "content-type": STATIC_TYPES[".html"],
      "cache-control": "no-store, no-cache, must-revalidate",
      pragma: "no-cache",
      expires: "0",
    });
    res.end(data);
  });
}

/**
 * Send one file from web/ with the right content type.
 *
 * Uses an ETag so the browser revalidates instead of blindly reusing a cached copy.
 * That matters here: a browser holding a pre-auth app.js has no login handler at all,
 * which presents as "the login button does nothing". `no-cache` alone was not enough —
 * it permits reuse without revalidation in some situations.
 */
function sendFile(req, res, target) {
  fs.readFile(target, (err, data) => {
    if (err) {
      sendAppShell(res);
      return;
    }
    const etag = `W/"${data.length.toString(16)}-${fs.statSync(target).mtimeMs.toString(16)}"`;
    res.setHeader("cache-control", "no-cache");
    res.setHeader("etag", etag);

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }

    res.writeHead(200, {
      "content-type": STATIC_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream",
      "content-length": data.length,
    });
    res.end(data);
  });
}

function serveStatic(req, res, urlPath) {
  const target = resolveWebFile(urlPath);
  // An unknown path falls back to the app shell (single page), never to a file outside
  // web/ — so a traversal attempt yields index.html rather than a leaked file.
  if (!target) {
    sendAppShell(res);
    return;
  }
  sendFile(req, res, target);
}

async function handleGenerate(req, res, config) {
  let payload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body || "{}");
  } catch (err) {
    sendJson(res, 400, { error: `请求体解析失败：${err.message}` });
    return;
  }

  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  // Disable Nagle so the UI sees progress promptly.
  res.socket?.setNoDelay(true);

  const controller = new AbortController();
  let finished = false;
  req.on("close", () => {
    if (!finished) controller.abort();
  });

  const send = (event) => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(JSON.stringify(event) + "\n");
    } catch {
      /* client went away mid-write */
    }
  };

  try {
    for await (const event of runGeneration(config, payload, controller.signal)) {
      send(event);
    }
  } catch (err) {
    if (err?.name === "AbortError" || controller.signal.aborted) {
      send({ type: "error", message: "请求已被取消。" });
    } else {
      send({ type: "error", message: `内部错误：${err.message}`, stack: err.stack?.slice(0, 2000) });
    }
  } finally {
    finished = true;
    if (!res.writableEnded) res.end();
  }
}

/* ---------------------------------------------------- web console auth - */

/**
 * Is this login attempt valid?
 *
 * H3_WEB_PASSWORD wins when set, so a deployment can keep the plaintext out of the
 * config file and rotate it by restarting. Otherwise the stored scrypt hash is used.
 */
function checkWebCredentials(config, username, password) {
  if (String(username ?? "") !== String(config.webUsername ?? "admin")) return false;
  if (config.webPasswordOverride) {
    const a = Buffer.from(String(password ?? ""));
    const b = Buffer.from(String(config.webPasswordOverride));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!config.webPasswordHash) return false;
  return verifyPassword(password, config.webPasswordHash);
}

/** The console is unavailable until a password has been configured. */
function webLoginConfigured(config) {
  return Boolean(config.webPasswordHash || config.webPasswordOverride);
}

/**
 * Static assets the login page itself needs.
 *
 * A WHITELIST, not "anything that is not /api": the login form cannot render or submit
 * without these, and they contain nothing sensitive (anyone who can reach the port can
 * already load the login page). Everything else — notably any .json — stays behind the
 * session check so a future data file cannot be exposed by accident.
 */
const PUBLIC_ASSET_EXT = new Set([".js", ".css", ".svg", ".png", ".ico"]);

/**
 * Guard for the web console: the app shell plus every /api/* endpoint.
 *
 * The console is reachable from anywhere but requires a session, which is what makes a
 * public deployment usable (log in from your laptop, not only on the server).
 *
 * /v1/* deliberately does NOT use this. It keeps its own API key, so a web session can
 * never spend upstream quota, and an API key can never reconfigure the service.
 *
 * @returns {boolean} true when the request may continue to the console handlers
 */
function requireSession(req, res, pathname, config) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (config.webPasswordHash || config.webPasswordOverride) {
    if (getSession(token)) return true;
  }

  // Public assets: the login UI is useless without them.
  if (PUBLIC_ASSET_EXT.has(path.extname(pathname).toLowerCase())) {
    const file = resolveWebFile(pathname);
    if (file) {
      sendFile(req, res, file);
      return false;
    }
  }

  if (!config.webPasswordHash && !config.webPasswordOverride) {
    sendJson(res, 503, {
      error: "尚未设置网页登录密码，控制台不可用。请在 .env 里设置 H3_WEB_PASSWORD 后重启服务。",
      code: "login_not_configured",
    });
    return false;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(res, 401, { error: "未登录或会话已过期。", code: "unauthenticated" });
  } else {
    // Page requests get the app shell so the login form can render. Never a data file:
    // resolveWebFile / sendAppShell cannot reach outside web/.
    sendAppShell(res);
  }
  return false;
}

/* ------------------------------------------------- OpenAI-compatible API - */

function writeSse(res, payload) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    /* client went away */
  }
}

/** Map an /v1/images/generations request body onto the H3 pipeline payload. */
function imageRequestToPayload(body) {
  const prompt = String(body?.prompt ?? "").trim();
  const configured = Math.round(Number(body?.duration));
  const durationSec = configured >= DURATION_MIN && configured <= DURATION_MAX ? configured : 0;
  const ratio = String(body?.size ?? "").includes("x") ? String(body.size).replace("x", ":") : String(body?.aspect_ratio ?? "");
  return {
    text: prompt,
    images: Array.isArray(body?.image) ? body.image.map((dataUrl, i) => ({ name: `image-${i + 1}`, dataUrl })) : [],
    durationSec,
    ratio,
    // A text-to-image node has no keyframe, so reference mode is the useful default:
    // it turns the material into reusable subjects rather than a single frame plan.
    forcedMode: prompt && !body?.image ? "Ref2VA" : "I2VA",
    forcedBy: "images/generations 接口",
  };
}

/** Handle POST /v1/images/generations. Returns the prompt as an inline image payload. */
async function handleImageGenerations(req, res, config) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch (err) {
    openAiError(res, 400, `请求体解析失败：${err.message}`);
    return;
  }
  if (!String(body?.prompt ?? "").trim()) {
    openAiError(res, 400, "prompt 不能为空。", { code: "invalid_prompt" });
    return;
  }

  const controller = new AbortController();
  let finished = false;
  req.on("close", () => {
    if (!finished) controller.abort();
  });

  let result = null;
  let failure = null;
  try {
    for await (const event of runGeneration(config, imageRequestToPayload(body), controller.signal)) {
      if (event.type === "result") result = event.result;
      else if (event.type === "error") failure = event.message;
    }
  } catch (err) {
    failure = err.message;
  } finally {
    finished = true;
  }

  if (!result) {
    openAiError(res, 502, failure || "生成失败。", { type: "upstream_error", code: "h3_generation_failed" });
    return;
  }

  const text = `<!-- H3 Prompt Writing | mode: ${result.mode} | duration: ${result.durationSec}s -->\n\n${result.prompt}`;
  const payload = {
    created: Math.floor(Date.now() / 1000),
    // Inline data URL keeps this dependency-free; the text channel is the intended
    // path for routing the prompt to a real text-to-image node.
    data: [{ b64_json: Buffer.from(text, "utf8").toString("base64"), revised_prompt: result.prompt, url: null, h3: { mode: result.mode, duration_sec: result.durationSec, validation: result.validation } }],
  };
  const encoded = JSON.stringify(payload);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(encoded);
}

/** Handle POST /v1/chat/completions, streaming or not. */
async function handleChatCompletions(req, res, config) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch (err) {
    openAiError(res, 400, `请求体解析失败：${err.message}`);
    return;
  }

  let input;
  try {
    input = parseChatRequest(body);
  } catch (err) {
    openAiError(res, 400, err.message);
    return;
  }
  if (!input.text.trim() && !input.images.length) {
    openAiError(res, 400, "请至少提供文字素材，或在 user 消息中附带图片。");
    return;
  }

  const model = String(body?.model ?? config.publicModelId ?? "h3-prompt-writing");
  const format = input.requestedFormat;
  const stream = Boolean(body?.stream);
  const id = newCompletionId();

  const controller = new AbortController();
  let finished = false;
  req.on("close", () => {
    if (!finished) controller.abort();
  });

  const payload = {
    text: input.text,
    images: input.images,
    mode: "auto",
    forcedMode: input.forcedMode,
    forcedBy: input.forcedBy,
    systemHint: input.systemHint,
  };

  try {
    if (!stream) {
      const streamer = createTextStreamer(format);
      const chunks = [];
      let resultEvent = null;
      let failure = null;
      for await (const event of runGeneration(config, payload, controller.signal)) {
        for (const chunk of streamer.push(event)) chunks.push(chunk);
        if (event.type === "result") resultEvent = event;
        else if (event.type === "error") failure = event.message;
      }
      if (!resultEvent) {
        openAiError(res, 502, failure || "生成失败。", { type: "upstream_error", code: "h3_generation_failed" });
        return;
      }
      for (const chunk of streamer.finish(resultEvent)) chunks.push(chunk);

      const encoded = JSON.stringify(
        chatCompletionResponse({
          id,
          model,
          text: chunks.join(""),
          usage: resultEvent.usage,
        }),
      );
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(encoded),
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      res.end(encoded);
      return;
    }

    // --- streaming (SSE) ---
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
      "x-accel-buffering": "no",
    });
    res.socket?.setNoDelay(true);

    const streamer = createTextStreamer(format);
    writeSse(res, {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });

    let resultEvent = null;
    let failure = null;
    for await (const event of runGeneration(config, payload, controller.signal)) {
      for (const chunk of streamer.push(event)) {
        writeSse(res, {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        });
      }
      if (event.type === "result") resultEvent = event;
      else if (event.type === "error") failure = event.message;
    }

    if (!resultEvent) {
      writeSse(res, { error: { message: failure || "生成失败。", type: "upstream_error" } });
    } else {
      for (const chunk of streamer.finish(resultEvent)) {
        writeSse(res, {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        });
      }
      writeSse(res, {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: resultEvent.usage,
      });
    }
  } catch (err) {
    if (!res.headersSent) {
      openAiError(res, err?.name === "AbortError" ? 499 : 500, err.message);
    } else {
      writeSse(res, { error: { message: `内部错误：${err.message}`, type: "server_error" } });
    }
  } finally {
    finished = true;
    if (!res.writableEnded) res.end();
  }
}

/**
 * @returns {Promise<boolean>} true when the path was handled here
 */
async function handleOpenAiRoutes(req, res, pathname, config) {
  if (pathname === "/v1/models" && req.method === "GET") {
    const encoded = JSON.stringify(modelList(config), null, 2);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(encoded),
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(encoded);
    return true;
  }

  if (pathname === "/v1/models" && req.method === "POST") {
    // Some clients probe with POST; answer identically rather than 405.
    const encoded = JSON.stringify(modelList(config), null, 2);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
    res.end(encoded);
    return true;
  }

  const single = pathname.match(/^\/v1\/models\/(.+)$/);
  if (single && req.method === "GET") {
    const wanted = decodeURIComponent(single[1]);
    const list = modelList(config);
    const found = list.data.find((m) => m.id === wanted);
    if (!found) {
      openAiError(res, 404, `The model '${wanted}' does not exist.`, { code: "model_not_found" });
      return true;
    }
    const encoded = JSON.stringify(found, null, 2);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
    res.end(encoded);
    return true;
  }

  if (pathname === "/v1/chat/completions" && req.method === "POST") {
    await handleChatCompletions(req, res, config);
    return true;
  }

  if (pathname === "/v1/images/generations" && req.method === "POST") {
    await handleImageGenerations(req, res, config);
    return true;
  }

  if (pathname === "/v1" && req.method === "GET") {
    const encoded = JSON.stringify({ object: "list", data: modelList(config).data }, null, 2);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
    res.end(encoded);
    return true;
  }

  openAiError(res, 404, `未知接口 ${pathname}。本服务仅实现 /v1/models、/v1/chat/completions、/v1/images/generations。`, {
    code: "not_found",
  });
  return true;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const { pathname } = url;
    const config = loadConfig();

    try {
      // CORS preflight for browser-based OpenAI clients.
      if (pathname.startsWith("/v1/") && req.method === "OPTIONS") {
        corsPreflight(res);
        return;
      }

      // --- OpenAI-compatible surface (the half NewAPI consumes) ---------------
      if (pathname.startsWith("/v1/")) {
        if (!authorize(req, config)) {
          openAiError(res, 401, "Incorrect API key provided. Set H3_SERVER_API_KEY and pass it as a Bearer token.", {
            type: "invalid_request_error",
            code: "invalid_api_key",
          });
          return;
        }
        if (await handleOpenAiRoutes(req, res, pathname, config)) return;
      }

      // --- session endpoints (public: they ARE the login) ----------------------
      if (pathname === "/api/session" && req.method === "GET") {
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        const session = getSession(token);
        sendJson(res, 200, {
          loginEnabled: webLoginConfigured(config),
          authenticated: Boolean(session),
          username: session?.username ?? null,
        });
        return;
      }

      if (pathname === "/api/login" && req.method === "POST") {
        if (!webLoginConfigured(config)) {
          sendJson(res, 503, {
            error: "尚未设置网页登录密码。请在 .env 里设置 H3_WEB_PASSWORD 后重启服务。",
            code: "login_not_configured",
          });
          return;
        }
        const key = `${req.socket?.remoteAddress ?? "unknown"}`;
        const gate = loginAllowed(key);
        if (!gate.allowed) {
          sendJson(res, 429, {
            error: `尝试次数过多，请 ${gate.retryAfterSec} 秒后再试。`,
            code: "too_many_attempts",
            retryAfterSec: gate.retryAfterSec,
          });
          return;
        }

        let body;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch (err) {
          sendJson(res, 400, { error: `请求解析失败：${err.message}` });
          return;
        }

        if (!checkWebCredentials(config, body.username, body.password)) {
          const state = recordFailure(key);
          // Deliberately vague: never reveal whether the username or the password was wrong.
          sendJson(res, 401, {
            error: "用户名或密码不正确。",
            code: "invalid_credentials",
            remainingAttempts: Math.max(0, 8 - state.failures),
          });
          return;
        }

        recordSuccess(key);
        // Log what the client actually sent. When a login appears to do nothing, the
        // cause is usually the cookie not being stored, and this shows why.
        console.log(`[login] ok user=${body.username} ${describeRequest(req)} cookieSecure=${shouldUseSecureCookie(req)}`);
        const token = createSession(String(body.username));
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": sessionCookie(token, { secure: shouldUseSecureCookie(req) }),
        });
        res.end(JSON.stringify({ ok: true, username: String(body.username) }));
        return;
      }

      if (pathname === "/api/logout" && req.method === "POST") {
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        destroySession(token);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": clearCookie({ secure: shouldUseSecureCookie(req) }),
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // --- web console: same origin for the page and its data ------------------
      // A session is required for everything that reads or changes configuration.
      // /api/health stays open so container health checks and uptime probes work.
      if (pathname !== "/api/health" && !requireSession(req, res, pathname, config)) return;

      if (pathname === "/api/health") {
        sendJson(res, 200, { ok: true, ts: new Date().toISOString() });
        return;
      }

      if (pathname === "/api/skill" && req.method === "GET") {
        const skill = loadSkill();
        sendJson(res, 200, { ...skill.info, modes: MODES, modeFamily: MODE_FAMILY });
        return;
      }

      if (pathname === "/api/providers" && req.method === "GET") {
        sendJson(res, 200, {
          presets: Object.entries(PROVIDER_PRESETS).map(([id, p]) => ({
            id,
            label: p.label,
            baseUrl: p.baseUrl,
            visionModel: p.visionModel,
            altModels: p.altModels,
            hint: p.hint,
            textOnly: Boolean(p.textOnly),
            envKey: p.envKey,
          })),
          limits: { durationMin: DURATION_MIN, durationMax: DURATION_MAX, maxImages: MAX_IMAGES },
        });
        return;
      }

      if (pathname === "/api/models" && req.method === "GET") {
        // `?refresh=1` bypasses the upstream cache, for the "重新检测" button.
        const force = url.searchParams.get("refresh") === "1";
        const upstream = await listUpstreamModels(config, { force });
        const curated = describeCuratedModels(upstream.models);
        sendJson(res, 200, {
          current: config.model,
          plannerModel: config.plannerModel,
          curatedModelId: curated.find((c) => c.model === config.model)?.id ?? null,
          curated,
          upstream: {
            reachable: upstream.models.length > 0,
            count: upstream.models.length,
            error: upstream.error,
            cached: Boolean(upstream.cached),
            models: upstream.models,
          },
        });
        return;
      }

      if (pathname === "/api/model" && req.method === "PUT") {
        let body;
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch (err) {
          sendJson(res, 400, { error: `请求解析失败：${err.message}` });
          return;
        }
        try {
          // Resolve a curated entry against what the upstream actually serves, so a
          // retired dated alias falls through to the next candidate instead of 404ing.
          if (body.entryId && !body.model) {
            const upstream = await listUpstreamModels(config);
            body.upstreamIds = upstream.models;
          }
          const { config: next, patch } = saveModelChoice(body);
          sendJson(res, 200, { ...publicConfig(next), applied: patch });
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
        return;
      }

      if (pathname === "/api/config" && req.method === "GET") {
        sendJson(res, 200, publicConfig(config));
        return;
      }

      if (pathname === "/api/config" && req.method === "PUT") {
        let patch;
        try {
          patch = JSON.parse((await readBody(req)) || "{}");
        } catch (err) {
          sendJson(res, 400, { error: `配置解析失败：${err.message}` });
          return;
        }
        const next = saveConfig(patch);
        sendJson(res, 200, publicConfig(next));
        return;
      }

      if (pathname === "/api/generate" && req.method === "POST") {
        await handleGenerate(req, res, config);
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendJson(res, 404, { error: `未知接口 ${pathname}` });
        return;
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      serveStatic(req, res, pathname);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else if (!res.writableEnded) res.end();
    }
  });
}

/**
 * Bind the HTTP server.
 *
 * Port shifting is OPT-IN (`allowPortShift`, or H3_ALLOW_PORT_SHIFT=1).
 *
 * Silent shifting was the default before, and it caused real confusion: if the
 * configured port was already taken by an unrelated program, the service came up on
 * the next free port while .env still said otherwise — so the documented URL, the
 * NewAPI channel config and the actual listener all disagreed, with no visible error.
 *
 * Default behaviour is now to FAIL loudly. Failing is better than serving on a port
 * nobody is looking at. `portShifted` is always reported so a caller can be explicit.
 */
export function startServer({
  port = Number(process.env.PORT ?? 8787),
  host = process.env.HOST ?? "127.0.0.1",
  maxPortTries = 20,
  allowPortShift = process.env.H3_ALLOW_PORT_SHIFT === "1",
} = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let attempt = 0;
    let boundPort = port;

    const onError = (err) => {
      if (err.code === "EADDRINUSE") {
        if (allowPortShift && attempt < maxPortTries) {
          attempt += 1;
          boundPort = port + attempt;
          server.listen(boundPort, host);
          return;
        }
        reject(
          new Error(
            `端口 ${boundPort} 已被占用。\n` +
              `  服务没有换端口启动，因为那样会让 .env 里的 PORT 与实际监听不一致，\n` +
              `  导致文档、NewAPI 渠道配置全部对不上。\n` +
              `  请任选其一：\n` +
              `    - 改 .env 里的 PORT 换一个空闲端口；\n` +
              `    - 关掉占用该端口的程序；\n` +
              `    - 临时允许顺延：设 H3_ALLOW_PORT_SHIFT=1（会打印实际端口，但配置就不再准确）。`,
          ),
        );
        return;
      }
      reject(err);
    };

    server.on("error", onError);
    server.on("listening", () => {
      server.off("error", onError);
      const address = server.address();
      resolve({
        server,
        port: address.port,
        host: address.address,
        url: `http://${host}:${address.port}`,
        requestedPort: port,
        portShifted: address.port !== port,
      });
    });
    server.listen(port, host);
  });
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  let started;
  try {
    started = await startServer();
  } catch (err) {
    console.error("");
    console.error("  启动失败：");
    console.error("  " + String(err.message).split("\n").join("\n  "));
    console.error("");
    process.exit(1);
  }

  const { url, host: boundHost, port: boundPort, requestedPort, portShifted } = started;
  const config = loadConfig();
  loadSkill(); // fail fast if the official skill files are missing
  const keyState =
    config.apiKeySource === "env" ? "来自环境变量" : config.apiKeySource === "saved" ? "已保存到 config.local.json" : "未配置";
  console.log("");
  console.log("  H3 分镜提示词智能体已启动");
  console.log("  ----------------------------------------");
  if (portShifted) {
    console.log(`  ⚠ 端口顺延：请求 ${requestedPort}，实际监听 ${boundPort}`);
    console.log(`     .env 里的 PORT 与实际不一致，NewAPI 请用 ${boundPort}，或改回一致后重启。`);
  }
  console.log(`  网页界面:  ${url}`);
  console.log(`  兼容接口:  ${url}/v1   模型名: ${config.publicModelId}`);
  console.log(`  提供方:    ${config.provider} (${config.providerLabel})`);
  console.log(`  模型:      ${config.model || "（未配置！）"}   规划模型: ${config.plannerModel || "（未配置）"}`);
  if (!config.apiKey) {
    console.log("  ⚠ 未配置上游 API Key，任何生成请求都会失败。");
    console.log("     请设置环境变量，或在网页右上角「模型设置」里填写。");
  }
  if (!config.model) {
    console.log("  ⚠ 未配置模型名。请在「模型设置」里选择服务商并填写支持图片输入的模型。");
  }
  console.log(`  上游 Key:  ${keyState}`);
  if (config.serverApiKey) {
    console.log("  入站鉴权:  已开启（H3_SERVER_API_KEY）");
  } else if (boundHost !== "127.0.0.1" && boundHost !== "::1" && boundHost !== "localhost") {
    console.log(`  入站鉴权:  ⚠ 未设置 H3_SERVER_API_KEY，但已监听 ${boundHost}！`);
    console.log("             任何能访问此端口的人都可以消耗你的上游额度。");
  } else {
    console.log("  入站鉴权:  未开启（仅监听本机，如需对外请设置 H3_SERVER_API_KEY）");
  }
  console.log("");
}
