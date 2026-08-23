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

  it("uses raw official executables on Windows and reviewed archives elsewhere", () => {
    const windows = resolveReviewedCodexArtifact({ platform: "win32", arch: "arm64" });
    const mac = resolveReviewedCodexArtifact({ platform: "darwin", arch: "arm64" });

    expect(windows?.archiveFormat).toBe("raw");
    expect(windows?.artifactName).toBe("codex-aarch64-pc-windows-msvc.exe");
    expect(mac?.archiveFormat).toBe("tar.gz");
    expect(mac?.checksum).toEqual({
      algorithm: "sha256",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });
});
