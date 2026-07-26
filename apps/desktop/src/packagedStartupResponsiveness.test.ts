import { describe, expect, test, vi } from "vitest";

import { waitForPackagedBackendResponsiveness } from "./packagedStartupResponsiveness";

describe("waitForPackagedBackendResponsiveness", () => {
  test("keeps polling through a cold backend until semantic readiness", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startupReady: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startupReady: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await expect(
      waitForPackagedBackendResponsiveness("http://127.0.0.1:12345", {
        fetchImpl,
        intervalMs: 0,
        timeoutMs: 100,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("does not treat malformed health payloads as ready", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startupReady: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await expect(
      waitForPackagedBackendResponsiveness("http://127.0.0.1:12345", {
        fetchImpl,
        intervalMs: 0,
        timeoutMs: 100,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
