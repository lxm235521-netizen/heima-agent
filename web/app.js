/**
 * Front-end controller.
 *
 * The one non-obvious piece here is extractStreamingPrompt(): the server streams
 * the model's raw JSON, and we want the user to watch the *prompt* take shape in
 * real time rather than wait for the whole object. So we locate the "prompt"
 * member and incrementally decode its JSON string value, tolerating an incomplete
 * trailing escape sequence.
 */

/* ------------------------------------------------------------ elements */
const $ = (id) => document.getElementById(id);
const el = {
  text: $("text"),
  charCount: $("charCount"),
  dropzone: $("dropzone"),
  fileInput: $("fileInput"),
  thumbs: $("thumbs"),
  duration: $("duration"),
  ratio: $("ratio"),
  mode: $("mode"),
  deepDive: $("deepDive"),
  generate: $("generate"),
  cancel: $("cancel"),
  progress: $("progress"),
  stageText: $("stageText"),
  eventLog: $("eventLog"),
  tabs: $("tabs"),
  promptOut: $("promptOut"),
  jsonOut: $("jsonOut"),
  planOut: $("planOut"),
  checkOut: $("checkOut"),
  checkCount: $("checkCount"),
  metaRow: $("metaRow"),
  notes: $("notes"),
  copyPrompt: $("copyPrompt"),
  downloadPrompt: $("downloadPrompt"),
  loadSample: $("loadSample"),
  skillBadge: $("skillBadge"),
  modelBadge: $("modelBadge"),
  openSettings: $("openSettings"),
  settings: $("settings"),
  cfgProvider: $("cfgProvider"),
  cfgBaseUrl: $("cfgBaseUrl"),
  cfgModelSelect: $("cfgModelSelect"),
  cfgPlannerSelect: $("cfgPlannerSelect"),
  cfgModel: $("cfgModel"),
  cfgModelHint: $("cfgModelHint"),
  cfgKey: $("cfgKey"),
  cfgRepairs: $("cfgRepairs"),
  cfgHint: $("cfgHint"),
  cfgPath: $("cfgPath"),
  keyState: $("keyState"),
  saveSettings: $("saveSettings"),
  settingsStatus: $("settingsStatus"),
  modelList: $("modelList"),
  modelSwitch: $("modelSwitch"),
  modelLive: $("modelLive"),
  refreshModels: $("refreshModels"),
  loginGate: $("loginGate"),
  loginForm: $("loginForm"),
  loginUser: $("loginUser"),
  loginPass: $("loginPass"),
  loginSubmit: $("loginSubmit"),
  loginError: $("loginError"),
  diagOut: $("diagOut"),
  diagCopy: $("diagCopy"),
  app: $("app"),
};

/* ----------------------------------------------------------------- auth */
/**
 * fetch wrapper for authenticated endpoints.
 *
 * If the session expires while the tab is open, every API call starts returning 401;
 * rather than surfacing that as a confusing error, drop back to the login gate.
 */
async function apiFetch(url, options = {}) {
  const res = await fetch(url, { credentials: "same-origin", ...options });
  if (res.status === 401) {
    showLogin("登录已过期，请重新登录。");
    throw new Error("未登录");
  }
  return res;
}

function showLogin(message = "") {
  el.app.hidden = true;
  el.loginGate.hidden = false;
  el.loginForm.hidden = false;
  el.loginError.hidden = !message;
  el.loginError.textContent = message;
  el.loginPass.value = "";
  el.loginUser.focus();
}

function showApp(username) {
  el.loginGate.hidden = true;
  el.app.hidden = false;
  if (username) log(`已登录为 ${username}。`);
}

async function checkSession() {
  const res = await fetch("/api/session", { credentials: "same-origin" });
  const body = await res.json();

  if (!body.loginEnabled) {
    // No password configured: the server refuses to serve the console at all, so say
    // exactly what to do instead of showing a form that cannot work.
    el.app.hidden = true;
    el.loginGate.hidden = false;
    el.loginForm.hidden = true;
    el.loginError.hidden = false;
    el.loginError.textContent =
      "服务器尚未设置网页登录密码，控制台不可用。请在 .env 中设置 H3_WEB_PASSWORD 后重启服务。";
    return false;
  }

  if (body.authenticated) {
    showApp(body.username);
    return true;
  }
  showLogin();
  return false;
}

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  el.loginError.hidden = true;

  // Validate here rather than with the `required` attribute: native validation blocks
  // the submit event entirely, so a click on an empty form produced no request AND no
  // message — indistinguishable from a broken button.
  const username = el.loginUser.value.trim();
  const password = el.loginPass.value;
  if (!username || !password) {
    el.loginError.hidden = false;
    el.loginError.textContent = !username ? "请输入用户名。" : "请输入密码。";
    (!username ? el.loginUser : el.loginPass).focus();
    return;
  }

  el.loginSubmit.disabled = true;
  el.loginSubmit.textContent = "登录中…";

  try {
    const res = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      const extra = body.remainingAttempts !== undefined ? `（剩余 ${body.remainingAttempts} 次尝试）` : "";
      el.loginError.hidden = false;
      el.loginError.textContent = `${body.error ?? `登录失败（HTTP ${res.status}）`}${extra}`;
      el.loginPass.value = "";
      el.loginPass.focus();
      return;
    }

    showApp(body.username);
    await startConsole();
  } catch (err) {
    // A thrown error here used to be silent. Always surface it, with the error name so
    // a ReferenceError/TypeError is distinguishable from a network failure.
    el.loginError.hidden = false;
    el.loginError.textContent = `登录请求失败：${err.name}: ${err.message}`;
    console.error("[h3] 登录处理器异常:", err);
  } finally {
    el.loginSubmit.disabled = false;
    el.loginSubmit.textContent = "登录";
  }
});

