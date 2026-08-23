import { describe, expect, it } from "vite-plus/test";

import { resolveReviewedDroidArtifact } from "./droidManifest.ts";

describe("reviewed Droid runtime manifest", () => {
  it.each([
    { platform: "darwin", arch: "arm64" },
    { platform: "darwin", arch: "x64" },
    { platform: "linux", arch: "arm64", libc: "glibc" },
    { platform: "linux", arch: "x64", libc: "glibc" },
    { platform: "win32", arch: "arm64" },
    { platform: "win32", arch: "x64" },
  ] as const)("maps $platform-$arch to an exact reviewed Factory artifact", (target) => {
    const artifact = resolveReviewedDroidArtifact(target);

    expect(artifact?.provider).toBe("droid");
    expect(artifact?.version).toBe("0.202.0");
    expect(artifact?.supportTier).toBe("fully_assisted");
    expect(artifact?.archiveFormat).toBe("raw");
    expect(artifact?.checksum).toEqual({
      algorithm: "sha256",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(artifact?.size).toBeGreaterThan(100_000_000);
    expect(artifact?.smokeEnvironment).toEqual({
      FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
    });
    expect(artifact?.url).toMatch(
      /^https:\/\/downloads\.factory\.ai\/factory-cli\/releases\/0\.202\.0\//u,
    );
  });

  it("uses Factory's baseline x64 builds and native executable names", () => {
    expect(resolveReviewedDroidArtifact({ platform: "darwin", arch: "x64" })?.url).toContain(
      "/darwin/x64-baseline/droid",
    );
    expect(
      resolveReviewedDroidArtifact({ platform: "linux", arch: "x64", libc: "glibc" })?.url,
    ).toContain("/linux/x64-baseline/droid");
    expect(resolveReviewedDroidArtifact({ platform: "win32", arch: "x64" })?.executablePath).toBe(
      "droid.exe",
    );
  });

  it("does not claim managed support for Linux musl", () => {
    expect(
      resolveReviewedDroidArtifact({ platform: "linux", arch: "x64", libc: "musl" }),
    ).toBeUndefined();
  });
});
