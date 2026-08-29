import { describe, expect, it } from "vite-plus/test";

import {
  hydrateManagedRuntimeArtifact,
  managedRuntimeArtifactReceipt,
  type ManagedRuntimeArtifact,
} from "./managedRuntimeArtifact.ts";

const policy: ManagedRuntimeArtifact = {
  provider: "codex",
  version: "1.0.0",
  target: { platform: "darwin", arch: "arm64" },
  artifactName: "codex.tar.gz",
  url: "https://github.com/example/codex.tar.gz",
  allowedHosts: ["github.com", "objects.githubusercontent.com"],
  allowedUrlPathPrefixes: ["/example/"],
  checksum: { algorithm: "sha256", digest: "1".repeat(64) },
  size: 100,
  archiveFormat: "tar.gz",
  executablePath: "bin/codex",
  auxiliaryExecutablePaths: ["bin/codex-code-mode-host"],
  smokeArgs: ["--version"],
  catalogRevision: "bundled:1.0.0",
  supportTier: "fully_assisted",
  supportMessage: "Supported.",
};

describe("managed runtime artifact hydration", () => {
  it("changes only immutable release facts", () => {
    const hydrated = hydrateManagedRuntimeArtifact(policy, {
      ...managedRuntimeArtifactReceipt(policy),
      version: "1.1.0",
      artifactName: "codex-1.1.0.tar.gz",
      url: "https://objects.githubusercontent.com/example/codex-1.1.0.tar.gz",
      checksum: { algorithm: "sha256", digest: "2".repeat(64) },
      size: 120,
      catalogRevision: "catalog:1.1.0",
    });

    expect(hydrated).toMatchObject({
      version: "1.1.0",
      executablePath: "bin/codex",
      auxiliaryExecutablePaths: ["bin/codex-code-mode-host"],
      archiveFormat: "tar.gz",
      smokeArgs: ["--version"],
      catalogRevision: "catalog:1.1.0",
    });
  });

  it("cannot widen provider, target, source path, or checksum policy", () => {
    const receipt = managedRuntimeArtifactReceipt(policy);
    expect(hydrateManagedRuntimeArtifact(policy, { ...receipt, provider: "grok" })).toBeUndefined();
    expect(
      hydrateManagedRuntimeArtifact(policy, {
        ...receipt,
        target: { platform: "linux", arch: "x64", libc: "glibc" },
      }),
    ).toBeUndefined();
    expect(
      hydrateManagedRuntimeArtifact(policy, {
        ...receipt,
        url: "https://example.com/codex.tar.gz",
      }),
    ).toBeUndefined();
    expect(
      hydrateManagedRuntimeArtifact(policy, {
        ...receipt,
        url: "https://github.com/unrelated/project/codex.tar.gz",
      }),
    ).toBeUndefined();
    expect(
      hydrateManagedRuntimeArtifact(policy, {
        ...receipt,
        checksum: { algorithm: "sha512", digest: "2".repeat(128) },
      }),
    ).toBeUndefined();
    expect(
      hydrateManagedRuntimeArtifact(policy, {
        ...receipt,
        version: "../outside",
      }),
    ).toBeUndefined();
    expect(
      hydrateManagedRuntimeArtifact(policy, {
        ...receipt,
        url: "https://github.com:8443/codex.tar.gz",
      }),
    ).toBeUndefined();
  });
});
