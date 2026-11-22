import { describe, expect, it } from "vite-plus/test";

import {
  fitsManagedRuntimeDownloadLimit,
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
  it("resolves source-owned version bounds without trusting receipt packaging fields", () => {
    const versionedPolicy = {
      ...policy,
      auxiliaryExecutableRules: [
        { path: "always" },
        { path: "legacy", maximumVersionExclusive: "1.1.0" },
        { path: "modern", minimumVersion: "1.1.0", maximumVersionExclusive: "2.0.0" },
      ],
    };
    for (const [version, expected] of [
      ["1.0.0", ["always", "legacy"]],
      ["1.1.0", ["always", "modern"]],
      ["2.0.0", ["always"]],
    ] as const) {
      const receipt = {
        ...managedRuntimeArtifactReceipt(policy),
        version,
        auxiliaryExecutablePaths: ["unreviewed"],
        auxiliaryExecutableRules: [],
      };
      const hydrated = hydrateManagedRuntimeArtifact(versionedPolicy, receipt)!;
      expect(hydrated.auxiliaryExecutablePaths).toEqual(expected);
      expect(hydrated.auxiliaryExecutableRules).toBe(versionedPolicy.auxiliaryExecutableRules);
      expect(managedRuntimeArtifactReceipt(hydrated)).not.toHaveProperty(
        "auxiliaryExecutableRules",
      );
    }
  });

  it.each(["latest", "1.1.0-beta.1", "1.1.0+build", "01.1.0"])(
    "rejects ambiguous version %s for versioned packaging",
    (version) => {
      expect(
        hydrateManagedRuntimeArtifact(
          { ...policy, auxiliaryExecutableRules: [{ path: "required" }] },
          { ...managedRuntimeArtifactReceipt(policy), version },
        ),
      ).toBeUndefined();
    },
  );

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

  it("judges a download by its family's limit, on the file it would fetch", () => {
    const receipt = managedRuntimeArtifactReceipt(policy);
    const mib = 1024 * 1024;
    const fits = (artifact: ReturnType<typeof hydrateManagedRuntimeArtifact>) =>
      artifact !== undefined && fitsManagedRuntimeDownloadLimit(artifact);
    expect(fits(hydrateManagedRuntimeArtifact(policy, { ...receipt, size: 512 * mib }))).toBe(true);
    expect(fits(hydrateManagedRuntimeArtifact(policy, { ...receipt, size: 512 * mib + 1 }))).toBe(
      false,
    );
    const larger = { ...policy, maxDownloadBytes: 1024 * mib };
    expect(fits(hydrateManagedRuntimeArtifact(larger, { ...receipt, size: 578 * mib }))).toBe(true);
    const withCopy = {
      ...policy,
      compressedArtifactName: "codex.tar.gz.zst",
      releaseUrlPrefix: "https://github.com/example/",
    };
    // The policy's release URLs: version, then artifact.
    const atRelease = { ...receipt, url: "https://github.com/example/1.0.0/codex.tar.gz" };
    const copy = (size: number) =>
      ({
        format: "zstd",
        size,
        checksum: { algorithm: "sha256", digest: "a".repeat(64) },
      }) as const;
    const release = (raw: number, zstd: number) =>
      hydrateManagedRuntimeArtifact(withCopy, { ...atRelease, size: raw * mib }, copy(zstd * mib));
    // The zstd copy is what gets downloaded, so it is the one judged.
    expect(fits(release(600, 300))).toBe(true);
    // A copy too large to download is left out, and the raw binary judged on its own.
    expect(release(500, 513)?.compressed).toBeUndefined();
    expect(fits(release(500, 513))).toBe(true);
    expect(fits(release(600, 513))).toBe(false);
    // An installation receipt names no copy: it still describes what is installed, but a download
    // from it would fetch the raw binary.
    const installed = hydrateManagedRuntimeArtifact(withCopy, { ...atRelease, size: 600 * mib });
    expect(installed).toBeDefined();
    expect(fits(installed)).toBe(false);
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
