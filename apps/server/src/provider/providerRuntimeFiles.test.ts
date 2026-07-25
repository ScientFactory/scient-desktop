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

// Builds a minimal STORE-method (uncompressed) zip so tests can exercise the
// zip extraction path without a zip-creation dependency. Mirrors the real
// Codex artifact by supporting multiple entries.
function createStoreZip(entries: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = Zlib.crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    parts.push(local, entry.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // store
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + entry.data.length;
  }
  const localData = Buffer.concat(parts);
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralDir, eocd]);
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

  it("extracts the target executable from a multi-entry zip archive", async () => {
    // Regression: the Codex Windows zip has several entries and streaming with
    // unzipper's entry.stream() deadlocked, hanging installs on "Installing…".
    const root = await temporaryRoot();
    const archivePath = Path.join(root, "runtime.zip");
    const destination = Path.join(root, "release");
    await FS.writeFile(
      archivePath,
      createStoreZip([
        { name: "helper.exe", data: Buffer.from("helper-tool") },
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
    expect(await FS.readFile(Path.join(destination, "helper.exe"), "utf8")).toBe("helper-tool");
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
