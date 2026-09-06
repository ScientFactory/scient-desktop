import { describe, expect, it } from "vite-plus/test";
import { resolveReviewedPiArtifact } from "./piManifest.ts";
import { ManagedPiRuntime } from "./managedPiRuntime.ts";

describe("reviewed Pi runtime", () => {
  it("pins the official native macOS ARM64 archive and private executable", () => {
    const artifact = resolveReviewedPiArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toMatchObject({
      provider: "pi",
      version: "0.84.4",
      archiveFormat: "tar.gz",
      size: 30_928_407,
      executablePath: "pi/pi",
      checksum: {
        algorithm: "sha256",
        digest: "c68e3ac4d05b4e282aaab2e6c76f161d3e9e68f19a22e38913cbfaadb6c800f0",
      },
    });
    expect(
      new ManagedPiRuntime("/scient-test").launchPath(artifact!).replaceAll("\\", "/"),
    ).toContain("/provider-runtimes/pi/versions/0.84.4/darwin-arm64/pi/pi");
  });
  it("does not offer unqualified native targets", () => {
    expect(resolveReviewedPiArtifact({ platform: "darwin", arch: "x64" })).toBeUndefined();
    expect(
      resolveReviewedPiArtifact({ platform: "linux", arch: "x64", libc: "glibc" }),
    ).toBeUndefined();
    expect(resolveReviewedPiArtifact({ platform: "win32", arch: "x64" })).toBeUndefined();
  });
});
