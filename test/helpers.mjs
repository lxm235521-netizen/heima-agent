/**
 * Shared helpers for tests that need to talk to the web console.
 *
 * The console requires a session, and the suite runs in a single process where modules
 * share `process.env`. A test file that sets H3_WEB_PASSWORD therefore changes the
 * behaviour of every later file in the same run. Centralising the login here keeps that
 * coupling explicit instead of leaving each file to rediscover it.
 */

export const TEST_WEB_USER = "admin";
export const TEST_WEB_PASS = "test-console-password";

/**
 * Make the console usable, the way a deployment does it: credentials from the
 * environment. call this in `before()` BEFORE the first request.
 */
export function configureLogin({ username = TEST_WEB_USER, password = TEST_WEB_PASS } = {}) {
  process.env.H3_WEB_USERNAME = username;
  process.env.H3_WEB_PASSWORD = password;
}

/**
 * A fetch that carries a logged-in session cookie.
 *
 * Logs in lazily on first use, so a test file can simply call `consoleApi.get(...)`.
 * @param {string} base server origin
 */
export function createConsoleClient(base, { username = TEST_WEB_USER, password = TEST_WEB_PASS } = {}) {
  let cookiePromise = null;

  async function ensureCookie() {
    if (!cookiePromise) {
      cookiePromise = (async () => {
        const res = await fetch(`${base}/api/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
          throw new Error(`console login failed: HTTP ${res.status} ${await res.text()}`);
        }
        const raw = res.headers.getSetCookie?.() ?? [];
        const cookie = raw.map((c) => c.split(";")[0]).join("; ");
        if (!cookie) throw new Error("console login returned no Set-Cookie");
        return cookie;
      })();
    }
    return cookiePromise;
  }

  return {
    /** Reset the cached session (e.g. after a logout test). */
    reset() {
      cookiePromise = null;
    },
    async fetch(path, options = {}) {
      const cookie = await ensureCookie();
      return fetch(`${base}${path}`, {
        ...options,
        headers: { ...(options.headers ?? {}), cookie },
      });
    },
    get(path) {
      return this.fetch(path);
    },
    async json(path) {
      const res = await this.fetch(path);
      return res.json();
    },
  };
}
