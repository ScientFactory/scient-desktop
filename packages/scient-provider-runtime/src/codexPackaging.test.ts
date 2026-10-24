// @effect-diagnostics nodeBuiltinImport:off -- Synthetic packages exercise private extraction without provider state.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Tar from "tar";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveReviewedCodexArtifact } from "./codexManifest.ts";
import {
  hydrateManagedRuntimeArtifact,
  managedRuntimeArtifactReceipt,
} from "./managedRuntimeArtifact.ts";
import { materializeManagedRuntimeArtifact } from "./runtimeFiles.ts";

// regression: aa7e503582 fix(provider-runtime): qualify Codex packages without patched zsh
// One row per path: the reviewed file list varies only by platform (arch and libc
// pick the same list), the patched zsh is required only below 0.163.0, and the main
// and companion executables go through one completeness check.
function packageFiles(platform: "darwin" | "linux" | "win32", version: string) {
  const windows = platform === "win32";
  const suffix = windows ? ".exe" : "";
  return [
    `bin/codex${suffix}`,
    `bin/codex-code-mode-host${suffix}`,
    `codex-path/rg${suffix}`,
    ...(platform === "linux" ? ["codex-resources/bwrap"] : []),
    ...(windows
      ? [
          "codex-resources/codex-command-runner.exe",
          "codex-resources/codex-windows-sandbox-setup.exe",
        ]
      : version === "0.162.1"
        ? ["codex-resources/zsh/bin/zsh"]
        : []),
  ];
}

const darwin = { platform: "darwin", arch: "arm64" } as const;
const linux = { platform: "linux", arch: "x64", libc: "glibc" } as const;
const windows = { platform: "win32", arch: "x64" } as const;
const cases = [
  { target: darwin, version: "0.162.1", missing: undefined },
  { target: darwin, version: "0.162.1", missing: "codex-resources/zsh/bin/zsh" },
  { target: darwin, version: "0.163.0", missing: undefined },
  { target: linux, version: "0.163.0", missing: undefined },
  { target: linux, version: "0.163.0", missing: "codex-resources/bwrap" },
  { target: windows, version: "0.163.0", missing: undefined },
  { target: windows, version: "0.163.0", missing: "bin/codex.exe" },
].map((row) => ({ ...row, files: packageFiles(row.target.platform, row.version) }));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("Codex package completeness", () => {
  it.each(cases)(
    "$version $target.platform-$target.arch-$target.libc missing=$missing",
    async ({ target, version, files, missing }) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-codex-package-"));
      roots.push(root);
      const source = NodePath.join(root, "source");
      const archive = NodePath.join(root, "package.tar.gz");
      const members = files.filter((file) => file !== missing);
      await Promise.all(
        members.map(async (file) => {
          const path = NodePath.join(source, file);
          await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
          await NodeFSP.writeFile(path, "synthetic executable");
        }),
      );
      await Tar.c({ cwd: source, file: archive, gzip: true }, members);

      const policy = resolveReviewedCodexArtifact(target)!;
      const artifact = hydrateManagedRuntimeArtifact(policy, {
        ...managedRuntimeArtifactReceipt(policy),
        version,
        url: policy.url.replace("rust-v0.149.1/", `rust-v${version}/`),
      })!;
      const destination = NodePath.join(root, "installed");
      const materialized = materializeManagedRuntimeArtifact({
        archivePath: archive,
        archiveFormat: artifact.archiveFormat,
        destination,
        executablePath: artifact.executablePath,
        auxiliaryExecutablePaths: artifact.auxiliaryExecutablePaths,
        extractionLimits: artifact.extractionLimits,
        platform: target.platform,
        signal: new AbortController().signal,
      });
      if (missing) {
        await expect(materialized).rejects.toThrow(`reviewed executable: ${missing}`);
      } else {
        await expect(materialized).resolves.toBe(
          NodePath.join(destination, artifact.executablePath),
        );
        for (const path of files) {
          const installed = await NodeFSP.stat(NodePath.join(destination, path));
          expect(installed.isFile()).toBe(true);
          if (target.platform !== "win32") expect(installed.mode & 0o111).not.toBe(0);
        }
      }
    },
  );
});