/* ----------------------------------------------------------- diagnostics */
/**
 * Surface what would otherwise be invisible in the moment it matters.
 *
 * A page reload right after login looks identical to "the login button did nothing":
 * the fresh boot re-renders the login gate. These two listeners make that — and any
 * uncaught error — loud in the console instead of silent.
 */
window.addEventListener("error", (event) => {
  console.error("[h3] 未捕获的错误:", event.message, event.filename, event.lineno);
});
window.addEventListener("unhandledrejection", (event) => {
  console.error("[h3] 未处理的 Promise 拒绝:", event.reason);
});
window.addEventListener("beforeunload", () => {
  console.warn("[h3] 页面正在卸载/重新加载 —— 若出现在点击登录之后，说明发生了整页跳转。");
});

/* --------------------------------------------------------------- boot */
/**
 * Report the browser environment once, at boot.
 *
 * The console login had a failure mode where the page looked unresponsive and nothing
 * explained why. Printing this makes an environment problem (a missing API, a cached
 * shell, a stale bundle) immediately visible instead of requiring guesswork.
 */
function reportEnvironment() {
  const required = [
    "loginGate", "loginForm", "loginUser", "loginPass", "loginSubmit", "loginError",
    "app", "text", "eventLog", "generate",
  ];
  const missing = required.filter((id) => !document.getElementById(id));
  const build = document.getElementById("loginForm")?.dataset.build ?? "(未知版本)";
  console.info(
    `[h3] 页面版本 ${build} | 缺失元素: ${missing.length ? missing.join(", ") : "无"} | ` +
      `fetch=${typeof fetch} AbortController=${typeof AbortController} crypto=${typeof crypto} ` +
      `FileReader=${typeof FileReader}`,
  );
  if (missing.length) {
    console.error("[h3] 关键元素缺失，界面会工作不正常。请强制刷新（Ctrl+F5）或清除本站缓存。");
  }
  return { build, missing };
}

const environment = reportEnvironment();

/**
 * Collect everything needed to explain a login that appears to do nothing.
 *
 * Assembled as text the user can copy with one click, because "open DevTools and tell
 * me what the console says" is an unreliable request in practice.
 */
async function collectDiagnostics() {
  const lines = [];
  const stamp = (label, value) => lines.push(`${label}: ${value}`);

  stamp("页面版本", document.getElementById("loginForm")?.dataset.build ?? "(无标记)");
  stamp("页面 URL", location.href);
  stamp("User-Agent", navigator.userAgent);
  stamp(
    "浏览器 API",
    `fetch=${typeof fetch} cookie=${navigator.cookieEnabled} crypto=${typeof crypto} AbortController=${typeof AbortController}`,
  );

  const ids = [
    "loginGate", "loginForm", "loginUser", "loginPass", "loginSubmit", "loginError",
    "app", "text", "eventLog", "generate",
  ];
  const missing = ids.filter((id) => !document.getElementById(id));
  stamp("缺失关键元素", missing.length ? missing.join(", ") : "无");

  const loaded = Object.keys(el).filter((k) => !el[k]);
  if (loaded.length) stamp("未绑定元素", loaded.join(", "));

  // Ask the server directly — this is the same call the app makes at boot.
  try {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const body = await res.json().catch(() => null);
    stamp("/api/session", `HTTP ${res.status} ${JSON.stringify(body)}`);
    stamp("set-cookie 可见", res.headers.get("set-cookie") ? "是" : "否（HttpOnly Cookie 本来就不该可见）");
  } catch (err) {
    stamp("/api/session", `失败 ${err.name}: ${err.message}`);
  }

  stamp("document.cookie 可见部分", document.cookie || "(空)");
  return lines.join("\n");
}

async function refreshDiagnostics() {
  if (!el.diagOut) return;
  try {
    el.diagOut.textContent = await collectDiagnostics();
  } catch (err) {
    el.diagOut.textContent = `收集失败：${err.message}`;
  }
}

el.diagCopy?.addEventListener("click", async () => {
  // Re-collect on click so the copied text reflects the state right now, not the state
  // when the panel was first opened.
  await refreshDiagnostics();
  const text = el.diagOut?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(text);
    el.diagCopy.textContent = "已复制 ✓";
  } catch {
    // Clipboard API needs a secure context; fall back to selecting the text.
    const range = document.createRange();
    range.selectNodeContents(el.diagOut);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    el.diagCopy.textContent = "已选中，请按 Ctrl+C";
  }
  setTimeout(() => {
    el.diagCopy.textContent = "复制诊断信息";
  }, 2500);
});

