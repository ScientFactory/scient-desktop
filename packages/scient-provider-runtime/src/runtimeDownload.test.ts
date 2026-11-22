// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Synthetic responses exercise the private download boundary without network or provider credentials; the slow-download case paces its body on the test clock.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  downloadManagedRuntime,
  ManagedRuntimeFileError,
  managedRuntimeFailureClass,
  managedRuntimeFailureRetryable,
  managedRuntimeRetryAfterMs,
  verifyManagedRuntimeChecksum,
} from "./runtimeFiles.ts";

vi.mock("node:timers/promises", { spy: true });
// The retry backoff resolves at once but still honours cancellation; the
// "cancels the retry delay promptly" test drives the real timer.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.mocked(NodeTimersPromises.setTimeout).mockImplementation((async (
    delay: number,
    value: unknown,
    options?: { signal?: AbortSignal },
  ) => {
    options?.signal?.throwIfAborted();
    vi.advanceTimersByTime(delay);
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
  vi.useRealTimers();
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

  it("honours a short server cooldown inside the local retry budget", async () => {
    const request = await input();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "retry-after": "7" } }))
      .mockResolvedValueOnce(new Response("ok", { headers: { "content-length": "2" } }));
    vi.stubGlobal("fetch", fetch);
    vi.mocked(NodeTimersPromises.setTimeout).mockClear();
    await downloadManagedRuntime(request);
    expect(vi.mocked(NodeTimersPromises.setTimeout).mock.calls.map(([delay]) => delay)).toEqual([
      7_000,
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["3600", "99999999999999999999999999999999999999999999999999999999999999999999999"])(
    "leaves long Retry-After %s to durable recovery without waiting locally",
    async (header) => {
      const request = await input();
      const fetch = vi.fn(
        async () => new Response("busy", { status: 429, headers: { "retry-after": header } }),
      );
      vi.stubGlobal("fetch", fetch);
      vi.mocked(NodeTimersPromises.setTimeout).mockClear();
      const failure = await downloadManagedRuntime(request).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ManagedRuntimeFileError);
      expect(managedRuntimeFailureRetryable(failure)).toBe(true);
      expect(managedRuntimeRetryAfterMs(failure)).toBe(header === "3600" ? 3_600_000 : 14_400_000);
      expect(fetch).toHaveBeenCalledOnce();
      expect(NodeTimersPromises.setTimeout).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "3600"])(
    "cancels recovery without another request (Retry-After %s)",
    async (header) => {
      const controller = new AbortController();
      const request = await input(controller.signal);
      const fetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel: () => controller.abort(),
            }),
            { status: 503, ...(header ? { headers: { "retry-after": header } } : {}) },
          ),
        ),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(downloadManagedRuntime(request)).rejects.toMatchObject({ name: "AbortError" });
      expect(fetch).toHaveBeenCalledOnce();
      await expect(NodeFSP.stat(request.destination)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

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

  it.each([undefined, "60"])(
    "cancels the retry delay promptly (Retry-After %s)",
    async (header) => {
      const controller = new AbortController();
      const request = await input(controller.signal);
      const bodyReleased = Promise.withResolvers<void>();
      const fetch = vi.fn().mockImplementation(
        async () =>
          new Response(new ReadableStream({ cancel: () => bodyReleased.resolve() }), {
            status: 503,
            ...(header ? { headers: { "retry-after": header } } : {}),
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const retryStarted = Promise.withResolvers<void>();
      const { setTimeout: waitForRetry } =
        await vi.importActual<typeof NodeTimersPromises>("node:timers/promises");
      vi.mocked(NodeTimersPromises.setTimeout).mockClear();
      using retryTimer = vi
        .spyOn(NodeTimersPromises, "setTimeout")
        .mockImplementation((...args) => {
          const waiting = waitForRetry(...args);
          retryStarted.resolve();
          return waiting;
        });
      const download = downloadManagedRuntime(request);
      await bodyReleased.promise;
      await retryStarted.promise;
      const [delay] = retryTimer.mock.calls[0]!;
      if (header) expect(delay).toBe(60_000);
      else {
        // The first wait is about two seconds, spread by up to a fifth either way.
        expect(delay).toBeGreaterThanOrEqual(1_600);
        expect(delay).toBeLessThanOrEqual(2_400);
      }
      controller.abort();
      await expect(download).rejects.toMatchObject({ name: "AbortError" });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

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

describe("downloads with Scient's own copy first", () => {
  const mirror = "https://downloads.scientfactory.com/scient-agent/v0.1.0/synthetic";
  const ok = () => new Response("ok", { headers: { "content-length": "2" } });
  async function twoSources() {
    const request = await input();
    return {
      ...request,
      url: mirror,
      fallbackUrl: request.url,
      allowedHosts: [...request.allowedHosts, "downloads.scientfactory.com"],
      checksum: {
        algorithm: "sha256" as const,
        digest: NodeCrypto.createHash("sha256").update("ok").digest("hex"),
      },
    };
  }
  const urls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([url]) => String(url));

  it.each([
    ["is down", () => new Response("busy", { status: 504 })],
    ["is missing", () => new Response("missing", { status: 404 })],
    ["is damaged", () => new Response("ko", { headers: { "content-length": "2" } })],
  ])("moves to GitHub at once when Scient's copy %s", async (_case, firstResponse) => {
    const request = await twoSources();
    const fetch = vi.fn().mockResolvedValueOnce(firstResponse()).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetch);
    vi.mocked(NodeTimersPromises.setTimeout).mockClear();
    await downloadManagedRuntime(request);
    expect(urls(fetch)).toEqual([mirror, request.fallbackUrl]);
    expect(NodeTimersPromises.setTimeout).not.toHaveBeenCalled();
    expect(await NodeFSP.readFile(request.destination, "utf8")).toBe("ok");
  });

  it("keeps trying only GitHub once Scient's copy is ruled out", async () => {
    const request = await twoSources();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetch);
    await downloadManagedRuntime(request);
    expect(urls(fetch)).toEqual([mirror, request.fallbackUrl, request.fallbackUrl]);
  });

  it.each([
    { mirrorFirst: true, fallbackElapsedMs: 0 },
    { mirrorFirst: false, fallbackElapsedMs: 0 },
    { mirrorFirst: true, fallbackElapsedMs: 10_000 },
  ])(
    "preserves the mirror cooldown after GitHub fails ($mirrorFirst, $fallbackElapsedMs)",
    async ({ mirrorFirst, fallbackElapsedMs }) => {
      vi.setSystemTime(0);
      using _random = vi.spyOn(Math, "random").mockReturnValue(0.5);
      const base = await twoSources();
      const request = mirrorFirst
        ? base
        : { ...base, url: base.fallbackUrl, fallbackUrl: base.url };
      let fallbackTries = 0;
      const fetch = vi.fn(async (url: URL) => {
        if (url.hostname === "downloads.scientfactory.com")
          return new Response("busy", { status: 429, headers: { "retry-after": "3600" } });
        if (fallbackTries++ === 0) vi.advanceTimersByTime(fallbackElapsedMs);
        return new Response("busy", { status: 503 });
      });
      vi.stubGlobal("fetch", fetch);
      const failure = await downloadManagedRuntime(request).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ManagedRuntimeFileError);
      expect(managedRuntimeFailureRetryable(failure)).toBe(true);
      expect(failure).toMatchObject({ retryAfterMs: 3_548_000 - fallbackElapsedMs });
      expect(managedRuntimeRetryAfterMs(new Error("wrapped", { cause: failure }))).toBe(
        3_548_000 - fallbackElapsedMs,
      );
      expect(urls(fetch).filter((url) => url === mirror)).toHaveLength(1);
      expect(fallbackTries).toBe(5);
      expect(fetch).toHaveBeenCalledTimes(6);
      expect(String(failure)).toContain("downloads.scientfactory.com returned HTTP 429");
      expect(String(failure)).toContain("github.com returned HTTP 503");
      vi.advanceTimersByTime(3_600_000);
      expect(managedRuntimeRetryAfterMs(failure)).toBeUndefined();
    },
  );

  it.each([false, true])(
    "exposes the longest outstanding source cooldown (reverse %s)",
    async (reverse) => {
      vi.setSystemTime(0);
      const base = await twoSources();
      const request = reverse ? { ...base, url: base.fallbackUrl, fallbackUrl: base.url } : base;
      const fetch = vi.fn(
        async (url: URL) =>
          new Response("busy", {
            status: 429,
            headers: {
              "retry-after": url.hostname === "downloads.scientfactory.com" ? "7200" : "3600",
            },
          }),
      );
      vi.stubGlobal("fetch", fetch);
      vi.mocked(NodeTimersPromises.setTimeout).mockClear();
      const failure = await downloadManagedRuntime(request).catch((cause: unknown) => cause);
      expect(managedRuntimeRetryAfterMs(failure)).toBe(7_200_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(NodeTimersPromises.setTimeout).not.toHaveBeenCalled();
    },
  );

  it("revisits a cooled source only once its deadline has elapsed", async () => {
    vi.setSystemTime(0);
    using _random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const request = await twoSources();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "7" } }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetch);
    vi.mocked(NodeTimersPromises.setTimeout).mockClear();
    await expect(downloadManagedRuntime(request)).resolves.toMatchObject({
      tries: 4,
      source: "primary",
    });
    expect(urls(fetch)).toEqual([mirror, request.fallbackUrl, request.fallbackUrl, mirror]);
    expect(vi.mocked(NodeTimersPromises.setTimeout).mock.calls.map(([delay]) => delay)).toEqual([
      2_000, 5_000,
    ]);
  });

  it("fails only when both copies fail, and names both", async () => {
    const request = await twoSources();
    const fetch = vi.fn().mockImplementation(async () => new Response("busy", { status: 504 }));
    vi.stubGlobal("fetch", fetch);
    const onRetry = vi.fn();
    await expect(downloadManagedRuntime({ ...request, onRetry })).rejects.toThrow(
      "Scient couldn't download it from either source after 10 tries. downloads.scientfactory.com returned HTTP 504. github.com returned HTTP 504.",
    );
    expect(onRetry).toHaveBeenCalledTimes(4);
    expect(urls(fetch).slice(0, 4)).toEqual([
      mirror,
      request.fallbackUrl,
      mirror,
      request.fallbackUrl,
    ]);
    await expect(NodeFSP.stat(request.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("resumable downloads", () => {
  const body = "hello";
  const checksum = {
    algorithm: "sha256" as const,
    digest: NodeCrypto.createHash("sha256").update(body).digest("hex"),
  };
  async function resumable(signal?: AbortSignal) {
    const request = await input(signal);
    const root = NodePath.dirname(request.destination);
    return {
      ...request,
      expectedSize: body.length,
      checksum,
      partialPath: NodePath.join(root, "downloads", `${checksum.digest}.part`),
    };
  }
  const header = (init: RequestInit | undefined, name: string) =>
    (init?.headers as Record<string, string> | undefined)?.[name];
  const partialContent = (from: number, text: string) =>
    new Response(text, {
      status: 206,
      headers: { "content-range": `bytes ${from}-${body.length - 1}/${body.length}` },
    });

  it("continues a cut-off download from the bytes it kept", async () => {
    const request = await resumable();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("he", { headers: { etag: '"v1"' } }))
      .mockImplementationOnce(async (_url: URL, init: RequestInit) => {
        expect(header(init, "range")).toBe("bytes=2-");
        expect(header(init, "if-range")).toBe('"v1"');
        return partialContent(2, "llo");
      });
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).resolves.toMatchObject({
      resumedBytes: 2,
      source: "primary",
      tries: 2,
      progressPercent: 100,
    });
    expect(await NodeFSP.readFile(request.destination, "utf8")).toBe(body);
    expect(await NodeFSP.readdir(NodePath.dirname(request.partialPath))).toEqual([]);
  });

  it("continues a download an earlier install left, and skips the network when it is whole", async () => {
    const request = await resumable();
    await NodeFSP.mkdir(NodePath.dirname(request.partialPath), { recursive: true });
    await NodeFSP.writeFile(request.partialPath, "hel");
    const fetch = vi.fn().mockResolvedValueOnce(partialContent(3, "lo"));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).resolves.toMatchObject({ resumedBytes: 3 });
    expect(header(fetch.mock.calls[0]![1], "if-range")).toBeUndefined();

    const whole = await resumable();
    await NodeFSP.mkdir(NodePath.dirname(whole.partialPath), { recursive: true });
    await NodeFSP.writeFile(whole.partialPath, body);
    const unused = vi.fn();
    vi.stubGlobal("fetch", unused);
    await downloadManagedRuntime(whole);
    expect(unused).not.toHaveBeenCalled();
    expect(await NodeFSP.readFile(whole.destination, "utf8")).toBe(body);
  });

  it("continues past a validator file a crash cut short", async () => {
    const request = await resumable();
    await NodeFSP.mkdir(NodePath.dirname(request.partialPath), { recursive: true });
    await NodeFSP.writeFile(request.partialPath, "he");
    await NodeFSP.writeFile(`${request.partialPath}.json`, '{"url":"https://');
    const fetch = vi.fn().mockResolvedValueOnce(partialContent(2, "llo"));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).resolves.toMatchObject({ resumedBytes: 2 });
  });

  it.each([
    ["sends the whole file", () => new Response(body)],
    ["answers a different range", () => partialContent(1, "ello")],
  ])("starts again from the beginning when the server %s", async (_case, answer) => {
    const request = await resumable();
    await NodeFSP.mkdir(NodePath.dirname(request.partialPath), { recursive: true });
    await NodeFSP.writeFile(request.partialPath, "he");
    const fetch = vi.fn().mockResolvedValueOnce(answer()).mockResolvedValueOnce(new Response(body));
    vi.stubGlobal("fetch", fetch);
    await downloadManagedRuntime(request);
    expect(await NodeFSP.readFile(request.destination, "utf8")).toBe(body);
  });

  it("downloads everything again once when the kept bytes don't verify", async () => {
    const request = await resumable();
    await NodeFSP.mkdir(NodePath.dirname(request.partialPath), { recursive: true });
    await NodeFSP.writeFile(request.partialPath, "HE");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(partialContent(2, "llo"))
      .mockImplementationOnce(async (_url: URL, init: RequestInit) => {
        expect(header(init, "range")).toBeUndefined();
        return new Response(body);
      });
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).resolves.toMatchObject({ resumedBytes: 0 });
    expect(await NodeFSP.readFile(request.destination, "utf8")).toBe(body);
  });

  it("lets the second copy continue the first copy's bytes, without its validator", async () => {
    const mirror = "https://downloads.scientfactory.com/scient-agent/v0.1.0/synthetic";
    const base = await resumable();
    const request = {
      ...base,
      url: mirror,
      fallbackUrl: base.url,
      allowedHosts: [...base.allowedHosts, "downloads.scientfactory.com"],
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("he", { headers: { etag: '"mirror"' } }))
      .mockImplementationOnce(async (_url: URL, init: RequestInit) => {
        expect(header(init, "range")).toBe("bytes=2-");
        expect(header(init, "if-range")).toBeUndefined();
        return partialContent(2, "llo");
      });
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(request)).resolves.toMatchObject({
      resumedBytes: 2,
      source: "fallback",
    });
  });

  it("says how far a failed download got, and that a later try may finish it", async () => {
    const request = await resumable();
    const reset = Object.assign(new Error("private detail"), { code: "ECONNRESET" });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("he"))
      .mockRejectedValue(new TypeError("fetch failed", { cause: reset }));
    vi.stubGlobal("fetch", fetch);
    const onFailedTry = vi.fn();
    const failure = await downloadManagedRuntime({ ...request, onFailedTry }).then(
      () => expect.unreachable("the download should fail"),
      (cause: unknown) => cause,
    );
    expect(onFailedTry).toHaveBeenCalledTimes(5);
    expect(onFailedTry.mock.calls[0]![0]).toMatchObject({ tries: 1, networkKind: "cut_off" });
    expect(onFailedTry.mock.calls.at(-1)![0]).toMatchObject({
      resumedBytes: 2,
      source: "primary",
      tries: 5,
      progressPercent: 40,
      networkKind: "reset",
    });
    expect(managedRuntimeFailureClass(failure)).toBe("network");
    expect(managedRuntimeFailureRetryable(failure)).toBe(true);
  });

  it("starts the retries afresh while a slow line keeps bringing data", async () => {
    const request = await resumable();
    const size = 8 * 1024 * 1024 + 1;
    const content = Buffer.alloc(size, 7);
    const sized = {
      ...request,
      expectedSize: size,
      checksum: {
        algorithm: "sha256" as const,
        digest: NodeCrypto.createHash("sha256").update(content).digest("hex"),
      },
    };
    const mib = 1024 * 1024;
    const fetch = vi.fn().mockImplementation(async (_url: URL, init: RequestInit) => {
      const from = Number(/bytes=(\d+)-/u.exec(header(init, "range") ?? "")?.[1] ?? 0);
      // Each try brings one more MiB, then the connection drops.
      return new Response(content.subarray(from, Math.min(from + mib, size)), {
        status: from === 0 ? 200 : 206,
        headers: from === 0 ? {} : { "content-range": `bytes ${from}-${size - 1}/${size}` },
      });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(downloadManagedRuntime(sized)).resolves.toMatchObject({
      resumedBytes: 8 * mib,
    });
    // Nine tries, more than the five a failing server gets.
    expect(fetch).toHaveBeenCalledTimes(9);
  });

  it("bounds retries when a server repeatedly replaces the same retained prefix", async () => {
    const request = await resumable();
    const content = Buffer.alloc(2 * 1024 * 1024, 7);
    const fetch = vi.fn(async () => new Response(content.subarray(0, 1024 * 1024)));
    vi.stubGlobal("fetch", fetch);
    await expect(
      downloadManagedRuntime({
        ...request,
        expectedSize: content.length,
        checksum: {
          algorithm: "sha256",
          digest: NodeCrypto.createHash("sha256").update(content).digest("hex"),
        },
      }),
    ).rejects.toThrow("cut off on all 5 tries");
    expect(fetch).toHaveBeenCalledTimes(5);
    expect((await NodeFSP.stat(request.partialPath)).size).toBe(1024 * 1024);
  });
});

describe("downloads without an overall time limit", () => {
  // regression: slow downloads failed after ten minutes while data still arrived.
  it("keeps a slow download going past ten minutes while data arrives", async () => {
    const request = { ...(await input()), expectedSize: 36 * 1024 };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // A limit built on AbortSignal.timeout would otherwise ignore the test clock.
    using _timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const limit = new AbortController();
      setTimeout(() => limit.abort(new DOMException("time limit", "TimeoutError")), ms);
      return limit.signal;
    });
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(
      new ReadableStream({ start: (controller) => (body = controller) }),
      {
        headers: { "content-length": String(request.expectedSize) },
      },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    let awaited: { readonly bytes: number; readonly resolve: () => void } | undefined;
    const download = downloadManagedRuntime({
      ...request,
      onProgress: (bytes) => {
        if (awaited && bytes >= awaited.bytes) awaited.resolve();
      },
    });
    const ended = download.then(
      () => undefined,
      () => undefined,
    );
    // Opening the file takes real time, so the clock moves on only once each KiB has arrived.
    const written = (bytes: number) =>
      Promise.race([new Promise<void>((resolve) => (awaited = { bytes, resolve })), ended]);
    // 1 KiB every 20 seconds, inside the 30-second stall bound: twelve minutes in all.
    for (let chunk = 1; chunk <= 36; chunk += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      body.enqueue(new Uint8Array(1024).fill(7));
      await written(chunk * 1024);
    }
    body.close();
    await expect(download).resolves.toMatchObject({
      tries: 1,
      progressPercent: 100,
      bytesPerSecond: Math.round(request.expectedSize / 720),
    });
  });
});

