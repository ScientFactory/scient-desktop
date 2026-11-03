import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  scientAcpApplicationBridge,
  scientAcpAwarenessBridge,
  scientAcpProviderBridge,
  scientAntigravityBridge,
} from "./ScientAcpApplicationBridge.ts";

describe("Scient ACP application bridge", () => {
  it("puts the session's awareness in the first prompt of providers with no private seam", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: true } as const;
    const granted = scientAcpProviderBridge.composePrompt({
      prompt: "Continue.",
      state,
      capabilities: new Set(["preview", "device", "compute"]),
    });
    const runtime = scientAcpProviderBridge.runtimeInstructions?.({ harness: "ACP" });

    assert.include(granted, "Scient interaction mode: Default");
    assert.include(granted, "## Scient\nYou are in Scient");
    assert.include(granted, "## Scient Compute");
    assert.include(granted, "Scient orchestration");
    // Each block once: the device text keeps upstream's own prompt delivery.
    assert.equal(granted.split("## Scient browser").length, 2);
    assert.equal(granted.split("## Scient devices").length, 2);
    const noBrowser = scientAcpProviderBridge.composePrompt({
      prompt: "Continue.",
      state,
      capabilities: new Set(["device"]),
    });
    assert.notInclude(noBrowser, "## Scient browser");
    assert.include(runtime, "running in Scient through the ACP harness");
    assert.notInclude(runtime, "T3 Code");
  });

  it("tells Antigravity to write project files with workspace tools", () => {
    const prompt = scientAntigravityBridge.composePrompt({
      prompt: "Continue.",
      state: { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false },
      capabilities: new Set(),
    });
    assert.include(prompt, "## Scient\nYou are in Scient");
    assert.include(prompt, "Do not use Antigravity's `write_to_file` tool for project files");
  });

  it("leaves the device block to awareness on the awareness bridge", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: true } as const;
    const prompt = scientAcpApplicationBridge.composePrompt({ prompt: "Continue.", state });
    const awareness = scientAcpApplicationBridge.scientAwareness(new Set(["device"]));

    assert.notInclude(prompt, "## Scient devices");
    assert.notInclude(prompt, "## Scient\nYou are in Scient");
    assert.include(prompt, "Scient orchestration");
    assert.include(awareness, "## Scient devices");
    assert.equal(
      scientAcpApplicationBridge.composePrompt({
        prompt: "Again.",
        state,
        previousState: { ...state, hasDeviceTools: false },
      }),
      "Again.",
    );
  });

  it("builds awareness only from capabilities granted to this session", () => {
    const preview = scientAcpAwarenessBridge.scientAwareness?.(new Set(["preview"]));
    const coreOnly = scientAcpApplicationBridge.scientAwareness?.(new Set());

    assert.include(preview, "## Scient browser");
    assert.notInclude(coreOnly, "## Scient browser");
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