// Populate the panel when it is opened, and once at boot so it is ready either way.
document.querySelector(".logindiag")?.addEventListener("toggle", (event) => {
  if (event.target.open) refreshDiagnostics();
});
refreshDiagnostics();

/* --------------------------------------------------------------- state */
const state = {
  images: [],
  providers: [],
  config: null,
  models: null,
  switching: false,
  limits: { durationMin: 4, durationMax: 15, maxImages: 9 },
  running: false,
  controller: null,
  result: null,
  lastRawJson: "",
};

/* --------------------------------------------------------------- utils */
function log(message, kind = "") {
  const li = document.createElement("li");
  li.className = kind;
  li.textContent = message;
  el.eventLog.appendChild(li);
  el.eventLog.scrollTop = el.eventLog.scrollHeight;
}

function setStage(message) {
  el.progress.hidden = false;
  el.stageText.textContent = message;
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard API needs a secure context; fall back to a hidden textarea
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (button) {
    const original = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => { button.textContent = original; }, 1200);
  }
}

function download(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* --------------------------------------------- streaming JSON decoding */
const SIMPLE_ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const ESCAPE_CHARS = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/**
 * Decode a (possibly truncated) JSON string body, without surrounding quotes.
 * Returns null when the fragment cannot be decoded yet.
 */
function decodePartialJsonString(body) {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") { out += ch; continue; }
    const next = body[i + 1];
    if (next === undefined) return null;             // dangling backslash at the buffer edge
    if (next === "u") {
      const hex = body.slice(i + 2, i + 6);
      if (hex.length < 4) return null;               // incomplete \uXXXX
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    if (!ESCAPE_CHARS.has(next)) return null;
    out += SIMPLE_ESCAPES[next];
    i += 1;
  }
  return out;
}

/**
 * Pull the value of `"field": "..."` out of a partial JSON document.
 * @param {string} raw partial JSON text
 * @param {string} field top-level key to extract
 * @returns {string} decoded value, or "" while it is not yet available
 */
function extractStreamingField(raw, field) {
  if (!raw) return "";
  const open = new RegExp(`"${field}"\\s*:\\s*"`);
  const match = open.exec(raw);
  if (!match) return "";
  let i = match.index + match[0].length;
  let body = "";
  for (; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\\") { body += ch + (raw[i + 1] ?? ""); i += 1; continue; }
    if (ch === '"') break;
    body += ch;
  }
  return decodePartialJsonString(body) ?? "";
}

/**
 * Exported for scripts/check-frontend.mjs. The browser build simply ignores these
 * exports; keeping them lets the incremental decoder be tested without a DOM.
 */
export const __test = { decodePartialJsonString, extractStreamingField };

/* --------------------------------------------------------------- images */
function renderThumbs() {
  el.thumbs.replaceChildren();
  state.images.forEach((img, index) => {
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    wrap.title = `${img.name}\n${img.width}x${img.height} · ${formatBytes(img.bytes)}`;

    const image = document.createElement("img");
    image.src = img.dataUrl;
    image.alt = img.name;

    const meta = document.createElement("div");
    meta.className = "tmeta";
    meta.textContent = `${index + 1}. ${img.width}x${img.height} ${formatBytes(img.bytes)}`;

    const rm = document.createElement("button");
    rm.className = "rm";
    rm.type = "button";
    rm.textContent = "×";
    rm.title = "移除";
    rm.addEventListener("click", () => {
      state.images.splice(index, 1);
      renderThumbs();
    });

    wrap.append(image, meta, rm);
    el.thumbs.appendChild(wrap);
  });
}

function readImageSize(dataUrl) {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => resolve({ width: 0, height: 0 });
    probe.src = dataUrl;
  });
}

