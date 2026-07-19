import { createHash } from "node:crypto";
import FS from "node:fs/promises";
import OS from "node:os";
import Path from "node:path";

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
