import { it } from "@effect/vitest";
import { binary, layer } from "./PiNativeTestHarness.ts";
import { runNativeInitiatedWorkScenario } from "./PiNativeInitiatedWorkTestHarness.ts";

it.layer(layer, { excludeTestServices: true })("actual Pi provider-initiated work", (it) => {
  for (const scenario of ["plain", "captured", "stop", "close"] as const) {
    it.effect.skipIf(!binary)(
      scenario === "plain"
        ? "adopts one actual native extension generation as its own persisted run without another prompt"
        : scenario === "captured"
          ? "retains actual native policy, model, cwd and checkpoint-before-queue across changed defaults"
          : scenario === "stop"
            ? "stops an actual native approval wait, preserves its terminal and releases the lease for next owned reuse"
            : "settles actual accepted native work after explicit session close and next owned reuse",
      () => runNativeInitiatedWorkScenario(scenario),
      60000,
    );
  }
});
