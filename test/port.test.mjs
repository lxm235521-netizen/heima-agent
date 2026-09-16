/**
 * Port binding behaviour.
 *
 * Regression guard for a real incident: the server used to shift to the next free port
 * silently when the configured one was taken. On the developer's machine an unrelated
 * program held 8787, so the service came up on 8788 while .env still said 8787 — the
 * documented URL, the NewAPI channel config and the actual listener all disagreed, with
 * no error shown anywhere.
 *
 * Failing loudly is the fix; port shifting is now opt-in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { startServer } from "../src/server.mjs";

/** Occupy a port so the next bind attempt fails. */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", () => resolve(blocker));
  });
}

/** Ask the OS for a free port by binding and releasing it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

test("a free port binds exactly as requested", async () => {
  const port = await freePort();
  const app = await startServer({ port, host: "127.0.0.1", allowPortShift: false });
  try {
    assert.equal(app.port, port);
    assert.equal(app.requestedPort, port);
    assert.equal(app.portShifted, false);
    assert.equal(app.url, `http://127.0.0.1:${port}`);
  } finally {
    await close(app.server);
  }
});

test("an occupied port fails loudly instead of silently shifting", async () => {
  const port = await freePort();
  const blocker = await occupy(port);
  try {
    await assert.rejects(
      () => startServer({ port, host: "127.0.0.1", allowPortShift: false }),
      (err) => {
        // The message has to name the port and say what to do — a bare EADDRINUSE is
        // what made the original incident hard to diagnose.
        assert.match(err.message, new RegExp(String(port)));
        assert.match(err.message, /占用/);
        assert.match(err.message, /PORT/);
        return true;
      },
    );
  } finally {
    await close(blocker);
  }
});

test("port shifting works when explicitly opted in, and reports it", async () => {
  const port = await freePort();
  const blocker = await occupy(port);
  try {
    const app = await startServer({ port, host: "127.0.0.1", allowPortShift: true, maxPortTries: 5 });
    try {
      assert.equal(app.requestedPort, port);
      assert.notEqual(app.port, port, "it should have moved off the occupied port");
      assert.equal(app.portShifted, true, "the caller must be able to detect the shift");
    } finally {
      await close(app.server);
    }
  } finally {
    await close(blocker);
  }
});

test("shifting stops after maxPortTries rather than scanning forever", async () => {
  const port = await freePort();
  const blockers = [];
  try {
    // Occupy the requested port plus the next two.
    for (let i = 0; i < 3; i += 1) blockers.push(await occupy(port + i));
    await assert.rejects(
      () => startServer({ port, host: "127.0.0.1", allowPortShift: true, maxPortTries: 2 }),
      /占用/,
    );
  } finally {
    for (const b of blockers) await close(b);
  }
});
