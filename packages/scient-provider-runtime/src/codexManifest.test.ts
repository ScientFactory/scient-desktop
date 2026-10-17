import { describe, expect, it } from "vite-plus/test";

import { resolveReviewedCodexArtifact } from "./codexManifest.ts";
import {
  hydrateManagedRuntimeArtifact,
  managedRuntimeArtifactReceipt,
} from "./managedRuntimeArtifact.ts";

const DARWIN_COMPANIONS = [
  "bin/codex-code-mode-host",
  "codex-path/rg",
  "codex-resources/zsh/bin/zsh",
] as const;
const LINUX_COMPANIONS = [
  "bin/codex-code-mode-host",
  "codex-path/rg",
  "codex-resources/bwrap",
  "codex-resources/zsh/bin/zsh",
] as const;
const WINDOWS_COMPANIONS = [
  "bin/codex-code-mode-host.exe",
  "codex-path/rg.exe",
  "codex-resources/codex-command-runner.exe",
  "codex-resources/codex-windows-sandbox-setup.exe",
] as const;

const reviewedPackages = [
  {
    target: { platform: "darwin", arch: "arm64" },
    artifactName: "codex-package-aarch64-apple-darwin.tar.gz",
    executablePath: "bin/codex",
    auxiliaryExecutablePaths: DARWIN_COMPANIONS,
  },
  {
    target: { platform: "darwin", arch: "x64" },
    artifactName: "codex-package-x86_64-apple-darwin.tar.gz",
    executablePath: "bin/codex",
    auxiliaryExecutablePaths: DARWIN_COMPANIONS,
  },
  {
    target: { platform: "win32", arch: "arm64" },
    artifactName: "codex-package-aarch64-pc-windows-msvc.tar.gz",
    executablePath: "bin/codex.exe",
    auxiliaryExecutablePaths: WINDOWS_COMPANIONS,
  },
  {
    target: { platform: "win32", arch: "x64" },
    artifactName: "codex-package-x86_64-pc-windows-msvc.tar.gz",
    executablePath: "bin/codex.exe",
    auxiliaryExecutablePaths: WINDOWS_COMPANIONS,
  },
  {
    target: { platform: "linux", arch: "arm64", libc: "glibc" },
    artifactName: "codex-package-aarch64-unknown-linux-musl.tar.gz",
    executablePath: "bin/codex",
    auxiliaryExecutablePaths: LINUX_COMPANIONS,
  },
  {
    target: { platform: "linux", arch: "arm64", libc: "musl" },
    artifactName: "codex-package-aarch64-unknown-linux-musl.tar.gz",
    executablePath: "bin/codex",
    auxiliaryExecutablePaths: LINUX_COMPANIONS,
  },
  {
    target: { platform: "linux", arch: "x64", libc: "glibc" },
    artifactName: "codex-package-x86_64-unknown-linux-musl.tar.gz",
    executablePath: "bin/codex",
    auxiliaryExecutablePaths: LINUX_COMPANIONS,
  },
  {
    target: { platform: "linux", arch: "x64", libc: "musl" },
    artifactName: "codex-package-x86_64-unknown-linux-musl.tar.gz",
    executablePath: "bin/codex",
    auxiliaryExecutablePaths: LINUX_COMPANIONS,
  },
] as const;

describe("reviewed Codex runtime manifest", () => {
  it.each(reviewedPackages)(
    "resolves both layouts for $target.platform-$target.arch-$target.libc",
    ({ target, auxiliaryExecutablePaths }) => {
      const policy = resolveReviewedCodexArtifact(target)!;
      for (const version of ["0.149.1", "0.162.1", "0.163.0", "0.164.0"]) {
        const receipt = {
          ...managedRuntimeArtifactReceipt(policy),
          version,
          url: policy.url.replace("rust-v0.149.1/", `rust-v${version}/`),
        };
        const current = hydrateManagedRuntimeArtifact(policy, receipt)!;
        expect(current.auxiliaryExecutablePaths).toEqual(
          version === "0.163.0" || version === "0.164.0"
            ? auxiliaryExecutablePaths.filter((path) => path !== "codex-resources/zsh/bin/zsh")
            : auxiliaryExecutablePaths,
        );
        expect(current.extractionLimits).toEqual(policy.extractionLimits);
        expect(
          hydrateManagedRuntimeArtifact(current, managedRuntimeArtifactReceipt(policy))
            ?.auxiliaryExecutablePaths,
        ).toEqual(auxiliaryExecutablePaths);
      }
    },
  );

  it("keeps every reviewed Codex target within the same bounded extraction budget", () => {
    for (const { target } of reviewedPackages) {
      expect(resolveReviewedCodexArtifact(target)?.extractionLimits).toEqual({
        maxEntries: 128,
        maxExpandedBytes: 512 * 1024 * 1024,
      });
    }
  });

  it("offers assisted installation on every reviewed desktop target", () => {
    for (const { target } of reviewedPackages) {
      expect(resolveReviewedCodexArtifact(target)?.supportTier).toBe("fully_assisted");
    }
  });

  it("uses the complete official Codex package on every target", () => {
    for (const {
      target,
      artifactName,
      executablePath,
      auxiliaryExecutablePaths,
    } of reviewedPackages) {
      const artifact = resolveReviewedCodexArtifact(target);

      expect(artifact?.version).toBe("0.149.1");
      expect(artifact?.archiveFormat).toBe("tar.gz");
      expect(artifact?.artifactName).toBe(artifactName);
      expect(artifact?.executablePath).toBe(executablePath);
      expect(artifact?.auxiliaryExecutablePaths).toEqual(auxiliaryExecutablePaths);
      expect(artifact?.checksum).toEqual({
        algorithm: "sha256",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    }
  });
});
