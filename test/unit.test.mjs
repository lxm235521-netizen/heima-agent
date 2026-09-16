import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import { extractJson, findBalancedObject } from "../src/json-extract.js";
import { validateOutput } from "../src/validate.js";
import { parseImages } from "../src/images.js";
import { loadSkill } from "../src/prompts.js";

/* ------------------------------------------------------------- fixtures */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Build a real, decodable PNG of the requested size. */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 3)] = 0;
    for (let x = 0; x < width; x += 1) {
      const o = y * (1 + width * 3) + 1 + x * 3;
      raw[o] = 32; raw[o + 1] = 200; raw[o + 2] = 120;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeGif(width, height) {
  const b = Buffer.alloc(20);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

const dataUrl = (buf, mime) => ({ name: `t.${mime.split("/")[1]}`, dataUrl: `data:${mime};base64,${buf.toString("base64")}` });

/* ---------------------------------------------------------- json-extract */
test("extractJson: plain object", () => {
  const r = extractJson('{"a":1}');
  assert.equal(r.ok, true);
  assert.equal(r.value.a, 1);
});

test("extractJson: strips a markdown fence", () => {
  const r = extractJson('```json\n{"mode":"T2VA"}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.value.mode, "T2VA");
});

test("extractJson: tolerates prose before and after", () => {
  const r = extractJson('Here you go:\n{"mode":"I2VA","prompt":"x"}\nHope that helps!');
  assert.equal(r.ok, true);
  assert.equal(r.value.mode, "I2VA");
});

test("extractJson: ignores braces inside strings", () => {
  const raw = '{"prompt":"a { b } c","n":1}';
  assert.equal(findBalancedObject(raw), raw);
  assert.equal(extractJson(raw).value.prompt, "a { b } c");
});

test("extractJson: rejects non-JSON", () => {
  assert.equal(extractJson("sorry, I cannot").ok, false);
  assert.equal(extractJson("").ok, false);
});

/* ------------------------------------------------------------- validate */
const BASE_PROMPT = `integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium-wide shot frames a baker opening the wooden shutters of a small street bakery before sunrise. The camera pushes in with small amplitude at slow speed as the middle-aged baker with a calm, slightly raspy voice (S1) sets a fresh loaf on the counter and says: <d>[English] First batch of the morning.</d> Warm light from the oven spills across the tiled floor while trays of dough rest on a floured steel rack behind him, and the empty street outside stays deep blue and quiet. [Shot 2] At 00:05.000, the camera cuts to a close-up of steam curling off the sliced bread, then tilts up to the baker's hands dusting flour from his apron as his final words carry over from the previous shot.

overall_soundscape: Wooden shutters scrape open over a quiet street as metal trays clink softly inside the bakery. The doorbell rings once, followed by light footsteps on tile and the crisp sound of a knife slicing through crust.

non_diegetic_music: A soft acoustic-guitar pattern at a moderate tempo, joined by sparse upright-bass notes and a gentle fade at the end.`;

/** A Ref2VA fixture padded to the guide's 350-500 word expectation. */
const REF_BODY = (extra = "") => `subject_definitions:
<Subject 1> is the young woman in <Picture 1>, with long dark hair, a blue cardigan, and a thin silver necklace.
<Picture 1> is the first frame of [Shot 1], showing the woman seated beside a rain-covered café window.

summary:
[reference generation] The target video holds on <Subject 1> at the café window as she lifts her gaze from a letter and speaks a single line, using <Picture 1> as the opening composition.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - her identity, long dark hair, blue cardigan, and silver necklace are retained.
<Picture 1> ([Shot 1] first frame): fully_preserved - the framing, seat position, and window reflections are reused.

detailed_description:
The target video is in a realistic, cinematic style with soft overcast daylight filtered through wet glass and a gently desaturated color palette.
[Shot 1] The shot begins from <Picture 1>, the woman seated beside the rain-covered window with her long dark hair falling over the blue cardigan. She holds a folded letter loosely in both hands, her thumb resting on the crease, and behind her the carriage interior stretches back in soft focus with steel luggage racks and pale overhead lighting. Rainwater beads on the glass and slides in slow, irregular trails that distort the passing city lights into long vertical streaks. <Subject 1> (S1) lifts her gaze from the paper toward the window, and her reflection drifts across the glass as the camera trucks right with small amplitude at slow speed, keeping her shoulders in the left third of the frame. The quiet, breathy young woman (S1) says, <d>[English] I get off at the next station.</d> After the line she closes her lips, folds the letter along its existing crease, and presses it flat against her knee, and the camera settles into a static shot while the rain continues to streak the window behind her.${extra}

overall_soundscape: The train wheels produce a steady metallic rhythm beneath a low ventilation hum that never changes. Rain ticks against the window glass while the letter rustles softly in her hands, and a distant door slides shut somewhere behind her.

non_diegetic_music: Sustained cello notes at a slow tempo with widely spaced piano tones, gradually decreasing in volume as the shot ends.`;

function refOut(overrides = {}) {
  return { mode: "Ref2VA", duration_sec: 8, ratio: "16:9", shot_count: 1, prompt: REF_BODY(), ...overrides };
}

function baseOut(overrides = {}) {
  return { mode: "T2VA", duration_sec: 10, ratio: "16:9", shot_count: 2, prompt: BASE_PROMPT, ...overrides };
}

/**
 * Insert `n` filler sentences into the multimodal description so a mutated fixture
 * clears the word-count advisory and the test isolates one rule at a time.
 * @param {string} prompt
 * @param {number} [n]
 */
function fill(prompt, n = 25) {
  const sentence =
    "Dust drifts slowly through the narrow beam of light while the camera holds its framing on the quiet room around them.";
  if (!prompt.includes("overall_soundscape:")) return prompt;
  return prompt.replace(
    "overall_soundscape:",
    `${Array.from({ length: n }, () => sentence).join(" ")}\n\noverall_soundscape:`,
  );
}

test("validate: a well-formed T2VA prompt passes cleanly", () => {
  const { errors, warnings, stats } = validateOutput(baseOut());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(stats.shotCount, 2);
  assert.equal(stats.cutCount, 1);
  assert.equal(stats.dialogueCount, 1);
});

test("validate: missing core field is an error", () => {
  const broken = baseOut({ prompt: fill(BASE_PROMPT).replace("overall_soundscape:", "ambience:") });
  const { errors } = validateOutput(broken);
  assert.ok(errors.some((e) => e.includes("overall_soundscape")), errors.join(" | "));
});

test("validate: wrong field order is an error", () => {
  const reordered = `non_diegetic_music: A soft guitar.

${fill(BASE_PROMPT)}`;
  const { errors } = validateOutput(baseOut({ prompt: reordered }));
  assert.ok(errors.some((e) => e.includes("顺序")), errors.join(" | "));
});

test("validate: mode/content family mismatch is an error", () => {
  const declaredBase = validateOutput(baseOut({ prompt: REF_BODY() }));
  assert.ok(declaredBase.errors.some((e) => e.includes("subject_definitions")), declaredBase.errors.join(" | "));

  const declaredRef = validateOutput({ mode: "Ref2VA", duration_sec: 10, prompt: BASE_PROMPT });
  assert.ok(declaredRef.errors.some((e) => e.includes("detailed_description")), declaredRef.errors.join(" | "));
});

test("validate: Ref2VA six-section output passes", () => {
  const { errors, warnings } = validateOutput(refOut());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, [], warnings.join(" | "));
});

test("validate: undefined reference label is flagged", () => {
  const prompt = REF_BODY().replace(
    "detailed_description:\nThe target video",
    "summary:\n[reference generation] <Subject 2> enters.\n\ndetailed_description:\nThe target video",
  );
  const { warnings } = validateOutput(refOut({ prompt }));
  assert.ok(warnings.some((w) => w.includes("<Subject 2>")), warnings.join(" | "));
});

test("validate: speaker id inside retention_analysis is flagged", () => {
  const prompt = REF_BODY().replace(
    "<Subject 1> (appears in [Shot 1]): fully_preserved",
    "<Subject 1> (S1) (appears in [Shot 1]): fully_preserved",
  );
  const { warnings } = validateOutput(refOut({ prompt }));
  assert.ok(warnings.some((w) => w.includes("retention_analysis")), warnings.join(" | "));
});

test("validate: non-increasing cut times are an error", () => {
  const prompt = `integrated_multimodal_description: [Shot 1] Live-action, cinematic, a wide shot.
[Shot 2] At 00:05.000, the camera cuts to a close-up.
[Shot 3] At 00:03.000, the camera cuts to another angle.

overall_soundscape: Room tone.

non_diegetic_music: N/A`;
  const { errors } = validateOutput(baseOut({ prompt, shot_count: 3 }));
  assert.ok(errors.some((e) => e.includes("递增")), errors.join(" | "));
});

test("validate: a cut at or beyond the duration is an error", () => {
  const prompt = BASE_PROMPT.replace("00:05.000", "00:10.000");
  const { errors } = validateOutput(baseOut({ prompt, duration_sec: 10 }));
  assert.ok(errors.some((e) => e.includes("之外")), errors.join(" | "));
});

test("validate: out-of-range durations are an error", () => {
  assert.ok(validateOutput(baseOut({ duration_sec: 3 })).errors.some((e) => e.includes("4-15")));
  assert.ok(validateOutput(baseOut({ duration_sec: 16 })).errors.some((e) => e.includes("4-15")));
});

test("validate: unknown mode is an error", () => {
  const { errors } = validateOutput(baseOut({ mode: "T2V" }));
  assert.ok(errors.some((e) => e.includes("mode")), errors.join(" | "));
});

test("validate: dialogue without a language tag is an error", () => {
  const prompt = fill(
    BASE_PROMPT.replace("<d>[English] First batch of the morning.</d>", "<d>First batch of the morning.</d>"),
    20,
  );
  const { errors } = validateOutput(baseOut({ prompt }));
  assert.ok(errors.some((e) => e.includes("语言标签")), errors.join(" | "));
});

test("validate: I2VA must open with the official alignment instruction", () => {
  const missing = validateOutput(baseOut({ mode: "I2VA" }));
  assert.ok(missing.errors.some((e) => e.includes("对齐指令")), missing.errors.join(" | "));

  const prompt = `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

${BASE_PROMPT}`;
  const ok = validateOutput(baseOut({ mode: "I2VA", prompt, duration_sec: 10 }));
  assert.deepEqual(ok.errors, []);
});

/* --------------------------------------------------------------- images */
test("parseImages: reads true PNG dimensions from the header", () => {
  const { images } = parseImages([dataUrl(makePng(640, 360), "image/png")]);
  assert.equal(images.length, 1);
  assert.equal(images[0].mime, "image/png");
  assert.equal(images[0].width, 640);
  assert.equal(images[0].height, 360);
});

test("parseImages: reads GIF dimensions", () => {
  const { images } = parseImages([dataUrl(makeGif(320, 240), "image/gif")]);
  assert.equal(images[0].mime, "image/gif");
  assert.equal(images[0].width, 320);
  assert.equal(images[0].height, 240);
});

test("parseImages: corrects a lying declared mime type", () => {
  const { images, warnings } = parseImages([dataUrl(makePng(64, 64), "image/jpeg")]);
  assert.equal(images[0].mime, "image/png");
  assert.ok(warnings.some((w) => w.includes("实际是")), warnings.join(" | "));
});

test("parseImages: rejects non-images and malformed data URLs", () => {
  assert.throws(() => parseImages([{ dataUrl: "data:text/plain;base64,aGVsbG8=" }]), /不是 PNG/);
  assert.throws(() => parseImages([{ dataUrl: "https://example.com/a.png" }]), /data URL/);
  assert.throws(() => parseImages([{ dataUrl: "data:image/png;base64," }]), /为空/);
});

test("parseImages: enforces the 9-image H3 limit", () => {
  const many = Array.from({ length: 10 }, () => dataUrl(makePng(16, 16), "image/png"));
  assert.throws(() => parseImages(many), /最多支持 9 张/);
});

test("parseImages: warns on a low-resolution reference image", () => {
  const { warnings } = parseImages([dataUrl(makePng(64, 64), "image/png")]);
  assert.ok(warnings.some((w) => w.includes("分辨率偏低")), warnings.join(" | "));
});
