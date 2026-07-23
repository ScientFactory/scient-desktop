// FILE: localVoiceModelManager.test.ts
// Purpose: Verifies resumable, checksum-pinned offline voice model lifecycle behavior.
// Layer: Desktop voice runtime tests

import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalVoiceModelManager } from "./localVoiceModelManager";
import type { LocalVoiceModelManifest } from "./localVoiceModelManifest";

const temporaryDirectories: string[] = [];

async function makeFixture(
  bytes = new Uint8Array([0x6c, 0x6d, 0x67, 0x67, ...new TextEncoder().encode(" model")]),
) {
  const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "scient-voice-model-test-"));
  temporaryDirectories.push(directory);
  const manifest: LocalVoiceModelManifest = {
    id: "test-small-q5",
    fileName: "model.bin",
    displayName: "Test model",
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    headerHex: "6c6d6767",
    sourceRevision: "test-revision",
    downloadUrl: "https://models.invalid/model.bin",
    license: "MIT",
  };
  return { bytes, directory, manifest };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => FS.rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalVoiceModelManager", () => {
  it("downloads, verifies, receipts, and reuses a pinned model", async () => {
    const fixture = await makeFixture();
    const fetchImpl = vi.fn(async () => new Response(fixture.bytes, { status: 200 }));
    const manager = new LocalVoiceModelManager({
      modelsDirectory: fixture.directory,
      manifest: fixture.manifest,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const progress = vi.fn();

    await expect(manager.getStatus()).resolves.toEqual({ state: "missing" });
    await expect(manager.ensureInstalled(new AbortController().signal, progress)).resolves.toBe(
      manager.modelPath,
    );
    await expect(manager.verifyInstalledModel()).resolves.toBe(true);
    await expect(manager.getStatus()).resolves.toEqual({
      state: "ready",
      modelPath: manager.modelPath,
      byteSize: fixture.bytes.byteLength,
    });
    await manager.ensureInstalled(new AbortController().signal);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith({
      downloadedBytes: fixture.bytes.byteLength,
      totalBytes: fixture.bytes.byteLength,
    });
  });

  it("resumes an interrupted partial download with an HTTP range", async () => {
    const fixture = await makeFixture(
      new Uint8Array([0x6c, 0x6d, 0x67, 0x67, ...new TextEncoder().encode("456789abcdef")]),
    );
    const manager = new LocalVoiceModelManager({
      modelsDirectory: fixture.directory,
      manifest: fixture.manifest,
      fetchImpl: (async (_url, init) => {
        expect(new Headers(init?.headers).get("Range")).toBe("bytes=5-");
        return new Response(fixture.bytes.slice(5), { status: 206 });
      }) as typeof fetch,
    });
    await FS.writeFile(manager.partialPath, fixture.bytes.slice(0, 5));

    await manager.ensureInstalled(new AbortController().signal);

    await expect(manager.verifyInstalledModel()).resolves.toBe(true);
  });

  it("rejects checksum-mismatched content without installing it", async () => {
    const fixture = await makeFixture();
    const corrupted = new TextEncoder().encode("corrupted whisper bytes");
    const manager = new LocalVoiceModelManager({
      modelsDirectory: fixture.directory,
      manifest: { ...fixture.manifest, byteSize: corrupted.byteLength },
      fetchImpl: (async () => new Response(corrupted, { status: 200 })) as typeof fetch,
    });

    await expect(manager.ensureInstalled(new AbortController().signal)).rejects.toThrow(
      /checksum verification failed/i,
    );
    await expect(FS.stat(manager.modelPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(FS.stat(manager.partialPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a checksum-valid file with an invalid GGML header", async () => {
    const invalidHeader = new TextEncoder().encode("notg-model");
    const fixture = await makeFixture(invalidHeader);
    const manager = new LocalVoiceModelManager({
      modelsDirectory: fixture.directory,
      manifest: fixture.manifest,
      fetchImpl: (async () => new Response(invalidHeader, { status: 200 })) as typeof fetch,
    });

    await expect(manager.ensureInstalled(new AbortController().signal)).rejects.toThrow(
      /header verification failed/i,
    );
    await expect(FS.stat(manager.modelPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the installed model and receipt", async () => {
    const fixture = await makeFixture();
    const manager = new LocalVoiceModelManager({
      modelsDirectory: fixture.directory,
      manifest: fixture.manifest,
      fetchImpl: (async () => new Response(fixture.bytes, { status: 200 })) as typeof fetch,
    });
    await manager.ensureInstalled(new AbortController().signal);

    await manager.remove();

    await expect(manager.getStatus()).resolves.toEqual({ state: "missing" });
  });

  it("repairs through a separate verified file and preserves the installed model on failure", async () => {
    const fixture = await makeFixture();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(fixture.bytes, { status: 200 }))
      .mockRejectedValueOnce(new Error("offline"));
    const manager = new LocalVoiceModelManager({
      modelsDirectory: fixture.directory,
      manifest: fixture.manifest,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await manager.ensureInstalled(new AbortController().signal);
    const before = await FS.readFile(manager.modelPath);

    await expect(manager.repair(new AbortController().signal)).rejects.toThrow("offline");
    await expect(FS.readFile(manager.modelPath)).resolves.toEqual(before);
    await expect(manager.verifyInstalledModel()).resolves.toBe(true);
    await expect(FS.stat(manager.repairPartialPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-downloads and atomically replaces a valid installed model during repair", async () => {
    const fixture = await makeFixture();
    const fetchImpl = vi.fn(async () => new Response(fixture.bytes, { status: 200 }));
    const manager = new LocalVoiceModelManager({
      modelsDirectory: fixture.directory,
      manifest: fixture.manifest,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await manager.ensureInstalled(new AbortController().signal);
    await manager.repair(new AbortController().signal);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(manager.verifyInstalledModel()).resolves.toBe(true);
  });
});
