// @vitest-environment happy-dom
import type {
  DesktopVoiceBridge,
  VoiceMicrophoneAccessStatus,
  VoiceModelsSnapshot,
} from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const recorder = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  status: "idle" as const,
  errorKind: null,
  levels: [],
}));
const recordAnalytics = vi.hoisted(() => vi.fn());
vi.mock("./useVoiceRecorder.ts", () => ({ useVoiceRecorder: () => recorder }));
vi.mock("../analytics/client.ts", () => ({ useRecordScientAnalytics: () => recordAnalytics }));

import {
  useScientVoiceController,
  type ScientVoiceController,
} from "./useScientVoiceController.ts";

const snapshot: VoiceModelsSnapshot = {
  runtimeAvailable: true,
  selectedModelId: "whisper-small-multilingual-q5_1",
  recommendation: null,
  activeDownloadModelId: null,
  models: [
    {
      id: "whisper-small-multilingual-q5_1",
      displayName: "Small",
      description: "Test model",
      byteSize: 1,
      state: { state: "ready", byteSize: 1 },
    },
  ],
};

function pendingPermission() {
  let resolve!: (status: VoiceMicrophoneAccessStatus) => void;
  const promise = new Promise<VoiceMicrophoneAccessStatus>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("voice native permission lifecycle", () => {
  let root: Root;
  let container: HTMLDivElement;
  let controller: ScientVoiceController;
  let client: DesktopVoiceBridge;

  function Probe() {
    const value = useScientVoiceController({ client, onTranscript: () => undefined });
    useLayoutEffect(() => {
      controller = value;
    });
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    recorder.start.mockResolvedValue(true);
    recorder.cancel.mockResolvedValue(undefined);
    client = {
      requestMicrophoneAccess: vi.fn().mockResolvedValue("granted"),
      getModelsState: vi.fn().mockResolvedValue(snapshot),
      downloadModel: vi.fn().mockResolvedValue(snapshot),
      cancelModelDownload: vi.fn(),
      selectModel: vi.fn(),
      removeModel: vi.fn(),
      transcribe: vi.fn(),
      cancelTranscription: vi.fn().mockResolvedValue(undefined),
      onModelDownloadProgress: () => () => undefined,
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(() => root.render(<Probe />));
  }

  it("waits for native consent before opening the recorder", async () => {
    const permission = pendingPermission();
    client.requestMicrophoneAccess = vi.fn(() => permission.promise);
    await mount();
    let activation: Promise<void>;
    await act(async () => {
      activation = controller.activate();
    });
    expect(controller.phase).toBe("requesting-permission");
    expect(recorder.start).not.toHaveBeenCalled();
    await act(async () => {
      permission.resolve("granted");
      await activation;
    });
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(controller.phase).toBe("recording");
  });

  it.each(["denied", "restricted"] as const)("does not record after %s access", async (access) => {
    client.requestMicrophoneAccess = vi.fn().mockResolvedValue(access);
    await mount();
    await act(() => controller.activate());
    expect(recorder.start).not.toHaveBeenCalled();
    expect(controller.phase).toBe("idle");
    expect(controller.microphonePermissionDenied).toBe(access === "denied");
    expect(controller.errorMessage).toContain(
      access === "denied" ? "restart Scient" : "administrator",
    );
  });

  it.each(["cancel", "unmount"] as const)(
    "does not record when consent arrives after %s",
    async (action) => {
      const permission = pendingPermission();
      client.requestMicrophoneAccess = () => permission.promise;
      await mount();
      let activation: Promise<void>;
      await act(async () => {
        activation = controller.activate();
      });
      await act(() => (action === "cancel" ? controller.cancel() : root.render(null)));
      await act(async () => {
        permission.resolve("granted");
        await activation;
      });
      expect(recorder.start).not.toHaveBeenCalled();
    },
  );

  it.each(["older-host", "unavailable", "ipc-error"] as const)(
    "preserves renderer capture for %s",
    async (mode) => {
      if (mode === "older-host") delete client.requestMicrophoneAccess;
      else
        client.requestMicrophoneAccess =
          mode === "ipc-error"
            ? vi.fn().mockRejectedValue(new Error("unavailable"))
            : vi.fn().mockResolvedValue("unavailable");
      await mount();
      await act(() => controller.activate());
      expect(recorder.start).toHaveBeenCalledOnce();
      expect(controller.phase).toBe("recording");
    },
  );
});