async function addFiles(fileList) {
  const files = [...fileList];
  for (const file of files) {
    if (state.images.length >= state.limits.maxImages) {
      log(`最多 ${state.limits.maxImages} 张图片，其余已忽略。`, "warn");
      break;
    }
    if (!file.type.startsWith("image/")) {
      log(`「${file.name}」不是图片，已跳过。`, "warn");
      continue;
    }
    if (file.size > 8 * 1024 * 1024) {
      log(`「${file.name}」${formatBytes(file.size)} 超过单张 8MB，请先压缩。`, "warn");
      continue;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const size = await readImageSize(dataUrl);
    state.images.push({ name: file.name, bytes: file.size, dataUrl, ...size });
  }
  renderThumbs();
}

/* --------------------------------------------------------- plan display */
function renderPlan(plan) {
  el.planOut.replaceChildren();
  if (!plan) {
    el.planOut.textContent = "本次未单独生成分析（深度模式或规划阶段失败）。";
    return;
  }
  const section = (title, node) => {
    const div = document.createElement("div");
    div.className = "plan-section";
    const h = document.createElement("h4");
    h.textContent = title;
    div.appendChild(h);
    div.appendChild(node);
    el.planOut.appendChild(div);
  };
  const list = (items, render) => {
    const ul = document.createElement("ul");
    for (const item of items) {
      const li = document.createElement("li");
      li.append(render(item));
      ul.appendChild(li);
    }
    return ul;
  };
  const span = (text) => document.createTextNode(String(text ?? ""));
  const boldKV = (label, value) => {
    const frag = document.createDocumentFragment();
    const b = document.createElement("b");
    b.textContent = `${label}: `;
    frag.append(b, document.createTextNode(String(value ?? "—")));
    return frag;
  };

  const headline = document.createElement("div");
  headline.className = "plan-kv";
  headline.append(
    boldKV("判定模式", plan.mode),
    document.createTextNode("  ·  "),
    boldKV("置信度", plan.confidence),
    document.createTextNode("  ·  "),
    boldKV("时长", `${plan.duration_sec}s`),
    document.createTextNode("  ·  "),
    boldKV("画幅", plan.ratio),
    document.createTextNode("  ·  "),
    boldKV("分镜数", plan.shot_count),
  );
  section("判定结论", headline);
  if (plan.mode_reason) {
    const p = document.createElement("div");
    p.className = "plan-kv";
    p.textContent = plan.mode_reason;
    section("判定理由", p);
  }
  if (Array.isArray(plan.image_roles) && plan.image_roles.length) {
    section("图片用途", list(plan.image_roles, (x) => {
      const frag = document.createDocumentFragment();
      frag.append(boldKV(`Picture ${x.index}`, `${x.role}${x.is_concrete_frame ? "（作为实际帧）" : "（仅作参考）"}`));
      return frag;
    }));
  }
  if (Array.isArray(plan.characters) && plan.characters.length) {
    section("人物", list(plan.characters, (c) => {
      const frag = document.createDocumentFragment();
      frag.append(boldKV(c.name, `${c.appearance ?? ""}${c.speaks ? ` · 有台词${c.voice ? `（${c.voice}）` : ""}` : ""}`));
      return frag;
    }));
  }
  if (Array.isArray(plan.environments) && plan.environments.length) section("场景", list(plan.environments, span));
  if (Array.isArray(plan.dialogue) && plan.dialogue.length) {
    section("台词（原样保留）", list(plan.dialogue, (d) => span(`${d.speaker ?? "?"} [${d.language ?? "?"}] ${d.verbatim ?? ""}`)));
  }
  if (Array.isArray(plan.diegetic_sound) && plan.diegetic_sound.length) section("画内声音", list(plan.diegetic_sound, span));
  if (plan.music) section("非画内配乐", (() => { const p = document.createElement("div"); p.className = "plan-kv"; p.textContent = plan.music; return p; })());
  if (Array.isArray(plan.reference_assets) && plan.reference_assets.length) {
    section("参考标签定义", list(plan.reference_assets, (r) => span(`${r.label} — ${r.meaning}`)));
  }
  if (Array.isArray(plan.unspecified) && plan.unspecified.length) section("用户未交代 / 已补全", list(plan.unspecified, span));
}

/* ------------------------------------------------------ check display */
function renderCheck(validation, extra = []) {
  el.checkOut.replaceChildren();
  const errors = validation?.errors ?? [];
  const warnings = [...(validation?.warnings ?? []), ...extra];
  const stats = validation?.stats ?? {};
  el.checkCount.textContent = String(errors.length + warnings.length);
  el.checkCount.className = `pill${errors.length ? " err" : warnings.length ? " warn" : ""}`;

  const statsBox = document.createElement("div");
  statsBox.className = "plan-kv";
  statsBox.style.marginBottom = "10px";
  statsBox.textContent = `模式 ${stats.mode ?? "—"} · ${stats.words ?? 0} 词 · ${stats.shotCount ?? 0} 个分镜 · ${stats.cutCount ?? 0} 个切点 · ${stats.dialogueCount ?? 0} 段台词 · ${(stats.referenceLabels ?? []).length} 个参考标签`;
  el.checkOut.appendChild(statsBox);

  const add = (kind, icon, text) => {
    const div = document.createElement("div");
    div.className = `check-item ${kind}`;
    const span = document.createElement("span");
    span.className = "check-icon";
    span.textContent = icon;
    div.append(span, document.createTextNode(text));
    el.checkOut.appendChild(div);
  };

  if (!errors.length && !warnings.length) add("ok", "✓", "全部通过：字段、顺序、分镜时间轴、参考标签、台词格式均符合官方规范。");
  for (const e of errors) add("err", "✕", e);
  for (const w of warnings) add("warn", "!", w);
  if (stats.referenceLabels?.length) add("info", "i", `使用的参考标签：${stats.referenceLabels.join(" ")}`);
  if (stats.speakerIds?.length) add("info", "i", `说话人编号：${stats.speakerIds.map((s) => `(${s})`).join(" ")}`);
}

/* ------------------------------------------------------- generate flow */
function newRun() {
  el.eventLog.replaceChildren();
  el.promptOut.textContent = "";
  el.jsonOut.textContent = "";
  el.planOut.replaceChildren();
  el.checkOut.replaceChildren();
  el.metaRow.hidden = true;
  el.notes.hidden = true;
  el.tabs.hidden = true;
  el.checkCount.textContent = "0";
  el.checkCount.className = "pill";
  state.lastRawJson = "";
  state.result = null;
  el.copyPrompt.disabled = true;
  el.downloadPrompt.disabled = true;
}

function setRunning(running) {
  state.running = running;
  el.generate.disabled = running;
  el.generate.textContent = running ? "生成中…" : "生成 H3 提示词";
  el.cancel.hidden = !running;
  if (!running) el.progress.hidden = false;
}

async function run() {
  if (state.running) return;
  if (!el.text.value.trim() && state.images.length === 0) {
    log("请至少填写文字素材，或上传一张参考图。", "err");
    el.text.focus();
    return;
  }
  newRun();
  setRunning(true);
  setStage("正在提交…");

  state.controller = new AbortController();
  const payload = {
    text: el.text.value,
    images: state.images.map(({ name, dataUrl }) => ({ name, dataUrl })),
    ratio: el.ratio.value,
    durationSec: el.duration.value ? Number(el.duration.value) : 0,
    mode: el.mode.value,
    deepDive: el.deepDive.checked,
  };

  let streamedJson = "";
  let progressLines = 0;

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: state.controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text();
      log(`服务端返回 HTTP ${res.status}：${detail.slice(0, 400)}`, "err");
      setRunning(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (event.type === "stage") {
          progressLines += 1;
          setStage(event.message);
          log(event.message);
          if (event.problems?.length) for (const p of event.problems) log(`· ${p}`, "warn");
        } else if (event.type === "warning") {
          log(event.message, "warn");
        } else if (event.type === "intake") {
          if (event.images?.length) log(`已接收 ${event.images.length} 张图：${event.images.map((i) => `#${i.index} ${i.width}x${i.height}`).join("，")}`);
        } else if (event.type === "plan") {
          renderPlan(event.plan);
          log(`模式判定：${event.plan?.mode}（置信度 ${event.plan?.confidence ?? "?"}）`);
        } else if (event.type === "delta") {
          streamedJson += event.text;
          el.jsonOut.textContent = streamedJson;
          el.jsonOut.scrollTop = el.jsonOut.scrollHeight;
          const partial = extractStreamingField(streamedJson, "prompt");
          if (partial) {
            el.promptOut.textContent = partial;
            el.promptOut.scrollTop = el.promptOut.scrollHeight;
          }
        } else if (event.type === "result") {
          renderResult(event);
        } else if (event.type === "error") {
          log(event.message, "err");
          if (event.raw) {
            el.jsonOut.textContent = event.raw;
            el.tabs.hidden = false;
            switchTab("json");
          }
          setStage("已终止");
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") log("已取消。", "warn");
    else log(`网络或执行错误：${err.message}`, "err");
  } finally {
    setRunning(false);
    state.controller = null;
  }
}

function renderResult(event) {
  const r = event.result;
  state.result = r;
  state.lastRawJson = el.jsonOut.textContent;

  el.promptOut.textContent = r.prompt;
  el.metaRow.replaceChildren();
  el.metaRow.hidden = false;
  const chips = [
    [`模式 ${r.mode}`, true],
    [`时长 ${r.durationSec}s`, true],
    r.ratio ? [`画幅 ${r.ratio}`, true] : null,
    [`${r.shotCount} 个分镜`, true],
    [`${event.usage?.total_tokens ?? "?"} tokens`, false],
    [`${(event.elapsedMs / 1000).toFixed(1)}s`, false],
    r.repairs ? [`自动修复 ${r.repairs} 次`, false] : null,
  ].filter(Boolean);
  for (const [text, accent] of chips) {
    const span = document.createElement("span");
    span.className = `chip${accent ? "" : " neutral"}`;
    span.textContent = text;
    el.metaRow.appendChild(span);
  }

  if (r.notesZh) {
    el.notes.hidden = false;
    el.notes.textContent = `说明：${r.notesZh}`;
  }

  renderCheck(r.validation);
  try {
    el.jsonOut.textContent = JSON.stringify(JSON.parse(state.lastRawJson || "{}"), null, 2);
  } catch {
    /* keep the raw streamed text if it does not round-trip */
  }

  el.tabs.hidden = false;
  el.copyPrompt.disabled = false;
  el.downloadPrompt.disabled = false;
  setStage("完成");
  if (r.validation.errors.length) {
    log(`完成，但仍有 ${r.validation.errors.length} 个校验错误，见「校验」标签。`, "warn");
  } else if (r.validation.warnings.length) {
    log(`完成，有 ${r.validation.warnings.length} 条提示，见「校验」标签。`, "ok");
  } else {
    log("完成，校验全部通过。", "ok");
  }
}

/* ---------------------------------------------------------------- tabs */
function switchTab(name) {
  for (const tab of el.tabs.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  for (const pane of document.querySelectorAll(".tabpane")) {
    pane.hidden = pane.id !== `tab-${name}`;
  }
}

/* --------------------------------------------------------------- boot */
async function loadConfig() {
  const [configRes, providersRes, skillRes] = await Promise.all([
    apiFetch("/api/config").then((r) => r.json()),
    apiFetch("/api/providers").then((r) => r.json()),
    apiFetch("/api/skill").then((r) => r.json()),
  ]);
  state.config = configRes;
  state.providers = providersRes.presets;
  state.limits = providersRes.limits ?? state.limits;

  el.skillBadge.className = "badge badge-ok";
  el.skillBadge.textContent = `官方 skill v${skillRes.sha256_12["SKILL.md"]}`;
  el.skillBadge.title = `${skillRes.dir}\nSKILL.md ${skillRes.bytes.skill}B · base ${skillRes.bytes.base}B · ref ${skillRes.bytes.ref}B\nsha256(12): ${JSON.stringify(skillRes.sha256_12)}`;

  const modelOk = configRes.hasApiKey && configRes.model;
  renderModelBadge();

  if (!modelOk) {
    log("尚未配置模型或 API Key。请点右上角「模型设置」填入，或设置环境变量后重启服务。", "warn");
    el.settings.showModal();
  } else if (configRes.textOnlyProvider) {
    log(`注意：${configRes.providerLabel} 不支持图片输入，上传的图片会被忽略。`, "warn");
  }
  el.cfgPath.textContent = configRes.savedPath;
  return configRes;
}

function fillProviderSelect() {
  el.cfgProvider.replaceChildren();
  for (const p of state.providers) {
    const option = document.createElement("option");
    option.value = p.id;
    option.textContent = p.label;
    el.cfgProvider.appendChild(option);
  }
}

/* --------------------------------------------------------------- models */
function renderModelBadge() {
  const c = state.config ?? {};
  const ok = c.hasApiKey && c.model;
  el.modelBadge.className = `badge ${ok ? (c.textOnlyProvider ? "badge-warn" : "badge-ok") : "badge-err"}`;
  el.modelBadge.textContent = ok ? c.model : "未配置模型";
  el.modelBadge.title = `${c.providerLabel ?? ""}\n${c.baseUrl ?? ""}\nAPI Key: ${c.apiKeySource ?? "-"}`;
}

/** Render the one-click switcher. */
function renderModelSwitch() {
  const info = state.models;
  el.modelSwitch.replaceChildren();

  if (!info) {
    const span = document.createElement("span");
    span.className = "hint";
    span.textContent = "正在读取可用模型…";
    el.modelSwitch.appendChild(span);
    return;
  }

  for (const entry of info.curated) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model-chip";
    button.dataset.entry = entry.id;
    button.title = `${entry.model}\n${entry.hint}${
      entry.available === false ? "\n⚠ 上游 /models 里没找到这个名字" : ""
    }`;
    if (entry.available === false) button.classList.add("missing");
    if (entry.id === info.curatedModelId) button.classList.add("active");

    button.appendChild(document.createTextNode(entry.label));
    if (entry.id === info.curatedModelId) {
      const tick = document.createElement("span");
      tick.className = "dot ok";
      tick.textContent = "✓";
      button.appendChild(tick);
      // One-shot confirmation pulse so a click is visibly acknowledged.
      if (state.flashEntry === entry.id) button.classList.add("just-applied");
    }
    if (entry.available === false) {
      const dot = document.createElement("span");
      dot.className = "dot bad";
      dot.textContent = "?";
      button.appendChild(dot);
    }
    button.disabled = state.switching;
    button.addEventListener("click", () => switchModel(entry.id));
    el.modelSwitch.appendChild(button);
  }

  const upstream = info.upstream ?? {};
  if (upstream.reachable) {
    el.modelLive.className = "badge badge-ok";
    el.modelLive.textContent = `上游 ${upstream.count} 个模型`;
    el.modelLive.title = `已读取 ${info.curated.length} 个快捷预设，上游共 ${upstream.count} 个模型。可在「模型设置」里选择任意一个。`;
  } else {
    el.modelLive.className = "badge badge-warn";
    el.modelLive.textContent = "未读到模型列表";
    el.modelLive.title = `${upstream.error || "上游未返回模型列表"}\n仍可直接切换预设（无法校验名称是否有效）。`;
  }
  el.refreshModels.disabled = state.switching;
}

async function loadModels({ refresh = false } = {}) {
  try {
    const res = await apiFetch(`/api/models${refresh ? "?refresh=1" : ""}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.models = await res.json();
  } catch (err) {
    state.models = null;
    log(`读取模型列表失败：${err.message}`, "warn");
  }
  renderModelSwitch();
  fillModelSelects();
  return state.models;
}

/**
 * One-click switch. Persists immediately, so the choice survives a refresh and is
 * used by the very next generation.
 */
async function switchModel(entryId) {
  if (state.switching) return;
  // Clicking the already-active preset is a no-op, not a redundant write.
  if (state.models?.curatedModelId === entryId) {
    log(`${state.models.curated.find((c) => c.id === entryId)?.label ?? entryId} 已经是当前模型。`);
    return;
  }

  state.switching = true;
  renderModelSwitch();
  el.refreshModels.disabled = true;

  try {
    const res = await apiFetch("/api/model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

    const before = state.config?.model;
    state.config = body;

    // The highlight is driven by curatedModelId. The PUT response carries the new
    // value, so updating it here is what makes the click feel applied — relying on a
    // later refresh left the previous chip looking active.
    if (state.models) {
      state.models.curatedModelId = body.curatedModelId ?? null;
      state.models.current = body.model;
    }
    state.flashEntry = entryId;
    if (el.cfgModel) el.cfgModel.value = body.model ?? "";
    renderModelBadge();
    renderModelSwitch();
    fillModelSelects();

    const label = state.models?.curated.find((c) => c.id === entryId)?.label ?? body.model;
    if (before !== body.model) {
      log(`已切换模型：${label}（${body.model}）`, "ok");
    } else {
      log(`已设为 ${label}（${body.model}）`, "ok");
    }
    if (state.models?.upstream?.reachable) {
      const hit = state.models.upstream.models.includes(body.model);
      if (!hit) {
        log(`注意：上游 /models 里没有 "${body.model}"，生成时可能报错。可点「重新检测」或改填其他模型名。`, "warn");
      }
    }
  } catch (err) {
    log(`切换模型失败：${err.message}`, "err");
  } finally {
    state.switching = false;
    renderModelSwitch();
    el.refreshModels.disabled = false;
    // Clear the one-shot pulse so it can fire again on the next switch.
    if (state.flashEntry) setTimeout(() => { state.flashEntry = null; }, 700);
  }
}

/**
 * Populate the settings dropdowns.
 *
 * The option value is always a concrete model id, so choosing an entry can never
 * silently set an empty model.
 */
function fillModelSelects() {
  const info = state.models;
  if (!info) return;

  el.cfgModelSelect.replaceChildren();
  const curateGroup = document.createElement("optgroup");
  curateGroup.label = "推荐（一键切换）";
  for (const entry of info.curated) {
    const option = document.createElement("option");
    option.value = entry.model;
    option.dataset.entry = entry.id;
    option.textContent = `${entry.label} — ${entry.model}${entry.available === false ? "（上游未列出）" : ""}`;
    curateGroup.appendChild(option);
  }
  el.cfgModelSelect.appendChild(curateGroup);

  if (info.upstream?.reachable) {
    const anyGroup = document.createElement("optgroup");
    anyGroup.label = `上游全部模型（${info.upstream.count}）`;
    for (const id of info.upstream.models) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      anyGroup.appendChild(option);
    }
    el.cfgModelSelect.appendChild(anyGroup);
  }

  const current = state.config?.model ?? info.current ?? "";
  el.cfgModelSelect.value = current;
  if (el.cfgModelSelect.value !== current) el.cfgModelSelect.selectedIndex = -1;

  // Planner select: any curated entry can be reused as a cheaper planner.
  const planner = el.cfgPlannerSelect;
  const configured = state.config?.plannerModel ?? "";
  planner.replaceChildren();
  const same = document.createElement("option");
  same.value = "";
  same.textContent = "同生成模型（推荐）";
  planner.appendChild(same);
  for (const entry of info.curated) {
    const option = document.createElement("option");
    option.value = entry.model;
    option.textContent = `${entry.label} — ${entry.model}`;
    planner.appendChild(option);
  }
  // Reflect the SAVED planner model, not the generation model.
  const plannerMatches = info.curated.find((c) => c.model === configured);
  planner.value = plannerMatches ? configured : "";

  const entry = info.curated.find((c) => c.model === current);
  el.cfgModelHint.textContent = entry
    ? `${entry.hint}${entry.available === false ? "　⚠ 上游 /models 未列出该名称" : ""}`
    : current
      ? "当前模型不在推荐列表内（自定义）。"
      : "请选择一个模型。";
}

/* ----------------------------------------------------------- settings */
function syncProviderFields() {
  const preset = state.providers.find((p) => p.id === el.cfgProvider.value);
  if (!preset) return;
  el.cfgHint.textContent = `${preset.hint}${preset.textOnly ? " ⚠ 不支持图片" : ""}　环境变量：${preset.envKey.join(" / ")}`;
  el.modelList.replaceChildren();
  for (const m of [preset.visionModel, ...(preset.altModels ?? [])].filter(Boolean)) {
    const option = document.createElement("option");
    option.value = m;
    el.modelList.appendChild(option);
  }
}

function openSettings() {
  const c = state.config ?? {};
  el.cfgProvider.value = c.provider ?? "custom";
  syncProviderFields();
  el.cfgBaseUrl.value = c.baseUrl ?? "";
  fillModelSelects();
  el.cfgModel.value = c.model ?? "";
  el.cfgPlannerSelect.value = c.plannerModel && c.plannerModel !== c.model ? c.plannerModel : "";
  el.cfgKey.value = "";
  el.cfgRepairs.value = String(c.repairPasses ?? 1);
  el.keyState.textContent = c.hasApiKey
    ? `（当前来源：${c.apiKeySource === "env" ? "环境变量" : "已保存"}，留空则不修改）`
    : "（未配置）";
  el.settingsStatus.textContent = "";
  el.settings.showModal();
}

async function saveSettings() {
  const body = {
    provider: el.cfgProvider.value,
    baseUrl: el.cfgBaseUrl.value.trim(),
    // An explicit text value wins over the dropdown (it is the "custom" escape hatch).
    model: el.cfgModel.value.trim() || el.cfgModelSelect.value || "",
    plannerModel: el.cfgPlannerSelect.value || "",
    repairPasses: Number(el.cfgRepairs.value),
  };
  if (el.cfgKey.value.trim()) body.apiKey = el.cfgKey.value.trim();

  el.settingsStatus.textContent = "保存中…";
  const res = await apiFetch("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    el.settingsStatus.textContent = `保存失败：${(await res.text()).slice(0, 200)}`;
    return;
  }
  state.config = await res.json();
  el.settingsStatus.textContent = "已保存。";
  renderModelBadge();
  await loadModels();
  setTimeout(() => el.settings.close(), 500);
}

/* ----------------------------------------------------------- listeners */
el.text.addEventListener("input", () => { el.charCount.textContent = String(el.text.value.length); });
el.dropzone.addEventListener("click", () => el.fileInput.click());
el.dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") el.fileInput.click(); });
el.fileInput.addEventListener("change", () => { addFiles(el.fileInput.files); el.fileInput.value = ""; });
for (const type of ["dragenter", "dragover"]) {
  el.dropzone.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.add("over"); });
}
for (const type of ["dragleave", "drop"]) {
  el.dropzone.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.remove("over"); });
}
el.dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

el.generate.addEventListener("click", run);
el.cancel.addEventListener("click", () => state.controller?.abort());
el.copyPrompt.addEventListener("click", () => copy(state.result?.prompt ?? el.promptOut.textContent, el.copyPrompt));
el.downloadPrompt.addEventListener("click", () => {
  const r = state.result;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  download(`h3-prompt-${r?.mode ?? "out"}-${stamp}.txt`, el.promptOut.textContent);
});
el.tabs.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) switchTab(tab.dataset.tab);
});
el.openSettings.addEventListener("click", openSettings);
el.cfgProvider.addEventListener("change", () => {
  const preset = state.providers.find((p) => p.id === el.cfgProvider.value);
  syncProviderFields();
  if (preset) {
    el.cfgBaseUrl.value = preset.baseUrl ?? "";
    el.cfgModel.value = preset.visionModel ?? "";
  }
});
// Picking from the dropdown fills the explicit model field, so there is exactly one
// source of truth when the form is saved.
el.cfgModelSelect.addEventListener("change", () => {
  if (el.cfgModelSelect.value) el.cfgModel.value = el.cfgModelSelect.value;
  const entry = state.models?.curated.find((c) => c.model === el.cfgModelSelect.value);
  el.cfgModelHint.textContent = entry ? entry.hint : "";
});
el.refreshModels.addEventListener("click", async () => {
  el.refreshModels.disabled = true;
  el.modelLive.className = "badge badge-muted";
  el.modelLive.textContent = "检测中…";
  await loadModels({ refresh: true });
  log("已重新检测上游模型列表。");
});
el.saveSettings.addEventListener("click", saveSettings);

el.loadSample.addEventListener("click", () => {
  el.text.value = `深夜的旧仓库。老陈推开锈迹斑斑的铁门，手电光柱扫过满地纸箱，灰尘在光里翻涌。他身后跟着十七岁的小满，抱着一台旧录音机。

老陈压低声音：东西还在。
小满紧张地咽了口唾沫：爸，外面有人。
铁门外传来脚步踩碎玻璃的声音，越来越近。老陈一把按灭手电，黑暗里只剩录音机红色的指示灯在闪。`;
  el.charCount.textContent = String(el.text.value.length);
  el.duration.value = "10";
  el.ratio.value = "16:9";
  log("已载入示例文本。可再上传图片，或直接点「生成 H3 提示词」。");
});

renderThumbs();

/**
 * Everything that needs a session. Called after login, and again on reload when an
 * existing session is still valid.
 */
let consoleStarted = false;
async function startConsole() {
  if (consoleStarted) return;
  consoleStarted = true;
  try {
    await loadConfig();
    fillProviderSelect();
    await loadModels();
  } catch (err) {
    // apiFetch already returns to the login gate on 401, so only report real errors.
    if (err.message !== "未登录") log(`初始化失败：${err.message}`, "err");
    else consoleStarted = false;
  }
}

checkSession()
  .then((authenticated) => {
    if (authenticated) return startConsole();
    return undefined;
  })
  .catch((err) => {
    el.loginGate.hidden = false;
    el.loginError.hidden = false;
    el.loginError.textContent = `无法连接服务：${err.message}`;
  });
