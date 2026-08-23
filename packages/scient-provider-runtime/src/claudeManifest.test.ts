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
      expect(artifact?.version).toBe("2.1.170");
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

  it("matches Anthropic's immutable 2.1.170 manifest", () => {
    const expected = [
      [
        { platform: "darwin", arch: "arm64" },
        "e903646d8b7a31882a80ecd27569a27d8ac57b3708745f349709632c84117fdf",
        222_102_816,
      ],
      [
        { platform: "darwin", arch: "x64" },
        "914f23a70bbed5d9ae567e3e04b86206ed9971b371bc9baca3f79c8885bfddb4",
        224_616_976,
      ],
      [
        { platform: "linux", arch: "arm64", libc: "glibc" },
        "1bb9d032440a75532f7dd4cafbc687f220aaf16c63eba17e192dfbec2f04bd25",
        247_379_592,
      ],
      [
        { platform: "linux", arch: "x64", libc: "glibc" },
        "849e007277a0442ab27570d3e3d6d43787507946590e8dd1947e5a39b7081f9e",
        247_469_776,
      ],
      [
        { platform: "linux", arch: "arm64", libc: "musl" },
        "73154fd674aaf233254edea8fbfb6a53d82d5297ae7546b998e36983def4dddc",
        240_234_328,
      ],
      [
        { platform: "linux", arch: "x64", libc: "musl" },
        "5d19b7c91a03182ccb69da249f721684aebecfa4c52fe46b9205a81d8fc64a47",
        241_863_728,
      ],
      [
        { platform: "win32", arch: "arm64" },
        "9abd330bcc191aecc877a8ee9da2b448852cfe3bda15e5e4608385ea1d9d1709",
        238_894_240,
      ],
      [
        { platform: "win32", arch: "x64" },
        "193061508fe619abf534b2c9d48151f26971d1d5b8460ad75c0af4be3d3525fb",
        242_929_824,
      ],
    ] as const;

    for (const [target, sha256, size] of expected) {
      const artifact = resolveReviewedClaudeArtifact(target);
      expect(artifact?.checksum).toEqual({ algorithm: "sha256", digest: sha256 });
      expect(artifact?.size).toBe(size);
    }
  });
});
