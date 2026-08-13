import { describe, expect, it } from "vite-plus/test";

import { createSerialRequestLane } from "./NcbiRequestLane.ts";

describe("createSerialRequestLane", () => {
  it("holds the lane until the active request settles", async () => {
    let now = 0;
    const waits: number[] = [];
    const events: string[] = [];
    let finishFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const run = createSerialRequestLane({
      minimumStartIntervalMs: 350,
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });

    const first = run(async () => {
      events.push("first:start");
      await firstBlocked;
      events.push("first:end");
    });
    const second = run(async () => {
      events.push("second:start");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    finishFirst?.();
    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(waits).toEqual([350]);
  });

  it("releases the lane when a request fails", async () => {
    const run = createSerialRequestLane({
      minimumStartIntervalMs: 0,
      wait: async () => undefined,
    });

    await expect(
      run(async () => {
        throw new Error("request failed");
      }),
    ).rejects.toThrow("request failed");
    await expect(run(async () => "recovered")).resolves.toBe("recovered");
  });
});
