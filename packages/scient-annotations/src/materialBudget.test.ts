import { expect, it } from "vite-plus/test";
import { createMaterialBudget } from "./materialBudget.ts";
it("bounds whole operations across callers and releases a failed operation", async () => {
  const budget = createMaterialBudget(2);
  let active = 0;
  let peak = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 32 }, (_, i) =>
      budget(async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        if (i === 0) throw new Error("read failed");
        return i;
      }),
    ),
  );
  expect(peak).toBe(2);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(31);
  expect(await budget(async () => "next")).toBe("next");
});
it("refuses overflow without starting unbounded work or stranding later requests", async () => {
  const budget = createMaterialBudget(1, 1);
  let release!: () => void;
  const first = budget(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const second = budget(async () => "queued");
  await expect(budget(async () => "overflow")).rejects.toThrow("busy");
  release();
  await first;
  expect(await second).toBe("queued");
  expect(await budget(async () => "after")).toBe("after");
});
