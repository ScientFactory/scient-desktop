import { createHash } from "node:crypto";
import FS from "node:fs/promises";
import OS from "node:os";
import Path from "node:path";
import Zlib from "node:zlib";

import * as Tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadProviderRuntime,
  extractProviderRuntime,
  hashFile,
  ProviderRuntimeFileError,
  verifyProviderRuntimeDigest,
} from "./providerRuntimeFiles";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "scient-provider-runtime-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => FS.rm(root, { recursive: true, force: true })),
  );
});

function createDeflateZip(entries: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = Zlib.deflateRawSync(entry.data);
    const crc = Zlib.crc32(entry.data) >>> 0;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + compressed.length;
  }

  const localData = Buffer.concat(localParts);
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralDirectory, end]);
}

describe("provider runtime files", () => {
  it("streams an allowlisted HTTPS download to an exclusive private file", async () => {
    const root = await temporaryRoot();
    const payload = "provider runtime payload";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(payload, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(payload)) },
      }),
    );

    const destination = Path.join(root, "download");
    await expect(
      downloadProviderRuntime({
        url: "https://releases.example.test/provider",
        destination,
        allowedHosts: ["releases.example.test"],
        signal: new AbortController().signal,
        expectedSize: Buffer.byteLength(payload),
      }),
    ).resolves.toEqual({ bytes: Buffer.byteLength(payload) });
    expect(await FS.readFile(destination, "utf8")).toBe(payload);
    if (process.platform !== "win32") {
      expect((await FS.stat(destination)).mode & 0o777).toBe(0o600);
    }
  });

  it("coalesces bursty download progress and preserves the catalog total", async () => {
    const root = await temporaryRoot();
    const chunk = new Uint8Array(8 * 1024).fill(7);
    const chunkCount = 320;
    const expectedSize = chunk.byteLength * chunkCount;
    const onProgress = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < chunkCount; index += 1) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      downloadProviderRuntime({
        url: "https://releases.example.test/provider",
        destination: Path.join(root, "download"),
        allowedHosts: ["releases.example.test"],
        signal: new AbortController().signal,
        expectedSize,
        onProgress,
      }),
    ).resolves.toEqual({ bytes: expectedSize });

    expect(onProgress.mock.calls.length).toBeGreaterThan(0);
    expect(onProgress.mock.calls.length).toBeLessThanOrEqual(4);
    expect(onProgress).toHaveBeenLastCalledWith(expectedSize, expectedSize);
  });

  it("verifies a reviewed digest and rejects a mismatch", async () => {
    const root = await temporaryRoot();
    const filePath = Path.join(root, "runtime");
    await FS.writeFile(filePath, "verified provider runtime");
    const digest = createHash("sha256").update("verified provider runtime").digest("hex");

    expect(await hashFile(filePath, "sha256")).toBe(digest);
    await expect(
      verifyProviderRuntimeDigest({ filePath, algorithm: "sha256", expectedDigest: digest }),
    ).resolves.toBeUndefined();
    await expect(
      verifyProviderRuntimeDigest({
        filePath,
        algorithm: "sha256",
        expectedDigest: "0".repeat(64),
      }),
    ).rejects.toThrow("checksum mismatch");
  });

  it("streams every entry from a compressed multi-entry zip", async () => {
    const root = await temporaryRoot();
    const archivePath = Path.join(root, "runtime.zip");
    const destination = Path.join(root, "release");
    await FS.writeFile(
      archivePath,
      createDeflateZip([
        { name: "tools/helper.exe", data: Buffer.from("helper-tool") },
        { name: "codex.exe", data: Buffer.from("codex-binary") },
      ]),
    );

    const executable = await extractProviderRuntime({
      archivePath,
      destination,
      format: "zip",
      executablePath: "codex.exe",
      signal: new AbortController().signal,
    });

    expect(await FS.readFile(executable, "utf8")).toBe("codex-binary");
    expect(await FS.readFile(Path.join(destination, "tools", "helper.exe"), "utf8")).toBe(
      "helper-tool",
    );
  });

  it("does not begin zip extraction when cancellation is already requested", async () => {
    const root = await temporaryRoot();
    const archivePath = Path.join(root, "runtime.zip");
    const destination = Path.join(root, "release");
    await FS.writeFile(
      archivePath,
      createDeflateZip([{ name: "codex.exe", data: Buffer.from("codex-binary") }]),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      extractProviderRuntime({
        archivePath,
        destination,
        format: "zip",
        executablePath: "codex.exe",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(FS.stat(Path.join(destination, "codex.exe"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("extracts a regular tar entry and marks the expected executable private", async () => {
    const root = await temporaryRoot();
    const source = Path.join(root, "source");
    const archivePath = Path.join(root, "runtime.tar.gz");
    const destination = Path.join(root, "release");
    await FS.mkdir(source);
    await FS.writeFile(Path.join(source, "provider"), "binary");
    await Tar.c({ cwd: source, file: archivePath, gzip: true }, ["provider"]);

    const executable = await extractProviderRuntime({
      archivePath,
      destination,
      format: "tar.gz",
      executablePath: "provider",
      signal: new AbortController().signal,
    });

    expect(await FS.readFile(executable, "utf8")).toBe("binary");
    if (process.platform !== "win32") {
      expect((await FS.stat(executable)).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects links during tar extraction", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const source = Path.join(root, "source");
    const archivePath = Path.join(root, "runtime.tar.gz");
    await FS.mkdir(source);
    await FS.writeFile(Path.join(source, "target"), "binary");
    await FS.symlink("target", Path.join(source, "provider"));
    await Tar.c({ cwd: source, file: archivePath, gzip: true }, ["provider"]);

    await expect(
      extractProviderRuntime({
        archivePath,
        destination: Path.join(root, "release"),
        format: "tar.gz",
        executablePath: "provider",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(ProviderRuntimeFileError);
  });

  it("honors cancellation before raw extraction", async () => {
    const root = await temporaryRoot();
    const archivePath = Path.join(root, "runtime");
    await FS.writeFile(archivePath, "binary");
    const controller = new AbortController();
    controller.abort();

    await expect(
      extractProviderRuntime({
        archivePath,
        destination: Path.join(root, "release"),
        format: "raw",
        executablePath: "provider",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
