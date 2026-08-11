import { describe, expect, it, vi } from "vite-plus/test";

import { routeCompletedVoiceTranscription } from "./useScientVoiceController.ts";

describe("routeCompletedVoiceTranscription", () => {
  it("routes an in-flight result through the latest render callbacks", () => {
    const staleTranscript = vi.fn();
    const staleSubmit = vi.fn();
    const pendingTranscript = vi.fn();
    const callbacksRef = {
      current: {
        onTranscript: staleTranscript,
        onRequestSubmit: staleSubmit as (() => void) | undefined,
      },
    };
    const scheduled: Array<() => void> = [];

    callbacksRef.current = {
      onTranscript: pendingTranscript,
      onRequestSubmit: undefined,
    };
    routeCompletedVoiceTranscription(callbacksRef, "pending answer", true, (callback) => {
      scheduled.push(callback);
    });

    expect(staleTranscript).not.toHaveBeenCalled();
    expect(pendingTranscript).toHaveBeenCalledOnce();
    expect(pendingTranscript).toHaveBeenCalledWith("pending answer");
    expect(scheduled).toHaveLength(0);
    expect(staleSubmit).not.toHaveBeenCalled();
  });

  it("resolves submission again when the scheduled frame runs", () => {
    const firstSubmit = vi.fn();
    const latestSubmit = vi.fn();
    const callbacksRef = {
      current: {
        onTranscript: vi.fn(),
        onRequestSubmit: firstSubmit as (() => void) | undefined,
      },
    };
    let scheduled: (() => void) | undefined;

    routeCompletedVoiceTranscription(callbacksRef, "dictation", true, (callback) => {
      scheduled = callback;
    });
    callbacksRef.current = {
      onTranscript: vi.fn(),
      onRequestSubmit: latestSubmit,
    };
    scheduled?.();

    expect(firstSubmit).not.toHaveBeenCalled();
    expect(latestSubmit).toHaveBeenCalledOnce();
  });
});
