import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import {
  assertSandboxedPackagedArguments,
  fetchWithinDeadline,
  waitFor,
} from "./linux-appimage-smoke-support.mjs";

describe("linux AppImage smoke polling", () => {
  it("fails closed if a packaged command disables Electron's sandbox", () => {
    expect(() =>
      assertSandboxedPackagedArguments(["--disable-gpu", "--no-sandbox"]),
    ).toThrow("must not disable Electron's sandbox");
    expect(() => assertSandboxedPackagedArguments(["--disable-gpu"])).not.toThrow();
  });

  it("aborts a request that accepts a connection but never responds", async () => {
    const sockets = new Set();
    const server = createServer(() => {
      // Deliberately leave the request open to model a wedged health or CDP endpoint.
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server port.");
      const startedAt = Date.now();

      await expect(
        waitFor(
          "non-responsive endpoint",
          ({ deadline }) =>
            fetchWithinDeadline(`http://127.0.0.1:${address.port}/health`, {
              deadline,
              attemptTimeoutMs: 50,
              consume: (response) => response.ok,
            }),
          180,
        ),
      ).rejects.toThrow(/Timed out waiting for non-responsive endpoint/u);

      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    }
  });
});
