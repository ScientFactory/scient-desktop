// @effect-diagnostics nodeBuiltinImport:off - exercises real filesystem I/O.
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { VoiceModelManager } from "./modelManager.ts";
import { GGML_MAGIC_HEADER_HEX, type VoiceModelDefinition } from "./modelManifest.ts";

// A tiny stand-in model: real GGML magic header + arbitrary payload. Small
// enough to hold in memory so tests never touch the network or a real model.
const MODEL_BYTES = NodeBuffer.Buffer.concat([
  NodeBuffer.Buffer.from(GGML_MAGIC_HEADER_HEX, "hex"),
  NodeBuffer.Buffer.from("scient-voice test model payload"),
]);
const MODEL_SHA256 = NodeCrypto.createHash("sha256").update(MODEL_BYTES).digest("hex");

function manifest(overrides: Partial<VoiceModelDefinition> = {}): VoiceModelDefinition {
  return {
    id: "test-model",
    fileName: "test-model.bin",
    displayName: "Test Model",
    byteSize: MODEL_BYTES.byteLength,
    sha256: MODEL_SHA256,
    headerHex: GGML_MAGIC_HEADER_HEX,
    sourceRevision: "test-revision",
    downloadUrl: "https://example.invalid/test-model.bin",
    license: "MIT",
    ...overrides,
  };
}

/** A fetch that serves `content`, honoring a `Range: bytes=<start>-` header. */
function servingFetch(content: Buffer): typeof fetch {
  const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const range = headers.Range;
    if (range) {
      const match = /bytes=(\d+)-/u.exec(range);
      const start = match?.[1] ? Number(match[1]) : 0;
      return new Response(new Uint8Array(content.subarray(start)), { status: 206 });
    }
    return new Response(new Uint8Array(content), { status: 200 });
  };
  return impl as unknown as typeof fetch;
}

const tmpDirs: string[] = [];

async function makeModelDir(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-voice-model-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

describe("VoiceModelManager", () => {
  it("downloads, verifies, and reports a ready model with a receipt", async () => {
    const dir = await makeModelDir();
    const manager = new VoiceModelManager({
      modelsDirectory: dir,
      manifest: manifest(),
      fetchImpl: servingFetch(MODEL_BYTES),
    });

    const progress: number[] = [];
    const modelPath = await manager.ensureInstalled(new AbortController().signal, (p) => {
      progress.push(p.downloadedBytes);
      expect(p.totalBytes).toBe(MODEL_BYTES.byteLength);
    });

    expect(modelPath).toBe(manager.modelPath);
    expect(progress.at(-1)).toBe(MODEL_BYTES.byteLength);
    expect(await manager.verifyInstalledModel()).toBe(true);

    const status = await manager.getStatus();
    expect(status.state).toBe("ready");
    if (status.state === "ready") {
      expect(status.byteSize).toBe(MODEL_BYTES.byteLength);
    }

    const receipt = JSON.parse(await NodeFSP.readFile(manager.receiptPath, "utf8")) as {
      id: string;
      sha256: string;
    };
    expect(receipt.id).toBe("test-model");
    expect(receipt.sha256).toBe(MODEL_SHA256);

    // No leftover partial file after success.
    await expect(NodeFSP.stat(manager.partialPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is idempotent when the model is already installed", async () => {
    const dir = await makeModelDir();
    const first = new VoiceModelManager({
      modelsDirectory: dir,
      manifest: manifest(),
      fetchImpl: servingFetch(MODEL_BYTES),
    });
    await first.ensureInstalled(new AbortController().signal);

    let calls = 0;
    const countingFetch = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return servingFetch(MODEL_BYTES)(...args);
    }) as unknown as typeof fetch;
    const second = new VoiceModelManager({
      modelsDirectory: dir,
      manifest: manifest(),
      fetchImpl: countingFetch,
    });
    await second.ensureInstalled(new AbortController().signal);
    expect(calls).toBe(0);
  });

  it("rejects and cleans up on a checksum mismatch", async () => {
    const dir = await makeModelDir();
    const manager = new VoiceModelManager({
      modelsDirectory: dir,
      manifest: manifest({ sha256: "0".repeat(64) }),
      fetchImpl: servingFetch(MODEL_BYTES),
    });

    await expect(manager.ensureInstalled(new AbortController().signal)).rejects.toThrow(
      /checksum verification failed/u,
    );
    expect((await manager.getStatus()).state).toBe("missing");
    await expect(NodeFSP.stat(manager.partialPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects when the GGML magic header does not match", async () => {
    const dir = await makeModelDir();
    const manager = new VoiceModelManager({
      modelsDirectory: dir,
      manifest: manifest({ headerHex: "deadbeef" }),
      fetchImpl: servingFetch(MODEL_BYTES),
    });
    await expect(manager.ensureInstalled(new AbortController().signal)).rejects.toThrow(
      /header verification failed/u,
    );
  });

  it("resumes a partial download with a Range request", async () => {
    const dir = await makeModelDir();
    const manager = new VoiceModelManager({
      modelsDirectory: dir,
      manifest: manifest(),
      fetchImpl: servingFetch(MODEL_BYTES),
    });
    // Seed a partial file with the first few bytes already present.
    await NodeFSP.writeFile(manager.partialPath, MODEL_BYTES.subarray(0, 4));

    await manager.ensureInstalled(new AbortController().signal);
    expect(await manager.verifyInstalledModel()).toBe(true);
  });

  it("removes an installed model and returns to missing", async () => {
    const dir = await makeModelDir();
    const manager = new VoiceModelManager({
      modelsDirectory: dir,
      manifest: manifest(),
      fetchImpl: servingFetch(MODEL_BYTES),
    });
    await manager.ensureInstalled(new AbortController().signal);
    await manager.remove();
    expect((await manager.getStatus()).state).toBe("missing");
    await expect(NodeFSP.stat(manager.modelPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(NodeFSP.stat(manager.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
