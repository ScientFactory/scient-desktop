import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";
import type { VoicePhase } from "./useScientVoiceController.ts";

const state = vi.hoisted(() => ({
  phase: "idle" as VoicePhase,
  bridge: vi.fn(() => ({})),
  activate: vi.fn(),
  cancel: vi.fn(),
  stop: vi.fn(),
  useOriginal: vi.fn(),
}));
vi.mock("./voiceClient.ts", async (original) => ({
  ...(await original<typeof import("./voiceClient.ts")>()),
  getVoiceBridge: state.bridge,
}));
vi.mock("./useScientVoiceController.ts", async (original) => ({
  ...(await original<typeof import("./useScientVoiceController.ts")>()),
  useScientVoiceController: () => ({
    phase: state.phase,
    levels: [0.1],
    elapsedMs: 22_000,
    errorMessage: null,
    microphonePermissionDenied: false,
    downloadPercent: 0,
    modelSnapshot: null,
    activate: state.activate,
    cancel: state.cancel,
    stop: state.stop,
    useOriginal: state.useOriginal,
  }),
}));
import { ScientVoiceComposerControl } from "./ScientVoiceComposerControl.tsx";

describe("voice presentation lifetime", () => {
  const onBusyChange = vi.fn();
  const onTranscript = vi.fn();
  const onRequestSubmit = vi.fn();
  async function _setupFixture0(_fixture: _Fixture) {
    state.phase = "idle";
    vi.clearAllMocks();

    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    vi.unstubAllGlobals();
  }
  async function render(_fixture: _Fixture, phase: VoicePhase) {
    state.phase = phase;
    await act(
      async () =>
        await _fixture.root0.rerender(
          <ScientVoiceComposerControl
            onBusyChange={onBusyChange}
            onTranscript={onTranscript}
            onRequestSubmit={onRequestSubmit}
          />,
        ),
    );
  }
  async function click(_fixture: _Fixture, label: string) {
    const button = [..._fixture.container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === label || button.textContent === label,
    );
    expect(button).toBeDefined();
    await act(() => button!.click());
  }

  it("retains one bridge and busy ownership through every processing state", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, "idle");
    for (const phase of [
      "requesting-permission",
      "recording",
      "transcribing",
      "correcting",
    ] as const) {
      await render(_fixture, phase);
      expect(_fixture.container.querySelector('[data-scient-voice-surface="true"]')).not.toBeNull();
      expect(_fixture.container.querySelector('[aria-label="Dictate a voice message"]')).toBeNull();
    }
    await click(_fixture, "Use original");
    expect(state.useOriginal).toHaveBeenCalledOnce();
    await render(_fixture, "idle");
    expect(onBusyChange.mock.calls.map(([busy]) => busy)).toEqual([false, true, false]);
    expect(state.bridge).toHaveBeenCalledOnce();
  });

  it("clears the host's busy state when the voice control unmounts", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, "recording");
    await act(async () => await _fixture.root0.rerender(null));
    expect(onBusyChange.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
  });

  it("routes recording and processing actions without changing their meaning", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, "recording");
    await click(_fixture, "Transcribe and insert (Enter)");
    await click(_fixture, "Transcribe and send");
    expect(state.stop.mock.calls).toEqual([[false], [true]]);
    await click(_fixture, "Cancel recording (Esc)");
    await render(_fixture, "transcribing");
    await click(_fixture, "Cancel transcription");
    await render(_fixture, "requesting-permission");
    await click(_fixture, "Cancel microphone request");
    expect(state.cancel).toHaveBeenCalledTimes(3);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onRequestSubmit).not.toHaveBeenCalled();
  });

  it("keeps composer focus when the idle microphone is pressed", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, "idle");
    const button = _fixture.container.querySelector('[aria-label="Dictate a voice message"]')!;
    const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    await act(() => button.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    await click(_fixture, "Dictate a voice message");
    expect(state.activate).toHaveBeenCalledOnce();
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
