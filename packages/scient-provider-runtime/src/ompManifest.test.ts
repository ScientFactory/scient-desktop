import { describe, expect, it } from "vite-plus/test";

import {
  OMP_MINIMUM_VERSION,
  OMP_SUPPORTED_MAJOR,
  isSupportedOmpMajor,
  resolveReviewedOmpArtifact,
} from "./ompManifest.ts";

describe("Oh My Pi managed artifact", () => {
  it("publishes only the qualified macOS arm64 raw binary", () => {
    const artifact = resolveReviewedOmpArtifact({ platform: "darwin", arch: "arm64" });
    expect(artifact).toMatchObject({
      provider: "omp",
      version: "18.2.8",
      artifactName: "omp-darwin-arm64",
      archiveFormat: "raw",
      executablePath: "omp",
      size: 193_484_176,
      checksum: {
        algorithm: "sha256",
        digest: "cf8d34a7fe6f60de1acbe74f29c82026e4c07888e9d89f7ebceeb922159e5787",
      },
      supportTier: "fully_assisted",
    });
    expect(resolveReviewedOmpArtifact({ platform: "darwin", arch: "x64" })).toBeUndefined();
    expect(
      resolveReviewedOmpArtifact({ platform: "linux", arch: "arm64", libc: "musl" }),
    ).toBeUndefined();
  });
});

describe("Oh My Pi supported major", () => {
  it("accepts only releases inside the supported major", () => {
    expect(OMP_SUPPORTED_MAJOR).toBe(18);
    expect(isSupportedOmpMajor(OMP_MINIMUM_VERSION)).toBe(true);
    expect(isSupportedOmpMajor("v18.3.1")).toBe(true);
    expect(isSupportedOmpMajor("19.0.0")).toBe(false);
    expect(isSupportedOmpMajor("17.9.9")).toBe(false);
    expect(isSupportedOmpMajor("latest")).toBe(false);
  });
});