describe("managed runtime failure classes", () => {
  const failureOf = (promise: Promise<unknown>) =>
    promise.then(
      () => expect.unreachable("the download should fail"),
      (cause: unknown) => cause,
    );
  const fetchFailure = (code: string) =>
    new TypeError("fetch failed", { cause: Object.assign(new Error("private detail"), { code }) });

  it.each([
    ["a server error on every try", () => new Response("busy", { status: 504 }), "http_5xx"],
    ["a missing file", () => new Response("missing", { status: 404 }), "http_4xx"],
    [
      "a wrong size",
      () => new Response("toolong", { headers: { "content-length": "7" } }),
      "size_mismatch",
    ],
    [
      "a dropped connection on every try",
      () => Promise.reject(fetchFailure("ECONNRESET")),
      "network",
    ],
    [
      "an intercepted certificate",
      () => Promise.reject(fetchFailure("SELF_SIGNED_CERT_IN_CHAIN")),
      "certificate",
    ],
  ])("classifies %s", async (_case, response, failureClass) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(response));
    expect(managedRuntimeFailureClass(await failureOf(downloadManagedRuntime(await input())))).toBe(
      failureClass,
    );
  });

  it.each([
    ["HTTP 429 on every try", () => new Response("slow down", { status: 429 }), true],
    ["HTTP 501", () => new Response("never", { status: 501 }), false],
    ["a missing file", () => new Response("missing", { status: 404 }), false],
    [
      "an intercepted certificate",
      () => Promise.reject(fetchFailure("SELF_SIGNED_CERT_IN_CHAIN")),
      false,
    ],
  ])("says whether a later try may fix %s", async (_case, response, retryable) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(response));
    const failure = await failureOf(downloadManagedRuntime(await input()));
    expect(managedRuntimeFailureRetryable(failure)).toBe(retryable);
  });

  it("reads the remaining bounded cooldown through wrappers without hiding a longer inner one", () => {
    vi.setSystemTime(0);
    const inner = new ManagedRuntimeFileError("busy", { retryAfterMs: 99_999_999 });
    const wrapped = new ManagedRuntimeFileError("outer", { cause: inner, retryAfterMs: 1_000 });
    expect(managedRuntimeRetryAfterMs(new Error("wrapped", { cause: wrapped }))).toBe(14_400_000);
    vi.advanceTimersByTime(60_000);
    expect(inner.retryAfterMs).toBe(14_340_000);
    expect(wrapped.retryAfterMs).toBeUndefined();
    expect(managedRuntimeRetryAfterMs(wrapped)).toBe(14_340_000);
    vi.advanceTimersByTime(14_340_000);
    expect(managedRuntimeRetryAfterMs(wrapped)).toBeUndefined();
    expect(managedRuntimeRetryAfterMs(new Error("Retry-After: 3600"))).toBeUndefined();
  });

  it("classifies a damaged download, cancellation and local disk errors without reading messages", async () => {
    const request = await input();
    await NodeFSP.writeFile(request.destination, "ko");
    const damaged = await failureOf(
      verifyManagedRuntimeChecksum(request.destination, {
        algorithm: "sha256",
        digest: "0".repeat(64),
      }),
    );
    expect(managedRuntimeFailureClass(damaged)).toBe("checksum");

    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn());
    expect(
      managedRuntimeFailureClass(
        await failureOf(downloadManagedRuntime(await input(controller.signal))),
      ),
    ).toBe("cancelled");
    expect(
      managedRuntimeFailureClass(new DOMException("The operation timed out.", "TimeoutError")),
    ).toBe("timeout");

    const wrapped = (code: string) =>
      new Error("Scient could not install it.", { cause: Object.assign(new Error("x"), { code }) });
    expect(managedRuntimeFailureClass(wrapped("ENOSPC"))).toBe("disk_full");
    expect(managedRuntimeFailureClass(wrapped("EACCES"))).toBe("permission");
    for (const local of [damaged, wrapped("ENOSPC"), wrapped("EACCES")])
      expect(managedRuntimeFailureRetryable(local)).toBe(false);
    expect(
      managedRuntimeFailureClass(new ManagedRuntimeFileError("Unsafe archive path"), "installing"),
    ).toBe("extract");
    expect(managedRuntimeFailureClass(new Error("anything"), "downloading")).toBe("other");
  });
});
