/**
 * Web UI authentication.
 *
 * Design decisions, in order of importance:
 *
 * 1. The password is never stored in plaintext. `config.local.json` holds a scrypt
 *    hash with a random per-install salt. Verification is a constant-time compare.
 * 2. Sessions live in memory, not in the cookie. The cookie carries only an opaque
 *    random token, so a leaked hash cannot be replayed as a session. Restarting the
 *    service invalidates every session, which is the safe default.
 * 3. Login attempts are rate limited. This service is meant to sit on the public
 *    internet, where an unthrottled password form gets brute forced.
 * 4. This is the ONLY guard on /api/*. The /v1/* surface keeps its own API key, so a
 *    web login is never sufficient to spend upstream quota via the API, and vice
 *    versa.
 */
import crypto from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export const SESSION_COOKIE = "h3_session";

/** Hash a password into a self-describing string: scrypt$N$r$p$salt$hash. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

/**
 * Verify a password against a stored hash.
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored ?? "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- sessions */
/** token -> { username, expiresAt } */
const sessions = new Map();

/** Drop expired sessions; called on every access so the map cannot grow forever. */
function pruneSessions(now = Date.now()) {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

export function createSession(username) {
  pruneSessions();
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function getSession(token) {
  if (!token) return null;
  pruneSessions();
  const session = sessions.get(token);
  return session ? { username: session.username, expiresAt: session.expiresAt } : null;
}

export function destroySession(token) {
  if (token) sessions.delete(token);
}

/** Test helper: drop every session. */
export function clearSessions() {
  sessions.clear();
}

/* ----------------------------------------------------------- cookie plumbing */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * Session cookie flags.
 *
 * HttpOnly: script cannot read it, so an XSS cannot steal the session.
 * SameSite=Strict: the browser will not attach it to cross-site requests, which is
 *   what stops CSRF on the config-changing endpoints.
 * Secure is added only when the request arrived over HTTPS — setting it on a plain
 *   HTTP deployment would make the cookie unusable and lock everyone out.
 */
export function sessionCookie(token, { secure, maxAgeSec = Math.floor(SESSION_TTL_MS / 1000) } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie({ secure } = {}) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Should the session cookie carry the `Secure` flag?
 *
 * Only when the connection really is encrypted. `X-Forwarded-Proto` is deliberately NOT
 * trusted here: a proxy, a browser extension, or a corporate middlebox that adds that
 * header would otherwise mark the cookie Secure on a plain-HTTP deployment. The browser
 * then refuses to store it, so login appears to succeed and every following request is
 * unauthenticated — a very confusing failure.
 *
 * A TLS-terminating proxy is handled explicitly with H3_COOKIE_SECURE=1 instead of by
 * guessing from a header.
 */
export function shouldUseSecureCookie(req) {
  if (isEncrypted(req)) return true;
  const override = String(process.env.H3_COOKIE_SECURE ?? "").trim().toLowerCase();
  if (override === "1" || override === "true") return true;
  return false;
}

/** True when the socket itself is TLS. */
function isEncrypted(req) {
  return Boolean(req.socket?.encrypted);
}

/**
 * Diagnostic snapshot of what the client sent, used when a login "does nothing".
 * @returns {string}
 */
export function describeRequest(req) {
  return JSON.stringify({
    remote: req.socket?.remoteAddress ?? "?",
    host: req.headers.host ?? "?",
    forwardedProto: req.headers["x-forwarded-proto"] ?? null,
    forwardedFor: req.headers["x-forwarded-for"] ?? null,
    encrypted: isEncrypted(req),
  });
}

/* --------------------------------------------------------- login throttling */
/** key -> { failures, firstAt, blockedUntil } */
const attempts = new Map();

export function loginAllowed(key, now = Date.now()) {
  const entry = attempts.get(key);
  if (!entry) return { allowed: true };
  if (entry.blockedUntil && entry.blockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  // Window elapsed: start fresh.
  if (now - entry.firstAt > FAILURE_WINDOW_MS) attempts.delete(key);
  return { allowed: true };
}

export function recordFailure(key, now = Date.now()) {
  const entry = attempts.get(key) ?? { failures: 0, firstAt: now, blockedUntil: 0 };
  if (now - entry.firstAt > FAILURE_WINDOW_MS) {
    entry.failures = 0;
    entry.firstAt = now;
  }
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.blockedUntil = now + FAILURE_WINDOW_MS;
    entry.failures = 0;
    entry.firstAt = now;
  }
  attempts.set(key, entry);
  return { failures: entry.failures, blockedUntil: entry.blockedUntil };
}

export function recordSuccess(key) {
  attempts.delete(key);
}

/** Test helper. */
export function clearAttempts() {
  attempts.clear();
}

export const __testing = { SESSION_TTL_MS, MAX_FAILURES, FAILURE_WINDOW_MS, sessions, attempts };
