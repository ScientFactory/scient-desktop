import { describe, expect, it } from "vite-plus/test";

import { resolveReviewedCodexArtifact } from "./codexManifest.ts";

describe("reviewed Codex runtime manifest", () => {
  it("advertises only the proven macOS Apple Silicon row as fully assisted", () => {
    const proven = resolveReviewedCodexArtifact({ platform: "darwin", arch: "arm64" });
    const macIntel = resolveReviewedCodexArtifact({ platform: "darwin", arch: "x64" });
    const windows = resolveReviewedCodexArtifact({ platform: "win32", arch: "x64" });
    const linux = resolveReviewedCodexArtifact({
      platform: "linux",
      arch: "x64",
      libc: "glibc",
    });

    expect(proven?.supportTier).toBe("fully_assisted");
    expect(macIntel?.supportTier).toBe("external_runtime_supported");
    expect(windows?.supportTier).toBe("external_runtime_supported");
    expect(linux?.supportTier).toBe("external_runtime_supported");
  });

  it("uses raw official executables on Windows and reviewed archives elsewhere", () => {
    const windows = resolveReviewedCodexArtifact({ platform: "win32", arch: "arm64" });
    const mac = resolveReviewedCodexArtifact({ platform: "darwin", arch: "arm64" });

    expect(windows?.archiveFormat).toBe("raw");
    expect(windows?.artifactName).toBe("codex-aarch64-pc-windows-msvc.exe");
    expect(mac?.archiveFormat).toBe("tar.gz");
    expect(mac?.sha256).toHaveLength(64);
  });
});
