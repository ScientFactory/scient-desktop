// @effect-diagnostics nodeBuiltinImport:off -- Synthetic responses exercise the private download boundary without network or provider credentials.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { downloadManagedRuntime, verifyManagedRuntimeChecksum } from "./runtimeFiles.ts";

vi.mock("node:timers/promises", { spy: true });
// The retry backoff resolves at once but still honours cancellation; the
// "cancels the retry delay promptly" test drives the real timer.
beforeEach(() => {
  vi.mocked(NodeTimersPromises.setTimeout).mockImplementation((async (
    _delay: number,
    value: unknown,
    options?: { signal?: AbortSignal },
  ) => {
    options?.signal?.throwIfAborted();
    return value;
  }) as never);
});

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
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("transient managed runtime downloads", () => {
  // regression: a5d49bba34 fix(scient-agent): recover transient managed download failures
  // Gateway codes such as 522 and 524 come from CDNs in front of release hosts.
  it.each([408, 429, 500, 502, 503, 504, 522, 524])(
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

  it.each([401, 403, 404, 501])("does not retry HTTP %s", async (status) => {
    const request = await input();
    const fetch = vi.fn().mockResolvedValue(new Response("refused", { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(NodeFSP.stat(request.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds persistent failures, reports each retry and leaves no artifact", async () => {
    const request = await input();
    const fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response("unavailable", { status: 504 })));
    vi.stubGlobal("fetch", fetch);
    const onRetry = vi.fn();
    await expect(downloadManagedRuntime({ ...request, onRetry })).rejects.toThrow(
      "The download server returned HTTP 504 on all 5 tries.",
    );
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(onRetry.mock.calls.map(([retry]) => [retry.retry, retry.retries, retry.reason])).toEqual(
      [1, 2, 3, 4].map((retry) => [retry, 4, "HTTP 504"]),
    );
    await expect(NodeFSP.stat(request.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits as long as the server asks, up to a minute", async () => {
    const request = await input();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "retry-after": "7" } }))
      .mockResolvedValueOnce(
        new Response("busy", { status: 429, headers: { "retry-after": "3600" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { headers: { "content-length": "2" } }));
    vi.stubGlobal("fetch", fetch);
    vi.mocked(NodeTimersPromises.setTimeout).mockClear();
    await downloadManagedRuntime(request);
    expect(vi.mocked(NodeTimersPromises.setTimeout).mock.calls.map(([delay]) => delay)).toEqual([
      7_000, 60_000,
    ]);
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

  it("starts each retry again from the release address", async () => {
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
      .mockResolvedValueOnce(new Response("ok", { headers: { "content-length": "2" } }));
    vi.stubGlobal("fetch", fetch);
    await downloadManagedRuntime(request);
    // A redirect target can expire, so a retry never resumes from one.
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      request.url,
      request.url,
      "https://release-assets.githubusercontent.com/first",
      request.url,
      "https://release-assets.githubusercontent.com/second",
    ]);
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
    const retryStarted = Promise.withResolvers<void>();
    const { setTimeout: waitForRetry } =
      await vi.importActual<typeof NodeTimersPromises>("node:timers/promises");
    vi.mocked(NodeTimersPromises.setTimeout).mockClear();
    using retryTimer = vi.spyOn(NodeTimersPromises, "setTimeout").mockImplementation((...args) => {
      const waiting = waitForRetry(...args);
      retryStarted.resolve();
      return waiting;
    });
    const download = downloadManagedRuntime(request);
    await bodyReleased.promise;
    await retryStarted.promise;
    const [delay] = retryTimer.mock.calls[0]!;
    // The first wait is about two seconds, spread by up to a fifth either way.
    expect(delay).toBeGreaterThanOrEqual(1_600);
    expect(delay).toBeLessThanOrEqual(2_400);
    controller.abort();
    await expect(download).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries a failed connection and names it when every try fails", async () => {
    const request = await input();
    const reset = () =>
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
    const recovered = vi
      .fn()
      .mockRejectedValueOnce(reset())
      .mockResolvedValueOnce(new Response("ok", { headers: { "content-length": "2" } }));
    vi.stubGlobal("fetch", recovered);
    await downloadManagedRuntime(request);
    expect(recovered).toHaveBeenCalledTimes(2);

    const failing = vi.fn().mockImplementation(() => Promise.reject(reset()));
    vi.stubGlobal("fetch", failing);
    await expect(downloadManagedRuntime(await input())).rejects.toThrow(
      "couldn't reach the download server on all 5 tries (connection failed, ECONNRESET)",
    );
    expect(failing).toHaveBeenCalledTimes(5);
  });

  it("does not retry a certificate that doesn't check out", async () => {
    const request = await input();
    const fetch = vi.fn().mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("self-signed certificate in certificate chain"), {
          code: "SELF_SIGNED_CERT_IN_CHAIN",
        }),
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).rejects.toThrow(
      "A proxy or security program may be intercepting the connection.",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries a download that was cut off", async () => {
    const request = await input();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("o"))
      .mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    await downloadManagedRuntime(request);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await NodeFSP.readFile(request.destination, "utf8")).toBe("ok");
  });

  it("does not retry when the file cannot be written", async () => {
    const request = await input();
    await NodeFSP.writeFile(request.destination, "taken");
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("ok", { headers: { "content-length": "2" } })),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).rejects.toMatchObject({ code: "EEXIST" });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
