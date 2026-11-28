import { describe, expect, it } from "vite-plus/test";

import { createPdfOcrQueue } from "./pdfOcrQueue";

describe("recognition queue", () => {
  it("runs the highest priority first, in arrival order, and drops cancelled work", async () => {
    const queue = createPdfOcrQueue(1);
    const ran: string[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.add(1, async () => {
      ran.push("first");
      await blocker;
    });
    // The first job takes the only slot before the others arrive.
    await Promise.resolve();
    const all: Array<Promise<void>> = [];
    const job = (name: string, priority: number) => {
      let done!: () => void;
      all.push(
        new Promise((resolve) => {
          done = resolve;
        }),
      );
      return queue.add(priority, async () => {
        ran.push(name);
        done();
      });
    };
    job("search-a", 1);
    const late = job("search-b", 1);
    job("visible", 2);
    const dropped = job("left-view", 2);
    expect(dropped.cancel()).toBe(true);
    all.pop();
    late.setPriority(3);
    release();
    await Promise.all(all);
    expect(ran).toEqual(["first", "search-b", "visible", "search-a"]);
    // Work that has run can no longer be cancelled.
    expect(late.cancel()).toBe(false);
  });
});
