// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
  let container: HTMLDivElement;
  let root: Root;
  const onBusyChange = vi.fn();
  const onTranscript = vi.fn();
  const onRequestSubmit = vi.fn();
  beforeEach(() => {
    state.phase = "idle";
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render(phase: VoicePhase) {
    state.phase = phase;
    await act(() =>
      root.render(
        <ScientVoiceComposerControl
          onBusyChange={onBusyChange}
          onTranscript={onTranscript}
          onRequestSubmit={onRequestSubmit}
        />,
      ),
    );
  }
  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === label || button.textContent === label,
    );
    expect(button).toBeDefined();
    await act(() => button!.click());
  }

  it("retains one bridge and busy ownership through every processing state", async () => {
    await render("idle");
    for (const phase of [
      "requesting-permission",
      "recording",
      "transcribing",
      "correcting",
    ] as const) {
      await render(phase);
      expect(container.querySelector('[data-scient-voice-surface="true"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Dictate a voice message"]')).toBeNull();
    }
    await click("Use original");
    expect(state.useOriginal).toHaveBeenCalledOnce();
    await render("idle");
    expect(onBusyChange.mock.calls.map(([busy]) => busy)).toEqual([false, true, false]);
    expect(state.bridge).toHaveBeenCalledOnce();
  });

  it("clears the host's busy state when the voice control unmounts", async () => {
    await render("recording");
    await act(() => root.render(null));
    expect(onBusyChange.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
  });

  it("routes recording and processing actions without changing their meaning", async () => {
    await render("recording");
    await click("Transcribe and insert (Enter)");
    await click("Transcribe and send");
    expect(state.stop.mock.calls).toEqual([[false], [true]]);
    await click("Cancel recording (Esc)");
    await render("transcribing");
    await click("Cancel transcription");
    await render("requesting-permission");
    await click("Cancel microphone request");
    expect(state.cancel).toHaveBeenCalledTimes(3);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onRequestSubmit).not.toHaveBeenCalled();
  });

  it("keeps composer focus when the idle microphone is pressed", async () => {
    await render("idle");
    const button = container.querySelector('[aria-label="Dictate a voice message"]')!;
    const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    await act(() => button.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    await click("Dictate a voice message");
    expect(state.activate).toHaveBeenCalledOnce();
  });
});
