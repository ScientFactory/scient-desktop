import { describe, expect, it, vi } from "vitest";

import { waitForBackendStartupReady } from "./backendStartupReadiness";

describe("waitForBackendStartupReady", () => {
  it("resolves from http when no listening promise is provided", async () => {
    const waitForHttpReady = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const onHttpReady = vi.fn();

    await expect(
      waitForBackendStartupReady({
        waitForHttpReady,
        onHttpReady,
      }),
    ).resolves.toBe("http");

    expect(waitForHttpReady).toHaveBeenCalledTimes(1);
    expect(onHttpReady).toHaveBeenCalledTimes(1);
  });

  it("opens from the listening signal without declaring semantic readiness", async () => {
    let resolveListening!: () => void;
    let resolveHttp!: () => void;
    const listeningPromise = new Promise<void>((resolve) => {
      resolveListening = resolve;
    });
    const waitForHttpReady = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHttp = resolve;
        }),
    );
    const onHttpReady = vi.fn();

    const resultPromise = waitForBackendStartupReady({
      listeningPromise,
      waitForHttpReady,
      onHttpReady,
    });

    resolveListening();

    await expect(resultPromise).resolves.toBe("listening");
    expect(onHttpReady).not.toHaveBeenCalled();

    resolveHttp();
    await vi.waitFor(() => expect(onHttpReady).toHaveBeenCalledTimes(1));
  });

  it("rejects when the listening promise fails before http is ready", async () => {
    const error = new Error("backend exited");

    await expect(
      waitForBackendStartupReady({
        listeningPromise: Promise.reject(error),
        waitForHttpReady: () => new Promise<void>(() => {}),
      }),
    ).rejects.toThrow("backend exited");
  });
});
