import { expect, it } from "vite-plus/test";

import { adversarialMaskingInputs } from "./NetworkMasking.test-fixtures.ts";

it("masks each worst-case 64 KB input in under 200 ms", async ({ bench }) => {
  for (const [label, run] of adversarialMaskingInputs()) {
    const measured = await bench(`mask ${label}`, run).run({
      time: 0,
      iterations: 1,
      warmup: false,
      retainSamples: true,
    });
    expect(measured.latency.samples, label).toHaveLength(1);
    expect(measured.latency.mean, label).toBeLessThan(200);
  }
});
