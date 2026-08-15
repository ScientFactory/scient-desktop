import { describe, expect, it, vi } from "vite-plus/test";

import { createPlotlyMountQueue } from "./plotlyMountQueue";

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("Plotly mount queue", () => {
  it("does not overlap mutations of one graph div", async () => {
    const first = deferred();
    const queue = createPlotlyMountQueue();
    const order: string[] = [];

    const firstMount = queue.enqueue(async () => {
      order.push("first:start");
      await first.promise;
      order.push("first:end");
    });
    const secondMount = queue.enqueue(async () => {
      order.push("second:start");
    });

    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    first.resolve();
    await Promise.all([firstMount, secondMount]);

    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("continues after a failed mount has cleaned itself up", async () => {
    const first = deferred();
    const queue = createPlotlyMountQueue();
    const secondMount = vi.fn(async () => undefined);

    const failedMount = queue.enqueue(() => first.promise);
    const recoveredMount = queue.enqueue(secondMount);
    first.reject(new Error("mount failed"));

    await expect(failedMount).rejects.toThrow("mount failed");
    await recoveredMount;
    expect(secondMount).toHaveBeenCalledOnce();
  });
});
