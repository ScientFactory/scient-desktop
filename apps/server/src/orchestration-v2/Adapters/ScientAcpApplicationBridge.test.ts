import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  scientAcpApplicationBridge,
  scientAcpAwarenessBridge,
  scientAcpProviderBridge,
} from "./ScientAcpApplicationBridge.ts";

describe("Scient ACP application bridge", () => {
  it("keeps Scient prompt and runtime copy on the shared non-awareness bridge", () => {
    const prompt = scientAcpProviderBridge.composePrompt?.({
      prompt: "Continue.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });
    const runtime = scientAcpProviderBridge.runtimeInstructions?.({ harness: "ACP" });

    assert.include(prompt, "Scient interaction mode: Default");
    assert.include(prompt, "Scient collaborative browser");
    assert.include(prompt, "Scient orchestration");
    assert.include(runtime, "running in Scient through the ACP harness");
    assert.notInclude(runtime, "T3 Code");
  });

  it("builds awareness only from capabilities granted to this session", () => {
    const preview = scientAcpAwarenessBridge.scientAwareness?.(new Set(["preview"]));
    const coreOnly = scientAcpApplicationBridge.scientAwareness?.(new Set());

    assert.include(preview, "## Scient browser");
    assert.notInclude(coreOnly, "## Scient browser");
    assert.isFalse("scientAwareness" in scientAcpProviderBridge);
  });

  it.effect("classifies native acceptance and pre-acceptance rejection consistently", () =>
    Effect.gen(function* () {
      const acceptedAt = yield* DateTime.now;
      assert.deepEqual(
        scientAcpProviderBridge.nativeTurnAcceptance?.({ acceptedAt, promptOffered: true }),
        { nativeAcceptance: "accepted", acceptedAt },
      );
      assert.deepEqual(
        scientAcpProviderBridge.nativeTurnAcceptance?.({ acceptedAt: null, promptOffered: true }),
        { nativeAcceptance: "unknown" },
      );
      assert.deepEqual(
        scientAcpProviderBridge.nativeTurnAcceptance?.({ acceptedAt: null, promptOffered: false }),
        { nativeAcceptance: "pending" },
      );
      assert.isTrue(scientAcpProviderBridge.isPreAcceptanceRejectionCode?.(-32602));
      assert.isFalse(scientAcpProviderBridge.isPreAcceptanceRejectionCode?.(-32603));
    }),
  );
});
