import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import type {
  DesktopVoiceBridge,
  VoiceMicrophoneAccessStatus,
  VoiceModelsSnapshot,
} from "@t3tools/contracts";
import { useLayoutEffect } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

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
  let client: DesktopVoiceBridge;

  function Probe({ _fixture }: { _fixture: _Fixture }) {
    const value = useScientVoiceController({ client, onTranscript: () => undefined });
    useLayoutEffect(() => {
      _fixture.publishController(value);
    });
    return null;
  }

  async function _setupFixture0(_fixture: _Fixture) {
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

  async function mount(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.rerender(<Probe _fixture={_fixture} />));
  }

  it("waits for native consent before opening the recorder", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const permission = pendingPermission();
    client.requestMicrophoneAccess = vi.fn(() => permission.promise);
    await mount(_fixture);
    let activation: Promise<void>;
    await act(async () => {
      activation = _fixture.controller.activate();
    });
    expect(_fixture.controller.phase).toBe("requesting-permission");
    expect(recorder.start).not.toHaveBeenCalled();
    await act(async () => {
      permission.resolve("granted");
      await activation;
    });
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(_fixture.controller.phase).toBe("recording");
  });

  it.each(["denied", "restricted"] as const)("does not record after %s access", async (access) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    client.requestMicrophoneAccess = vi.fn().mockResolvedValue(access);
    await mount(_fixture);
    await act(() => _fixture.controller.activate());
    expect(recorder.start).not.toHaveBeenCalled();
    expect(_fixture.controller.phase).toBe("idle");
    expect(_fixture.controller.microphonePermissionDenied).toBe(access === "denied");
    expect(_fixture.controller.errorMessage).toContain(
      access === "denied" ? "restart Scient" : "administrator",
    );
  });

  it.each(["cancel", "unmount"] as const)(
    "does not record when consent arrives after %s",
    async (action) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const permission = pendingPermission();
      client.requestMicrophoneAccess = () => permission.promise;
      await mount(_fixture);
      let activation: Promise<void>;
      await act(async () => {
        activation = _fixture.controller.activate();
      });
      await act(async () =>
        action === "cancel" ? _fixture.controller.cancel() : await _fixture.root0.rerender(null),
      );
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
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      if (mode === "older-host") delete client.requestMicrophoneAccess;
      else
        client.requestMicrophoneAccess =
          mode === "ipc-error"
            ? vi.fn().mockRejectedValue(new Error("unavailable"))
            : vi.fn().mockResolvedValue("unavailable");
      await mount(_fixture);
      await act(() => _fixture.controller.activate());
      expect(recorder.start).toHaveBeenCalledOnce();
      expect(_fixture.controller.phase).toBe("recording");
    },
  );
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  let controller: ScientVoiceController;
  return {
    get controller() {
      return controller;
    },
    publishController(value: ScientVoiceController) {
      controller = value;
    },

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
