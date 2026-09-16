/**
 * A fake OpenAI-compatible endpoint for tests and offline demos.
 *
 * It inspects the incoming system prompt to decide whether it is answering the
 * planning call (asked for the planning JSON contract) or the generation call
 * (asked to produce the final prompt JSON), and replies accordingly — including
 * a real SSE stream so the streaming path is exercised end to end.
 */
import http from "node:http";

const PLAN = {
  mode: "I2VA",
  mode_reason: "用户上传的图片将作为目标视频的首帧使用。",
  confidence: 0.82,
  duration_sec: 8,
  ratio: "16:9",
  shot_count: 2,
  image_roles: [{ index: 1, role: "首帧", is_concrete_frame: true }],
  characters: [{ name: "老陈", appearance: "五十岁男性，灰白短发，深色夹克", speaks: true, voice: "低沉沙哑的中年男声" }],
  environments: ["深夜旧仓库，手电单光源，灰尘在光柱中翻涌"],
  dialogue: [{ speaker: "老陈", language: "Chinese", verbatim: "东西还在。" }],
  diegetic_sound: ["铁门摩擦声", "脚步踩碎玻璃声"],
  music: "低频弦乐，缓慢推进",
  reference_assets: [{ label: "Picture 1", meaning: "仓库内景首帧参考" }],
  unspecified: ["未指定具体画幅，按 16:9 处理"],
};

const BASE_PROMPT = `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium shot begins from the warehouse interior established by <Picture 1>, preserving the rusted iron door, the stacked cardboard boxes, and the single flashlight beam cutting through drifting dust. A man in his fifties with short grey-streaked hair and a dark jacket (S1) steps through the doorway and sweeps the beam across the floor. The camera pushes in with small amplitude at slow speed as he lowers his voice and says: <d>[Chinese] 东西还在。</d> A teenage girl carrying an old tape recorder follows two steps behind him, her shoulders tight. [Shot 2] At 00:04.500, the camera cuts to a close-up of the girl's face as her eyes flick toward the doorway. Glass crunches outside, and the man's hand snaps to the flashlight switch. The light dies, leaving only the small red indicator of the tape recorder glowing in the dark.

overall_soundscape: A hollow warehouse room tone sits under the scrape of the iron door and the soft scuff of shoes on concrete. Dust settles audibly as the beam sweeps, and the crunch of broken glass grows steadily closer from outside.

non_diegetic_music: A low, sustained string drone at a slow tempo, joined by a single deep piano note that decays as the light cuts out.`;

const REF_PROMPT = `subject_definitions:
<Subject 1> is the warehouse interior in <Picture 1>, with rusted iron doors, stacked cardboard boxes, a bare overhead bulb, and concrete flooring coated in dust.
<Picture 1> is the first frame of [Shot 1], showing the warehouse interior as the camera finds it.

summary:
[reference generation] The target video holds on <Subject 1> as a man enters the warehouse, sweeps a flashlight across the floor, speaks one line to the girl behind him, and cuts the light.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - the rusted doors, stacked boxes, bare bulb, and dusty concrete floor are retained.
<Picture 1> ([Shot 1] first frame): fully_preserved - the opening framing, lens, and lighting state are reused unchanged.

detailed_description:
The target video is in a realistic cinematic style with a single-source lighting scheme, heavy shadow falloff, and a slightly desaturated color palette.
[Shot 1] The shot begins from <Picture 1>, the warehouse interior with rusted iron doors, stacked cardboard boxes, and a single bare bulb hanging above the concrete floor. A man in his fifties with short grey-streaked hair and a dark jacket (S1) steps through the doorway, sweeping a flashlight beam in a slow arc that lifts dust into the air. He pauses, tilts the beam toward the far corner where the boxes are stacked highest, and settles his weight onto his back foot. A teenage girl carrying an old tape recorder follows two steps behind him, her shoulders drawn tight and her eyes fixed on the doorway she just came through. <Subject 1> (S1) lowers his voice to a near whisper and says, <d>[Chinese] 东西还在。</d> The girl shifts the recorder against her chest, and its small red indicator light pulses once. Toward the end of the shot, broken glass crunches somewhere beyond the doors, and <Subject 1> (S1) reaches for the flashlight switch and presses it. The frame falls into darkness, leaving only the red indicator glowing against the black interior as the camera holds steady.

overall_soundscape: A hollow warehouse room tone sits beneath the long scrape of the iron door and the soft scuff of shoes on concrete. Dust settles audibly as the beam sweeps past the boxes, and the crunch of broken glass grows steadily closer from outside the doors.

non_diegetic_music: A low sustained string drone at a slow tempo, joined by a single deep piano note that decays away as the flashlight cuts out.`;

