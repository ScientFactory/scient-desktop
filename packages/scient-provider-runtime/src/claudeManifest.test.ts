import { describe, expect, it } from "vite-plus/test";

import { resolveReviewedClaudeArtifact } from "./claudeManifest.ts";

describe("reviewed Claude runtime manifest", () => {
  it("maps every official Claude Code desktop target to a verified raw executable", () => {
    const targets = [
      { platform: "darwin", arch: "arm64" },
      { platform: "darwin", arch: "x64" },
      { platform: "linux", arch: "arm64", libc: "glibc" },
      { platform: "linux", arch: "x64", libc: "glibc" },
      { platform: "linux", arch: "arm64", libc: "musl" },
      { platform: "linux", arch: "x64", libc: "musl" },
      { platform: "win32", arch: "arm64" },
      { platform: "win32", arch: "x64" },
    ] as const;

    for (const target of targets) {
      const artifact = resolveReviewedClaudeArtifact(target);
      expect(artifact?.provider).toBe("claudeAgent");
      expect(artifact?.version).toBe("2.1.245");
      expect(artifact?.archiveFormat).toBe("raw");
      expect(artifact?.supportTier).toBe("fully_assisted");
      expect(artifact?.checksum).toEqual({
        algorithm: "sha256",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(artifact?.url).toMatch(/^https:\/\/downloads\.claude\.ai\//u);
    }
  });

  it("uses the platform executable name expected by each host", () => {
    const macos = resolveReviewedClaudeArtifact({ platform: "darwin", arch: "arm64" });
    const linux = resolveReviewedClaudeArtifact({
      platform: "linux",
      arch: "x64",
      libc: "glibc",
    });
    const windowsX64 = resolveReviewedClaudeArtifact({ platform: "win32", arch: "x64" });
    const windowsArm64 = resolveReviewedClaudeArtifact({ platform: "win32", arch: "arm64" });

    expect(macos?.executablePath).toBe("claude");
    expect(macos?.url).toMatch(/\/darwin-arm64\/claude$/u);
    expect(linux?.executablePath).toBe("claude");
    expect(linux?.url).toMatch(/\/linux-x64\/claude$/u);
    expect(windowsX64?.executablePath).toBe("claude.exe");
    expect(windowsX64?.url).toMatch(/\/win32-x64\/claude\.exe$/u);
    expect(windowsArm64?.executablePath).toBe("claude.exe");
    expect(windowsArm64?.url).toMatch(/\/win32-arm64\/claude\.exe$/u);
  });

  it("matches Anthropic's immutable 2.1.245 manifest", () => {
    const expected = [
      [
        { platform: "darwin", arch: "arm64" },
        "9f7c2260251765a18d0b35198669dacc1912f6e8129a3b01f6b58d93365ff1f1",
        376_109_392,
      ],
      [
        { platform: "darwin", arch: "x64" },
        "de044bb543e826352f31587a74356e1b2dae94dc1b9c960a362d9f07df96c2a7",
        385_137_136,
      ],
      [
        { platform: "linux", arch: "arm64", libc: "glibc" },
        "d0da299303d710a7cc5cdece9629958f5128ce1a727e15463c651ed5cf385c7f",
        389_077_224,
      ],
      [
        { platform: "linux", arch: "x64", libc: "glibc" },
        "16ad2b94deaf7b29abed966d981c9991a47af0420f5be8ed4a3f83bea9f678bc",
        391_948_592,
      ],
      [
        { platform: "linux", arch: "arm64", libc: "musl" },
        "8707fbe629fdd9876d9c356baa833a697dac76cd9a7157088f667199b8492851",
        382_222_104,
      ],
      [
        { platform: "linux", arch: "x64", libc: "musl" },
        "d25564bc5d84ec988a762cfe25fe51cb706b96eaec614f704ddbf653ab08ba00",
        386_060_256,
      ],
      [
        { platform: "win32", arch: "arm64" },
        "9cff8169be24a8b3e59e89e58d9e3d37f3c17ca1b3a149e60666fe53c789d80a",
        372_111_520,
      ],
      [
        { platform: "win32", arch: "x64" },
        "d1649bf5261792fee7e1a1b63fdd2197082adec36ce9701aa0c1723bdcd2348a",
        384_213_664,
      ],
    ] as const;

    for (const [target, sha256, size] of expected) {
      const artifact = resolveReviewedClaudeArtifact(target);
      expect(artifact?.checksum).toEqual({ algorithm: "sha256", digest: sha256 });
      expect(artifact?.size).toBe(size);
    }
  });
});
