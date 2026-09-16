/**
 * Incremental extraction of a JSON string field from a partial JSON document.
 *
 * Used to render the H3 prompt live while the model is still streaming, both in
 * the browser (web/app.js) and on the OpenAI-compatible endpoint
 * (src/openai-api.mjs), so the logic lives here once.
 *
 * The document is truncated at an arbitrary byte boundary, so the extractor must
 * tolerate:
 *   - the field not having appeared yet
 *   - the closing quote not having arrived yet
 *   - a chunk boundary in the middle of an escape ("\") or a \uXXXX sequence
 */

const SIMPLE_ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const ESCAPE_CHARS = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/**
 * Decode a JSON string body (the text between the quotes), tolerating truncation.
 * @returns {string|null} null when the fragment cannot be decoded yet
 */
export function decodePartialJsonString(body) {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null; // dangling backslash at the buffer edge
    if (next === "u") {
      const hex = body.slice(i + 2, i + 6);
      if (hex.length < 4) return null; // incomplete \uXXXX
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

/** Escape a literal string for embedding inside a JSON string. */
export function escapeJsonString(value) {
  let out = "";
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}

/**
 * Create a stateful extractor for one field of one JSON document.
 *
 * Call it repeatedly with progressively longer buffer prefixes and it returns
 * only the newly decoded text ("" while nothing new is available). It never
 * throws and never returns a value that would have to be retracted.
 *
 * @param {string} field top-level key to watch
 */
export function createFieldExtractor(field) {
  const marker = new RegExp(`"${field}"\\s*:\\s*"`);
  const markerText = `"${field}"`;

  // Buffer offset up to which the field value has been decoded and emitted.
  let scanned = 0;
  let emitted = 0;
  // Resolved position of the value's opening quote; -1 until the field is found.
  let valueStart = -1;
  let done = false;

  return function extract(buffer) {
    if (done || typeof buffer !== "string" || !buffer) return "";

    if (valueStart === -1) {
      const match = marker.exec(buffer);
      if (!match) {
        // Keep a tail so a marker split across chunks is still matched, but never
        // rescan the whole document on every chunk.
        scanned = Math.max(scanned, buffer.length - (markerText.length + 16));
        return "";
      }
      valueStart = match.index + match[0].length;
    }

    if (buffer.length <= scanned) return "";
    const body = buffer.slice(valueStart);
    if (body.length <= emitted) return "";

    // An unescaped closing quote ends the value: walk the body tracking escapes,
    // since a \" inside the value must not be mistaken for the terminator.
    let end = -1;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') {
        end = i;
        break;
      }
    }

    let decodable;
    if (end === -1) {
      decodable = body;
    } else {
      decodable = body.slice(0, end);
      done = true;
    }

    // Never decode a trailing partial escape (it would decode differently later).
    if (decodable.endsWith("\\")) decodable = decodable.slice(0, -1);
    else if (/\\u[0-9a-fA-F]{0,3}$/.test(decodable)) decodable = decodable.replace(/\\u[0-9a-fA-F]{0,3}$/, "");

    const full = decodePartialJsonString(decodable);
    if (full === null) return "";
    scanned = buffer.length;
    if (full.length <= emitted) return "";
    const increment = full.slice(emitted);
    emitted = full.length;
    return increment;
  };
}

/**
 * One-shot convenience wrapper: extract the whole current value of a field.
 * Returns "" while the value is not yet available.
 */
export function extractField(buffer, field) {
  const extract = createFieldExtractor(field);
  extract(buffer);
  // Re-run against the full buffer to obtain the complete value.
  const marker = new RegExp(`"${field}"\\s*:\\s*"`);
  const match = marker.exec(buffer ?? "");
  if (!match) return "";
  const body = buffer.slice(match.index + match[0].length);
  let end = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "\\") {
      i += 1;
      continue;
    }
    if (body[i] === '"') {
      end = i;
      break;
    }
  }
  const decodable = end === -1 ? body : body.slice(0, end);
  const trimmed = decodable.endsWith("\\") ? decodable.slice(0, -1) : decodable.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
  return decodePartialJsonString(trimmed) ?? "";
}
