import { expect, it } from "vite-plus/test";
import { makeSettledQueue } from "./settledQueue.ts";

it("starts a write only once the one before has settled, even after its caller gave up", async () => {
  const queue = makeSettledQueue();
  const first = Promise.withResolvers<void>();
  const started: Array<string> = [];
  const earlier = queue(async () => {
    started.push("first");
    await first.promise;
  });
  // The first write's caller timed out; the item is still being written.
  const later = queue(async () => {
    started.push("second");
  });
  await Promise.resolve();
  expect(started).toEqual(["first"]);
  first.resolve();
  await Promise.all([earlier, later]);
  expect(started).toEqual(["first", "second"]);
});
