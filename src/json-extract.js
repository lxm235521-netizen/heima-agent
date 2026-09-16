/** Tolerant extraction of a JSON object from a model reply. */

/** Remove a wrapping markdown fence if present, else return the input unchanged. */
function stripFence(input) {
  const s = input.trim();
  const fence = s.match(/^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```\s*$/);
  return fence ? fence[1].trim() : s;
}

/**
 * Scan for the first balanced JSON object, ignoring braces inside string literals.
 * Handles the common failure mode where a model prefixes its answer with chatter
 * or emits several objects in sequence.
 * @returns {string|null} the balanced substring, or null when unbalanced
 */
export function findBalancedObject(input) {
  const start = input.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse a model reply into an object.
 * @returns {{ ok: true, value: object, strategy: string } | { ok: false, error: string, raw: string }}
 */
export function extractJson(input) {
  const raw = String(input ?? "");
  if (!raw.trim()) return { ok: false, error: "模型返回为空。", raw };

  const candidates = [];
  const defenced = stripFence(raw);
  if (defenced !== raw) candidates.push(["fence-stripped", defenced]);
  candidates.push(["direct", raw]);
  const balanced = findBalancedObject(defenced);
  if (balanced) candidates.push(["balanced-scan", balanced]);

  let lastError = "未找到 JSON 对象。";
  for (const [strategy, candidate] of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return { ok: true, value, strategy };
      }
      lastError = "解析成功但不是 JSON 对象。";
    } catch (err) {
      lastError = err.message;
    }
  }
  return { ok: false, error: `${lastError}`, raw };
}
