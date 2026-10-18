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

const targets = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "arm64", libc: "glibc" },
  { platform: "linux", arch: "arm64", libc: "musl" },
  { platform: "linux", arch: "x64", libc: "glibc" },
  { platform: "linux", arch: "x64", libc: "musl" },
  { platform: "win32", arch: "arm64" },
  { platform: "win32", arch: "x64" },
] as const;

const cases = targets.flatMap((target) =>
  ["0.162.1", "0.163.0"].flatMap((version) => {
    const windows = target.platform === "win32";
    const suffix = windows ? ".exe" : "";
    const files = [
      `bin/codex${suffix}`,
      `bin/codex-code-mode-host${suffix}`,
      `codex-path/rg${suffix}`,
      ...(target.platform === "linux" ? ["codex-resources/bwrap"] : []),
      ...(windows
        ? [
            "codex-resources/codex-command-runner.exe",
            "codex-resources/codex-windows-sandbox-setup.exe",
          ]
        : version === "0.162.1"
          ? ["codex-resources/zsh/bin/zsh"]
          : []),
    ];
    return [
      { target, version, files, missing: undefined },
      ...files.map((missing) => ({ target, version, files, missing })),
    ];
  }),
);

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
