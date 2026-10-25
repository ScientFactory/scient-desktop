import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, type VoiceModelsSnapshot } from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

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
  async function _setupFixture0(_fixture: _Fixture) {
    state.client = null;
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }

  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    state.client = null;
    vi.unstubAllGlobals();
  }

  async function render(_fixture: _Fixture) {
    await act(
      async () =>
        await _fixture.root0.rerender(
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    expect(_fixture.container.innerHTML).toBe("");
  });

  // regression: 5efa7360c1 feat(web): improve Ask in chat citations (#294) (sole guard: the only test that the control applies the ready-model gate)
  it("renders nothing until the selected model is installed and ready", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    state.client = { getModelsState: vi.fn().mockResolvedValue(snapshot("missing")) };
    await render(_fixture);
    expect(_fixture.container.innerHTML).toBe("");
  });

  it("renders compact dictation without exposing model setup for a ready selection", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    state.client = { getModelsState: vi.fn().mockResolvedValue(snapshot()) };
    await render(_fixture);
    const microphone = _fixture.container.querySelector<HTMLButtonElement>(
      '[aria-label="Dictate citation comment"]',
    );
    expect(microphone).not.toBeNull();
    expect(microphone?.dataset.presentation).toBe("compact");
    expect(microphone?.dataset.readyModelOnly).toBe("true");
    expect(state.client.getModelsState).toHaveBeenCalledOnce();
  });

  it("fails closed when runtime state cannot be verified", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    state.client = { getModelsState: vi.fn().mockRejectedValue(new Error("unavailable")) };
    await render(_fixture);
    expect(_fixture.container.innerHTML).toBe("");
  });
});

describe("selected voice readiness", () => {
  it("requires the runtime, a selection, and a ready selected model", async () => {
    await using _fixture = _createFixture();

    expect(hasReadySelectedVoiceModel(snapshot())).toBe(true);
    expect(hasReadySelectedVoiceModel(snapshot("missing"))).toBe(false);
    expect(hasReadySelectedVoiceModel(snapshot("ready", { runtimeAvailable: false }))).toBe(false);
    expect(hasReadySelectedVoiceModel(snapshot("ready", { selectedModelId: null }))).toBe(false);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
