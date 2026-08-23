import { describe, expect, it } from "vite-plus/test";

import { resolveReviewedGrokArtifact } from "./grokManifest.ts";

describe("reviewed Grok runtime manifest", () => {
  it.each([
    {
      platform: "darwin",
      arch: "arm64",
      size: 134_349_648,
      digest:
        "553d984996535f3086f063ce35c02232126ef031bac59c545fe2a180026af8429fccd218999c134a3738400383c0fbbade4ea853103c0c41903309cf815d6e12",
    },
    {
      platform: "darwin",
      arch: "x64",
      size: 150_381_856,
      digest:
        "12d85cb440d49a2fd3b072cd3053a0e8e841cb31f0839f041ba925b4a9e0223e1f122e6c56695468ddbbb81f60cb163b1f7db6538bd54c93c475c0c189e2ab15",
    },
    {
      platform: "linux",
      arch: "arm64",
      libc: "glibc",
      size: 136_259_976,
      digest:
        "df19133ff2f4166c67abf6f62cc62a92df7d756b0019432c112cf83d9ce71e45972730799393ac3d1f51949a6eb3987167da82c52d8bd09f8299168ef60e5392",
    },
    {
      platform: "linux",
      arch: "x64",
      libc: "glibc",
      size: 166_854_368,
      digest:
        "4857b5b3f95d1b6ae463e54907057584afc34c1203ea565d4816487183045d4c6b2ddcca236aa1086fd79c82a3b54ece67f1a04377fb677c61af309928a8f224",
    },
    {
      platform: "win32",
      arch: "arm64",
      size: 123_656_008,
      digest:
        "5c7bd27a90a614cef6f62b4bbad18e893acbf77aa25cc0ec5ab259a51d9713c9cebba6a7fa53fac3f45c0b93d7f49063fa80d9ebfecb5efbb1a8286a7c3e3935",
    },
    {
      platform: "win32",
      arch: "x64",
      size: 142_651_720,
      digest:
        "b421b9fe7697ffda67d7c9e8b6c6fabaf0fa194f9f3234c7198397105d0dcff89587b1e7d3a234d016b7801b05f4e0c7785983a75fe2ecf6a470f7bdd7072730",
    },
  ] as const)("pins the official $platform-$arch release", ({ size, ...target }) => {
    const { digest, ...runtimeTarget } = target;
    const artifact = resolveReviewedGrokArtifact(runtimeTarget);

    expect(artifact?.provider).toBe("grok");
    expect(artifact?.version).toBe("1.0.5");
    expect(artifact?.size).toBe(size);
    expect(artifact?.archiveFormat).toBe("raw");
    expect(artifact?.allowedHosts).toEqual(["x.ai"]);
    expect(artifact?.checksum).toEqual({
      algorithm: "sha512",
      digest,
    });
    expect(artifact?.url).toBe(`https://x.ai/cli/${artifact?.artifactName}`);
  });

  it("uses the platform executable name", () => {
    expect(resolveReviewedGrokArtifact({ platform: "darwin", arch: "arm64" })?.executablePath).toBe(
      "grok",
    );
    expect(resolveReviewedGrokArtifact({ platform: "win32", arch: "x64" })?.executablePath).toBe(
      "grok.exe",
    );
  });

  it("does not claim support for unpublished Linux musl builds", () => {
    expect(resolveReviewedGrokArtifact({ platform: "linux", arch: "x64", libc: "musl" })).toBe(
      undefined,
    );
  });
});
