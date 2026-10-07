import { it } from "@effect/vitest";
import { binary, layer } from "./PiNativeTestHarness.ts";
import { runNativeInitiatedWorkScenario } from "./PiNativeInitiatedWorkTestHarness.ts";

it.layer(layer, { excludeTestServices: true })("actual Pi deferred native work", (it) => {
  it.effect.skipIf(!binary)(
    "admits the same native generation only after its real foreground answer and physical checkpoint",
    () => runNativeInitiatedWorkScenario("barrier-answer"),
    60000,
  );
  it.effect.skipIf(!binary)(
    "disposes a permanently foreign native offer through the worker without a producer retry",
    () => runNativeInitiatedWorkScenario("barrier-foreign"),
    60000,
  );
  it.effect.skipIf(!binary)(
    "fences foreign owners, changed instance and cwd, then session Stop and stale deferred callbacks",
    () => runNativeInitiatedWorkScenario("barrier-stop"),
    60000,
  );
});
