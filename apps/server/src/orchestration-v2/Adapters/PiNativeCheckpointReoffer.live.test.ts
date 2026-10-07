import { it } from "@effect/vitest";
import { binary, layer } from "./PiNativeTestHarness.ts";
import { runNativeInitiatedWorkScenario } from "./PiNativeInitiatedWorkTestHarness.ts";

it.layer(layer, { excludeTestServices: true })("actual Pi provider-initiated work", (it) => {
  it.effect.skipIf(!binary)(
    "buffers and reoffers one actual native generation while its predecessor checkpoint is settling",
    () => runNativeInitiatedWorkScenario("barrier"),
    60000,
  );
});
