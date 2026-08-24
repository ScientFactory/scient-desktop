import { describe, expect, it } from "vite-plus/test";

import { resolveReviewedCodexArtifact } from "./codexManifest.ts";

const reviewedTargets = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "win32", arch: "arm64" },
  { platform: "win32", arch: "x64" },
  { platform: "linux", arch: "arm64", libc: "glibc" },
  { platform: "linux", arch: "arm64", libc: "musl" },
  { platform: "linux", arch: "x64", libc: "glibc" },
  { platform: "linux", arch: "x64", libc: "musl" },
] as const;

describe("reviewed Codex runtime manifest", () => {
  it("offers assisted installation on every reviewed desktop target", () => {
    for (const target of reviewedTargets) {
      expect(resolveReviewedCodexArtifact(target)?.supportTier).toBe("fully_assisted");
    }
  });

  it("uses the complete official Codex package on every target", () => {
    for (const target of reviewedTargets) {
      const artifact = resolveReviewedCodexArtifact(target);
      const windows = target.platform === "win32";

      expect(artifact?.version).toBe("0.149.1");
      expect(artifact?.archiveFormat).toBe("tar.gz");
      expect(artifact?.artifactName).toMatch(/^codex-package-.+\.tar\.gz$/u);
      expect(artifact?.executablePath).toBe(windows ? "bin/codex.exe" : "bin/codex");
      expect(artifact?.auxiliaryExecutablePaths).toContain(
        windows ? "bin/codex-code-mode-host.exe" : "bin/codex-code-mode-host",
      );
      expect(artifact?.auxiliaryExecutablePaths).toContain(
        windows ? "codex-path/rg.exe" : "codex-path/rg",
      );
      expect(artifact?.checksum).toEqual({
        algorithm: "sha256",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    }
  });
});
