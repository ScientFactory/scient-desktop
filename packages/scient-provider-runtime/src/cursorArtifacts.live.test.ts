// @effect-diagnostics nodeBuiltinImport:off -- Gated qualification exercises reviewed provider archives from a local audit directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { resolveReviewedCursorArtifact } from "./cursorManifest.ts";
import { ManagedCursorRuntime } from "./managedCursorRuntime.ts";
import { materializeManagedRuntimeArtifact, verifyManagedRuntimeChecksum } from "./runtimeFiles.ts";
import type { ManagedRuntimeTarget } from "./target.ts";

const artifactDirectory = process.env.SCIENT_CURSOR_ARTIFACT_DIR;
const temporaryRoots: string[] = [];

const reviewedArtifacts = [
  [{ platform: "darwin", arch: "arm64" }, "darwin-arm64.gz"],
  [{ platform: "darwin", arch: "x64" }, "darwin-x64.gz"],
  [{ platform: "linux", arch: "arm64", libc: "glibc" }, "linux-arm64.gz"],
  [{ platform: "linux", arch: "x64", libc: "glibc" }, "linux-x64.gz"],
  [{ platform: "win32", arch: "arm64" }, "win32-arm64.zip"],
  [{ platform: "win32", arch: "x64" }, "win32-x64.zip"],
] as const satisfies ReadonlyArray<readonly [ManagedRuntimeTarget, string]>;

async function temporaryRoot(): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-cursor-live-"));
  temporaryRoots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe.runIf(artifactDirectory !== undefined)("reviewed Cursor runtime artifacts", () => {
  it("verifies and safely materializes every reviewed platform package", async () => {
    for (const [target, fileName] of reviewedArtifacts) {
      const artifact = resolveReviewedCursorArtifact(target);
      expect(artifact).toBeDefined();
      const archivePath = NodePath.join(artifactDirectory!, fileName);
      expect((await NodeFSP.stat(archivePath)).size).toBe(artifact!.size);
      await verifyManagedRuntimeChecksum(archivePath, artifact!.checksum);

      const root = await temporaryRoot();
      const destination = NodePath.join(root, "payload");
      const executable = await materializeManagedRuntimeArtifact({
        archivePath,
        archiveFormat: artifact!.archiveFormat,
        destination,
        executablePath: artifact!.executablePath,
        platform: target.platform,
        extractionLimits: artifact!.extractionLimits,
        signal: new AbortController().signal,
      });
      expect((await NodeFSP.lstat(executable)).isFile()).toBe(true);
      if (target.platform !== "win32") {
        expect((await NodeFSP.stat(executable)).mode & 0o111).not.toBe(0);
      }
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("installs, smoke-tests, repairs, and removes the host Cursor runtime atomically", async () => {
    if (process.env.SCIENT_CURSOR_HOST_TARGET !== "darwin-arm64") return;
    const artifact = resolveReviewedCursorArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toBeDefined();
    const archivePath = NodePath.join(artifactDirectory!, "darwin-arm64.gz");
    const root = await temporaryRoot();
    const stages: string[] = [];
    const runtime = new ManagedCursorRuntime(root, {
      download: async ({ destination, onProgress }) => {
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.copyFile(archivePath, destination);
        onProgress?.(artifact!.size, artifact!.size);
      },
    });

    const install = () =>
      runtime.install({
        artifact: artifact!,
        signal: new AbortController().signal,
        onProgress: (progress) => stages.push(progress.stage),
      });

    const installed = await install();
    expect(installed).toMatchObject({ installed: true, activeVersion: artifact!.version });
    expect((await NodeFSP.stat(installed.launchPath)).isFile()).toBe(true);

    const repaired = await install();
    expect(repaired).toMatchObject({ installed: true, activeVersion: artifact!.version });
    expect(stages.filter((stage) => stage === "activating")).toHaveLength(2);

    await runtime.remove();
    expect(await runtime.status(artifact!)).toMatchObject({ installed: false });
  }, 180_000);
});
