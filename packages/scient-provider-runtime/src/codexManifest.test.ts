import { describe, expect, it } from "vite-plus/test";

import { resolveReviewedCodexArtifact } from "./codexManifest.ts";

describe("reviewed Codex runtime manifest", () => {
  it("offers assisted installation on every reviewed desktop target", () => {
    const targets = [
      { platform: "darwin", arch: "arm64" },
      { platform: "darwin", arch: "x64" },
      { platform: "win32", arch: "arm64" },
      { platform: "win32", arch: "x64" },
      { platform: "linux", arch: "arm64", libc: "glibc" },
      { platform: "linux", arch: "arm64", libc: "musl" },
      { platform: "linux", arch: "x64", libc: "glibc" },
      { platform: "linux", arch: "x64", libc: "musl" },
    ] as const;

    for (const target of targets) {
      expect(resolveReviewedCodexArtifact(target)?.supportTier).toBe("fully_assisted");
    }
  });

  it("uses the complete official Codex package on every target", () => {
    const windows = resolveReviewedCodexArtifact({ platform: "win32", arch: "arm64" });
    const mac = resolveReviewedCodexArtifact({ platform: "darwin", arch: "arm64" });

    expect(windows?.archiveFormat).toBe("tar.gz");
    expect(windows?.artifactName).toBe("codex-package-aarch64-pc-windows-msvc.tar.gz");
    expect(windows?.executablePath).toBe("bin/codex.exe");
    expect(windows?.auxiliaryExecutablePaths).toContain("bin/codex-code-mode-host.exe");
    expect(mac?.version).toBe("0.149.1");
    expect(mac?.artifactName).toBe("codex-package-aarch64-apple-darwin.tar.gz");
    expect(mac?.executablePath).toBe("bin/codex");
    expect(mac?.auxiliaryExecutablePaths).toEqual([
      "bin/codex-code-mode-host",
      "codex-path/rg",
      "codex-resources/zsh/bin/zsh",
    ]);
    expect(mac?.archiveFormat).toBe("tar.gz");
    expect(mac?.checksum).toEqual({
      algorithm: "sha256",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });
});
