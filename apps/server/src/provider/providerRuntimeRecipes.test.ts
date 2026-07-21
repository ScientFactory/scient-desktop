// FILE: providerRuntimeRecipes.test.ts
// Purpose: Verifies trusted moving provider manifests produce safe managed-runtime artifacts.
// Layer: Provider runtime recipe tests

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderRuntimeTarget } from "./providerRuntimeTypes";
import { getProviderRuntimeRecipe, ProviderRuntimeRecipeError } from "./providerRuntimeRecipes";

const TARGET: ProviderRuntimeTarget = {
  platform: "darwin",
  arch: "arm64",
  cpu: "standard",
};
const SHA512 = "a".repeat(128);

function mockManifest(input: {
  readonly version: string;
  readonly url?: string;
  readonly sha512?: string;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        version: input.version,
        url:
          input.url ??
          `https://storage.googleapis.com/antigravity-public/antigravity-cli/${input.version}-build/darwin-arm/cli_mac_arm64.tar.gz`,
        sha512: input.sha512 ?? SHA512,
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Antigravity managed runtime recipe", () => {
  it("follows a newer stable release on the trusted official manifest", async () => {
    mockManifest({ version: "1.1.5" });

    const artifact = await getProviderRuntimeRecipe("antigravity").resolve(
      TARGET,
      new AbortController().signal,
    );

    expect(artifact).toMatchObject({
      provider: "antigravity",
      version: "1.1.5",
      digestAlgorithm: "sha512",
      digest: SHA512,
      allowedHosts: ["storage.googleapis.com"],
      archiveFormat: "tar.gz",
      executablePath: "antigravity",
    });
    expect(artifact.catalogRevision).toBe(`antigravity:1.1.5:${SHA512}`);
  });

  it.each([
    ["prerelease version", { version: "1.1.6-beta.1" }, "invalid version"],
    ["older incompatible version", { version: "1.1.3" }, "minimum compatible version"],
    ["invalid digest", { version: "1.1.5", sha512: "not-a-digest" }, "valid SHA-512"],
    [
      "untrusted artifact host",
      { version: "1.1.5", url: "https://example.com/antigravity-cli/1.1.5-build/agy" },
      "untrusted artifact host",
    ],
    [
      "mismatched artifact version",
      {
        version: "1.1.5",
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.4-build/darwin-arm/cli_mac_arm64.tar.gz",
      },
      "does not match its version",
    ],
    [
      "different Google Cloud Storage bucket",
      {
        version: "1.1.5",
        url: "https://storage.googleapis.com/untrusted/antigravity-cli/1.1.5-build/darwin-arm/cli_mac_arm64.tar.gz",
      },
      "does not match its version",
    ],
  ] as const)("rejects a %s", async (_label, manifest, expectedMessage) => {
    mockManifest(manifest);

    await expect(
      getProviderRuntimeRecipe("antigravity").resolve(TARGET, new AbortController().signal),
    ).rejects.toThrow(expectedMessage);
  });

  it("preserves recipe error classification for invalid official metadata", async () => {
    mockManifest({ version: "1.1.5", sha512: "broken" });

    await expect(
      getProviderRuntimeRecipe("antigravity").resolve(TARGET, new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderRuntimeRecipeError);
  });
});
