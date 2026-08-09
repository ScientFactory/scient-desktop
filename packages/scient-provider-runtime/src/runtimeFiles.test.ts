// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the package's private filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Tar from "tar";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { materializeManagedRuntimeArtifact, verifySha256 } from "./runtimeFiles.ts";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-runtime-files-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("managed runtime files", () => {
  it("verifies exact SHA-256 digests", async () => {
    const root = await temporaryRoot();
    const file = NodePath.join(root, "artifact");
    const content = "reviewed artifact";
    await NodeFSP.writeFile(file, content);
    const digest = NodeCrypto.createHash("sha256").update(content).digest("hex");

    await expect(verifySha256(file, digest)).resolves.toBeUndefined();
    await expect(verifySha256(file, "0".repeat(64))).rejects.toThrow("checksum mismatch");
  });

  it("extracts a reviewed executable and makes it runnable on Unix", async () => {
    const root = await temporaryRoot();
    const source = NodePath.join(root, "source");
    const archive = NodePath.join(root, "codex.tar.gz");
    const destination = NodePath.join(root, "destination");
    await NodeFSP.mkdir(source);
    await NodeFSP.writeFile(NodePath.join(source, "codex"), "binary");
    await Tar.c({ cwd: source, file: archive, gzip: true }, ["codex"]);

    const executable = await materializeManagedRuntimeArtifact({
      archivePath: archive,
      archiveFormat: "tar.gz",
      destination,
      executablePath: "codex",
      platform: "darwin",
      signal: new AbortController().signal,
    });

    expect(await NodeFSP.readFile(executable, "utf8")).toBe("binary");
    expect((await NodeFSP.stat(executable)).mode & 0o111).not.toBe(0);
  });

  it("rejects links instead of extracting them into managed storage", async () => {
    const root = await temporaryRoot();
    const source = NodePath.join(root, "source");
    const archive = NodePath.join(root, "codex.tar.gz");
    await NodeFSP.mkdir(source);
    await NodeFSP.symlink("/tmp/not-codex", NodePath.join(source, "codex"));
    await Tar.c({ cwd: source, file: archive, gzip: true }, ["codex"]);

    await expect(
      materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: "tar.gz",
        destination: NodePath.join(root, "destination"),
        executablePath: "codex",
        platform: "darwin",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Unsupported archive entry");
  });

  it("supports the official raw-executable shape used on Windows", async () => {
    const root = await temporaryRoot();
    const archive = NodePath.join(root, "codex.exe.download");
    await NodeFSP.writeFile(archive, "windows-binary");

    const executable = await materializeManagedRuntimeArtifact({
      archivePath: archive,
      archiveFormat: "raw",
      destination: NodePath.join(root, "destination"),
      executablePath: "codex.exe",
      platform: "win32",
      signal: new AbortController().signal,
    });

    expect(NodePath.basename(executable)).toBe("codex.exe");
    expect(await NodeFSP.readFile(executable, "utf8")).toBe("windows-binary");
  });
});
