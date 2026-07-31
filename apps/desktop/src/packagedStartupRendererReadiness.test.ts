import { describe, expect, it, vi } from "vitest";

import {
  PACKAGED_RENDERER_READINESS_EXPRESSION,
  waitForPackagedRendererReadiness,
} from "./packagedStartupRendererReadiness";

function evaluateRendererReadiness(input: {
  readonly readyState: string;
  readonly rendererReady?: string;
}): boolean {
  const evaluate = new Function(
    "document",
    `return ${PACKAGED_RENDERER_READINESS_EXPRESSION};`,
  ) as (document: unknown) => boolean;

  return evaluate({
    readyState: input.readyState,
    documentElement: {
      dataset: {
        ...(input.rendererReady === undefined ? {} : { scientRendererReady: input.rendererReady }),
      },
    },
  });
}

describe("packaged renderer readiness", () => {
  it("requires both a complete document and the renderer-owned React commit marker", () => {
    expect(evaluateRendererReadiness({ readyState: "loading", rendererReady: "true" })).toBe(false);
    expect(evaluateRendererReadiness({ readyState: "complete" })).toBe(false);
    expect(evaluateRendererReadiness({ readyState: "complete", rendererReady: "false" })).toBe(
      false,
    );
    expect(evaluateRendererReadiness({ readyState: "complete", rendererReady: "true" })).toBe(true);
  });

  it("keeps polling until the renderer-owned marker becomes ready", async () => {
    const evaluate = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      waitForPackagedRendererReadiness(evaluate, {
        intervalMs: 0,
        timeoutMs: 10_000,
        now: () => 0,
      }),
    ).resolves.toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(3);
  });

  it("retries a temporarily unavailable renderer", async () => {
    const evaluate = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("renderer not reachable yet"))
      .mockResolvedValueOnce(true);

    await expect(
      waitForPackagedRendererReadiness(evaluate, {
        intervalMs: 0,
        timeoutMs: 10_000,
        now: () => 0,
      }),
    ).resolves.toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it("fails closed after the bounded readiness budget expires", async () => {
    const evaluate = vi.fn<() => Promise<unknown>>().mockResolvedValue(false);
    let clock = 0;

    await expect(
      waitForPackagedRendererReadiness(evaluate, {
        intervalMs: 5,
        timeoutMs: 20,
        now: () => clock,
        delay: async (ms) => {
          clock += ms;
        },
      }),
    ).resolves.toBe(false);
    expect(evaluate).toHaveBeenCalledTimes(4);
  });

  it("bounds a renderer evaluation that never settles without starting another poll", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn<() => Promise<unknown>>(() => new Promise(() => undefined));
      const readiness = waitForPackagedRendererReadiness(evaluate, {
        intervalMs: 5,
        timeoutMs: 20,
      });

      await vi.advanceTimersByTimeAsync(20);
      await expect(readiness).resolves.toBe(false);
      expect(evaluate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
