import { describe, expect, it } from "vite-plus/test";

import { resolveReviewedAntigravityArtifact } from "./antigravityManifest.ts";

describe("reviewed Antigravity runtime manifest", () => {
  it.each([
    { platform: "darwin", arch: "arm64" },
    { platform: "darwin", arch: "x64" },
    { platform: "linux", arch: "arm64", libc: "glibc" },
    { platform: "linux", arch: "x64", libc: "glibc" },
    { platform: "win32", arch: "arm64" },
    { platform: "win32", arch: "x64" },
  ] as const)("maps $platform-$arch to a reviewed official artifact", (target) => {
    const artifact = resolveReviewedAntigravityArtifact(target);

    expect(artifact?.provider).toBe("antigravity");
    expect(artifact?.version).toBe("1.1.19");
    expect(artifact?.supportTier).toBe("fully_assisted");
    expect(artifact?.checksum).toEqual({
      algorithm: "sha512",
      digest: expect.stringMatching(/^[a-f0-9]{128}$/u),
    });
    expect(artifact?.smokeEnvironment).toEqual({ AGY_CLI_DISABLE_AUTO_UPDATE: "true" });
    expect(artifact?.url).toMatch(
      /^https:\/\/storage\.googleapis\.com\/antigravity-public\/antigravity-cli\//u,
    );
  });

  it("uses Google's tarball executable name on Unix and agy.exe on Windows", () => {
    expect(
      resolveReviewedAntigravityArtifact({ platform: "darwin", arch: "arm64" })?.executablePath,
    ).toBe("antigravity");
    expect(
      resolveReviewedAntigravityArtifact({ platform: "win32", arch: "x64" })?.executablePath,
    ).toBe("agy.exe");
  });

  it("does not claim managed support for Linux musl, which Google does not publish", () => {
    expect(
      resolveReviewedAntigravityArtifact({ platform: "linux", arch: "x64", libc: "musl" }),
    ).toBeUndefined();
  });
});
