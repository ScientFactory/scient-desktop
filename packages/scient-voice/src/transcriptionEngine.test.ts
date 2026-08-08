// @effect-diagnostics nodeBuiltinImport:off globalDate:off - exercises real filesystem I/O.
import * as NodeBuffer from "node:buffer";
import type * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { isVoiceTranscriptionError, type NormalizedVoiceClip } from "./errors.ts";
import { GGML_MAGIC_HEADER_HEX, type VoiceModelDefinition } from "./modelManifest.ts";
import { createLocalWhisperEngine } from "./transcriptionEngine.ts";
import type { WhisperSpawn } from "./whisperRuntime.ts";

const MODEL_BYTES = NodeBuffer.Buffer.concat([
  NodeBuffer.Buffer.from(GGML_MAGIC_HEADER_HEX, "hex"),
  NodeBuffer.Buffer.from("engine test model"),
]);
const MODEL_SHA256 = NodeCrypto.createHash("sha256").update(MODEL_BYTES).digest("hex");

function manifest(): VoiceModelDefinition {
  return {
    id: "engine-model",
    fileName: "engine-model.bin",
    displayName: "Engine Model",
    byteSize: MODEL_BYTES.byteLength,
    sha256: MODEL_SHA256,
    headerHex: GGML_MAGIC_HEADER_HEX,
    sourceRevision: "rev-1",
    downloadUrl: "https://example.invalid/engine-model.bin",
    license: "MIT",
  };
}

const CLIP: NormalizedVoiceClip = {
  audioBytes: new Uint8Array([1, 2, 3, 4]),
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 500,
};

class FakeChild extends NodeEvents.EventEmitter {
  pid = 999_999;
  exitCode: number | null = null;
  killed = false;
  readonly stdout = { on: (): undefined => undefined };
  readonly stderr = { on: (): undefined => undefined };
  kill(): boolean {
    if (this.exitCode === null) {
      this.killed = true;
      this.exitCode = 0;
      this.emit("exit", 0, null);
    }
    return true;
  }
}

function fakeSpawn(): WhisperSpawn {
  const child = new FakeChild();
  return (() =>
    child as unknown as NodeChildProcess.ChildProcessWithoutNullStreams) as WhisperSpawn;
}

/** A fetch whose POST /inference response is configurable; OPTIONS is always OK. */
function inferenceFetch(post: () => Response): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if ((init?.method ?? "GET") === "OPTIONS") return new Response(null, { status: 200 });
    return post();
  }) as unknown as typeof fetch;
}

const tmpDirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function makeRuntimeDir(): Promise<string> {
  const dir = await tmp("scient-voice-eng-rt-");
  await NodeFSP.writeFile(NodePath.join(dir, "whisper-server"), "#!/bin/sh\n");
  return dir;
}

async function installReadyModel(
  modelDir: string,
  definition: VoiceModelDefinition,
): Promise<void> {
  await NodeFSP.writeFile(NodePath.join(modelDir, definition.fileName), MODEL_BYTES);
  const receipt = {
    id: definition.id,
    fileName: definition.fileName,
    byteSize: definition.byteSize,
    sha256: definition.sha256,
    sourceRevision: definition.sourceRevision,
    verifiedAt: new Date().toISOString(),
  };
  await NodeFSP.writeFile(
    NodePath.join(modelDir, `${definition.fileName}.json`),
    JSON.stringify(receipt, null, 2),
  );
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

describe("createLocalWhisperEngine", () => {
  it("reports the engine id and model state", async () => {
    const modelDir = await tmp("scient-voice-eng-model-");
    const runtimeDir = await makeRuntimeDir();
    const engine = createLocalWhisperEngine({ runtimeDir, modelDir, manifest: manifest() });
    expect(engine.engine).toBe("local");
    expect((await engine.getModelState()).state).toBe("missing");
    await engine.dispose();
  });

  it("rejects transcription with model-missing when no model is installed", async () => {
    const modelDir = await tmp("scient-voice-eng-model-");
    const runtimeDir = await makeRuntimeDir();
    const engine = createLocalWhisperEngine({ runtimeDir, modelDir, manifest: manifest() });
    try {
      await engine.transcribe(CLIP, { signal: new AbortController().signal });
      throw new Error("expected rejection");
    } catch (error) {
      expect(isVoiceTranscriptionError(error)).toBe(true);
      if (isVoiceTranscriptionError(error)) expect(error.kind).toBe("model-missing");
    }
    await engine.dispose();
  });

  it("refuses to transcribe while maintenance is active", async () => {
    const modelDir = await tmp("scient-voice-eng-model-");
    const runtimeDir = await makeRuntimeDir();
    const definition = manifest();
    await installReadyModel(modelDir, definition);
    const engine = createLocalWhisperEngine({
      runtimeDir,
      modelDir,
      manifest: definition,
      isMaintenanceActive: () => true,
    });
    await expect(
      engine.transcribe(CLIP, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      kind: "backend-unavailable",
    });
    await engine.dispose();
  });

  it("transcribes a ready model and tags the result with engine and language", async () => {
    const modelDir = await tmp("scient-voice-eng-model-");
    const runtimeDir = await makeRuntimeDir();
    const definition = manifest();
    await installReadyModel(modelDir, definition);

    const engine = createLocalWhisperEngine({
      runtimeDir,
      modelDir,
      manifest: definition,
      platform: "linux",
      spawnImpl: fakeSpawn(),
      fetchImpl: inferenceFetch(
        () => new Response(JSON.stringify({ text: "bonjour" }), { status: 200 }),
      ),
    });

    const result = await engine.transcribe(CLIP, {
      signal: new AbortController().signal,
      language: "fr",
    });
    expect(result).toStrictEqual({ text: "bonjour", engine: "local", language: "fr" });
    await engine.dispose();
  });

  it("maps a runtime failure to a provider-error", async () => {
    const modelDir = await tmp("scient-voice-eng-model-");
    const runtimeDir = await makeRuntimeDir();
    const definition = manifest();
    await installReadyModel(modelDir, definition);

    const engine = createLocalWhisperEngine({
      runtimeDir,
      modelDir,
      manifest: definition,
      platform: "linux",
      spawnImpl: fakeSpawn(),
      fetchImpl: inferenceFetch(() => new Response("boom", { status: 500 })),
    });

    await expect(
      engine.transcribe(CLIP, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      kind: "provider-error",
    });
    await engine.dispose();
  });

  it("downloads a model via ensureModel and then reports ready", async () => {
    const modelDir = await tmp("scient-voice-eng-model-");
    const runtimeDir = await makeRuntimeDir();
    const definition = manifest();
    const engine = createLocalWhisperEngine({
      runtimeDir,
      modelDir,
      manifest: definition,
      fetchImpl: (async () =>
        new Response(new Uint8Array(MODEL_BYTES), { status: 200 })) as unknown as typeof fetch,
    });

    const path = await engine.ensureModel();
    expect(path).toBe(NodePath.join(modelDir, definition.fileName));
    expect((await engine.getModelState()).state).toBe("ready");
    await engine.dispose();
  });
});
