import { describe, expect, it } from "vite-plus/test";
import { resolveReviewedPiArtifact } from "./piManifest.ts";
import { ManagedPiRuntime } from "./managedPiRuntime.ts";

describe("reviewed Pi runtime", () => {
  it.each([
    ["darwin", "arm64", "pi-darwin-arm64.tar.gz", "tar.gz", "pi/pi", 31_035_676],
    ["darwin", "x64", "pi-darwin-x64.tar.gz", "tar.gz", "pi/pi", 33_544_584],
    ["linux", "arm64", "pi-linux-arm64.tar.gz", "tar.gz", "pi/pi", 42_628_180],
    ["linux", "x64", "pi-linux-x64.tar.gz", "tar.gz", "pi/pi", 42_560_927],
    ["win32", "arm64", "pi-windows-arm64.zip", "zip", "pi.exe", 43_556_369],
    ["win32", "x64", "pi-windows-x64.zip", "zip", "pi.exe", 45_009_021],
  ] as const)(
    "pins the official %s %s archive and private executable",
    (platform, arch, artifactName, archiveFormat, executablePath, size) => {
      const artifact = resolveReviewedPiArtifact({
        platform,
        arch,
        ...(platform === "linux" ? { libc: "glibc" as const } : {}),
      });
      expect(artifact).toMatchObject({
        provider: "pi",
        version: "0.85.1",
        artifactName,
        archiveFormat,
        size,
        executablePath,
        smokeEnvironment: {
          PI_TELEMETRY: "0",
          PI_SKIP_VERSION_CHECK: "1",
          PI_OFFLINE: "1",
        },
      });
      expect(artifact?.url).toBe(
        `https://github.com/earendil-works/pi/releases/download/v0.85.1/${artifactName}`,
      );
      expect(
        new ManagedPiRuntime("/scient-test").launchPath(artifact!).replaceAll("\\", "/"),
      ).toContain(
        `/provider-runtimes/pi/versions/0.85.1/${platform}-${arch}${platform === "linux" ? "-glibc" : ""}/${executablePath}`,
      );
    },
  );

  it("pins the reviewed release digests", () => {
    const artifact = resolveReviewedPiArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toMatchObject({
      checksum: {
        algorithm: "sha256",
        digest: "d5f70e3c0cf7398eac239fd0261ee074d98b7ba7f6b43fe3617f052ed5b79d06",
      },
    });
  });

  it("does not offer unqualified native targets", () => {
    expect(
      resolveReviewedPiArtifact({ platform: "linux", arch: "arm64", libc: "musl" }),
    ).toBeUndefined();
    expect(
      resolveReviewedPiArtifact({ platform: "linux", arch: "x64", libc: "musl" }),
    ).toBeUndefined();
  });
});
