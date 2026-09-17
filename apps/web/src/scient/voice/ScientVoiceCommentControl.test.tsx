// @vitest-environment happy-dom
import { EnvironmentId, type VoiceModelsSnapshot } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  client: null as null | { getModelsState: ReturnType<typeof vi.fn> },
}));

vi.mock("./voiceClient.ts", () => ({
  getVoiceBridge: () => state.client,
}));

vi.mock("./ScientVoiceComposerControl.tsx", () => ({
  ScientVoiceComposerControl: ({
    ariaLabel,
    presentation,
    readyModelOnly,
  }: {
    ariaLabel: string;
    presentation: string;
    readyModelOnly: boolean;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      data-presentation={presentation}
      data-ready-model-only={String(readyModelOnly)}
    />
  ),
}));

import { ScientVoiceCommentControl } from "./ScientVoiceCommentControl.tsx";
import { hasReadySelectedVoiceModel } from "./voiceModelReadiness.ts";

const modelId = "whisper-small-multilingual-q5_1" as const;
function snapshot(
  stateName: "missing" | "ready" = "ready",
  overrides: Partial<VoiceModelsSnapshot> = {},
): VoiceModelsSnapshot {
  return {
    runtimeAvailable: true,
    selectedModelId: modelId,
    recommendation: null,
    activeDownloadModelId: null,
    models: [
      {
        id: modelId,
        displayName: "Multilingual Small",
        description: "Test model",
        byteSize: 1,
        state: stateName === "ready" ? { state: "ready", byteSize: 1 } : { state: "missing" },
      },
    ],
    ...overrides,
  };
}

describe("ready voice control for citation comments", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.client = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    state.client = null;
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(() =>
      root.render(
        <ScientVoiceCommentControl
          environmentId={EnvironmentId.make("local")}
          onTranscript={() => undefined}
        />,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("renders nothing outside the desktop voice runtime", async () => {
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing until the selected model is installed and ready", async () => {
    state.client = { getModelsState: vi.fn().mockResolvedValue(snapshot("missing")) };
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("renders compact dictation without exposing model setup for a ready selection", async () => {
    state.client = { getModelsState: vi.fn().mockResolvedValue(snapshot()) };
    await render();
    const microphone = container.querySelector<HTMLButtonElement>(
      '[aria-label="Dictate citation comment"]',
    );
    expect(microphone).not.toBeNull();
    expect(microphone?.dataset.presentation).toBe("compact");
    expect(microphone?.dataset.readyModelOnly).toBe("true");
    expect(state.client.getModelsState).toHaveBeenCalledOnce();
  });

  it("fails closed when runtime state cannot be verified", async () => {
    state.client = { getModelsState: vi.fn().mockRejectedValue(new Error("unavailable")) };
    await render();
    expect(container.innerHTML).toBe("");
  });
});

describe("selected voice readiness", () => {
  it("requires the runtime, a selection, and a ready selected model", () => {
    expect(hasReadySelectedVoiceModel(snapshot())).toBe(true);
    expect(hasReadySelectedVoiceModel(snapshot("missing"))).toBe(false);
    expect(hasReadySelectedVoiceModel(snapshot("ready", { runtimeAvailable: false }))).toBe(false);
    expect(hasReadySelectedVoiceModel(snapshot("ready", { selectedModelId: null }))).toBe(false);
  });
});
