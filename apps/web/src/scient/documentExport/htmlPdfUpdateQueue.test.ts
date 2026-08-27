import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createHtmlPdfUpdateQueue } from "./htmlPdfUpdateQueue";

afterEach(() => {
  vi.useRealTimers();
});

describe("HTML PDF update queue", () => {
  it("coalesces rapid automatic changes into one delayed update", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const queue = createHtmlPdfUpdateQueue(run);

    queue.schedule(false);
    queue.schedule(false);
    queue.schedule(false);
    await vi.advanceTimersByTimeAsync(299);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(false);
  });

  it("serializes updates and keeps only one rerun with manual priority", async () => {
    vi.useFakeTimers();
    let finishFirst: () => void = () => {
      throw new Error("The first update did not start.");
    };
    const firstRun = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const run = vi
      .fn()
      .mockImplementationOnce(() => firstRun)
      .mockResolvedValue(undefined);
    const queue = createHtmlPdfUpdateQueue(run);

    queue.schedule(false, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();

    queue.schedule(false, 0);
    queue.schedule(true, 0);
    queue.schedule(false, 0);
    expect(run).toHaveBeenCalledOnce();

    finishFirst();
    await firstRun;
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run).toHaveBeenLastCalledWith(true);
  });

  it("does not let a pending automatic change replace a manual update", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const queue = createHtmlPdfUpdateQueue(run);

    queue.schedule(true, 0);
    queue.schedule(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(true);
  });

  it("cancels pending and queued work when its observer is disposed", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const queue = createHtmlPdfUpdateQueue(run);

    queue.schedule(false);
    queue.dispose();
    await vi.runAllTimersAsync();
    queue.schedule(true, 0);
    await vi.runAllTimersAsync();

    expect(run).not.toHaveBeenCalled();
  });
});
