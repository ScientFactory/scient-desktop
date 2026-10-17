// @effect-diagnostics nodeBuiltinImport:off -- Synthetic responses exercise the private download boundary without network or provider credentials.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { downloadManagedRuntime, verifyManagedRuntimeChecksum } from "./runtimeFiles.ts";

const roots: string[] = [];
async function input(signal = new AbortController().signal) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-download-test-"));
  roots.push(root);
  return {
    url: "https://github.com/ScientFactory/scient-agent/releases/download/v0.1.0/synthetic",
    destination: NodePath.join(root, "runtime.download"),
    allowedHosts: ["github.com", "release-assets.githubusercontent.com"],
    expectedSize: 2,
    signal,
    retryTransientResponses: true,
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("transient managed runtime downloads", () => {
  it.each([500, 502, 503, 504])(
    "recovers from HTTP %s before writing or verifying bytes",
    async (status) => {
      const request = await input();
      const cancel = vi.fn();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }))
        .mockImplementationOnce(async () => {
          await expect(NodeFSP.stat(request.destination)).rejects.toMatchObject({ code: "ENOENT" });
          return new Response("ok", { headers: { "content-length": "2" } });
        });
      vi.stubGlobal("fetch", fetch);
      await downloadManagedRuntime(request);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
      expect(await NodeFSP.readFile(request.destination, "utf8")).toBe("ok");
      await expect(
        verifyManagedRuntimeChecksum(request.destination, {
          algorithm: "sha256",
          digest: NodeCrypto.createHash("sha256").update("ok").digest("hex"),
        }),
      ).resolves.toBeUndefined();
      await expect(
        verifyManagedRuntimeChecksum(request.destination, {
          algorithm: "sha256",
          digest: "0".repeat(64),
        }),
      ).rejects.toThrow("checksum mismatch");
    },
  );

  it("keeps the existing single-attempt policy unless recovery is requested", async () => {
    const request = await input();
    const fetch = vi.fn().mockResolvedValue(new Response("unavailable", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      downloadManagedRuntime({ ...request, retryTransientResponses: false }),
    ).rejects.toThrow("HTTP 500");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404, 429])("does not retry HTTP %s", async (status) => {
    const request = await input();
    const fetch = vi.fn().mockResolvedValue(new Response("refused", { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(NodeFSP.stat(request.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds persistent failures and leaves no artifact", async () => {
    const request = await input();
    const fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("unavailable", { status: 500 })));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).rejects.toThrow("HTTP 500");
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(NodeFSP.stat(request.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels recovery without sending another request", async () => {
    const controller = new AbortController();
    const request = await input(controller.signal);
    const fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel: () => controller.abort(),
          }),
          { status: 503 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
    await expect(NodeFSP.stat(request.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains host admission when a retried response redirects", async () => {
    const request = await input();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://untrusted.invalid/runtime" },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).rejects.toThrow("host is not allowed");
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(NodeFSP.stat(request.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("shares the retry budget across redirect hops", async () => {
    const request = await input();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/first" },
        }),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/second" },
        }),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).rejects.toThrow("HTTP 503");
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      request.url,
      request.url,
      "https://release-assets.githubusercontent.com/first",
      "https://release-assets.githubusercontent.com/first",
      "https://release-assets.githubusercontent.com/second",
    ]);
    await expect(NodeFSP.stat(request.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not replenish the redirect budget when retrying", async () => {
    const request = await input();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 500 }))
      .mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 302, headers: { location: request.url } })),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).rejects.toThrow("redirect limit");
    expect(fetch).toHaveBeenCalledTimes(7);
    await expect(NodeFSP.stat(request.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels the retry delay promptly", async () => {
    const controller = new AbortController();
    const request = await input(controller.signal);
    const bodyReleased = Promise.withResolvers<void>();
    const fetch = vi.fn().mockImplementation(
      async () =>
        new Response(new ReadableStream({ cancel: () => bodyReleased.resolve() }), {
          status: 503,
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const download = downloadManagedRuntime(request);
    await bodyReleased.promise;
    await NodeTimersPromises.setImmediate();
    controller.abort();
    await expect(download).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not retry a transport exception", async () => {
    const request = await input();
    const fetch = vi.fn().mockRejectedValue(new Error("synthetic transport failure"));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).rejects.toThrow("synthetic transport failure");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not retry a truncated successful response", async () => {
    const request = await input();
    const fetch = vi.fn().mockResolvedValue(new Response("o"));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).rejects.toThrow("size does not match");
    expect(fetch).toHaveBeenCalledOnce();
    await expect(NodeFSP.stat(request.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