const REPAIRED_PROMPT = BASE_PROMPT;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** Message content may be a plain string or a multimodal parts array. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join(" ");
  }
  return "";
}

/** Decide the reply from the system prompt, and allow tests to force a behaviour. */
function buildReply(body) {
  const messages = body.messages ?? [];
  const system = textOf(messages[0]?.content);
  const behaviour = process.env.MOCK_BEHAVIOUR ?? "normal";

  // A repair pass keeps the same system prompt and appends {assistant, user} to the
  // conversation, so the reliable signal is a trailing assistant turn followed by the
  // repair instruction: [system, user, assistant, user].
  const isRepair = messages.length >= 4 && messages.at(-2)?.role === "assistant" && messages.at(-1)?.role === "user";
  const isPlanning = system.includes("planning stage");

  // Behaviours simulate a *first* failing reply, so a repair pass must be answered
  // with a usable one — otherwise they would simulate an unrecoverable model.
  if (!isRepair && !isPlanning) {
    if (behaviour === "fenced") {
      return { content: "好的，这是结果：\n```json\n" + JSON.stringify({ mode: "T2VA", duration_sec: 8, ratio: "16:9", shot_count: 1, prompt: BASE_PROMPT, notes_zh: "fenced" }) + "\n```" };
    }
    if (behaviour === "badjson") return { content: "抱歉，我无法完成。" };
  }
  if (behaviour === "http401") return { httpError: 401, message: "invalid api key" };

  // Simulates the observed relay quirk: a non-streaming request answered with a
  // usage-only SSE chunk and no content at all.
  if (behaviour === "emptynonstream" && !body.stream) {
    return { emptyNonStream: true };
  }
  // A provider that answers 200 with a well-formed but content-free stream.
  if (behaviour === "emptychoices") {
    return { emptyChoices: true };
  }

  if (isPlanning) {
    return { content: JSON.stringify(PLAN) };
  }
  if (isRepair) {
    return { content: JSON.stringify({ mode: "I2VA", duration_sec: 8, ratio: "16:9", shot_count: 2, prompt: REPAIRED_PROMPT, notes_zh: "修复后" }) };
  }
  // The router is the mode contract injected by buildSystemPrompt. Note that we must
  // NOT test for the literal "ref-en.txt" here: the verbatim SKILL.md mentions that
  // filename in its own workflow section even for base-mode requests.
  const isRef = system.includes("Follow the six-section rewrite format in `references/ref-en.txt`");
  return {
    content: JSON.stringify({
      mode: isRef ? "Ref2VA" : "I2VA",
      duration_sec: 8,
      ratio: "16:9",
      shot_count: isRef ? 1 : 2,
      prompt: isRef ? REF_PROMPT : BASE_PROMPT,
      speak_map: [{ id: "S1", line: "东西还在。" }],
      notes_zh: "已按官方规范改写，台词保持中文原文。",
    }),
  };
}

function sse(res, text) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
  const step = 24;
  for (let i = 0; i < text.length; i += step) {
    const frame = { choices: [{ delta: { content: text.slice(i, i + step) }, index: 0 }] };
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 1200, completion_tokens: 400, total_tokens: 1600 } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Models the mock advertises, mirroring a real relay's catalogue. */
const MODELS = [
  "deepseek-v4.1-flash",
  "gemini-3.1-pro-preview",
  "gpt-6-astra",
  "claude-opus-4-8",
  "some-other-model",
];

export function startMockLlm({ port = 0, host = "127.0.0.1" } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith("/models") && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id, object: "model" })) }));
      return;
    }
    if (!req.url.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }
    let body;
    try {
      body = await parseBody(req);
    } catch {
      res.writeHead(400).end("bad body");
      return;
    }

    const reply = buildReply(body);
    if (reply.httpError) {
      res.writeHead(reply.httpError, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: reply.message } }));
      return;
    }
    if (reply.emptyNonStream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (reply.emptyChoices) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (body.stream) {
      sse(res, reply.content);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { role: "assistant", content: reply.content }, finish_reason: "stop", index: 0 }],
        usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1200 },
      }),
    );
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port: actual } = server.address();
      resolve({ server, port: actual, baseUrl: `http://${host}:${actual}/v1` });
    });
  });
}
