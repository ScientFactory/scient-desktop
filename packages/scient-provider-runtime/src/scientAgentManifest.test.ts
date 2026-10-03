import { describe, expect, it } from "vite-plus/test";

import {
  hydrateManagedRuntimeArtifact,
  type ManagedRuntimeArtifactReceipt,
} from "./managedRuntimeArtifact.ts";
import { ManagedScientAgentRuntime } from "./managedScientAgentRuntime.ts";
import {
  isSupportedScientAgentVersion,
  resolveScientAgentArtifactPolicy,
} from "./scientAgentManifest.ts";

const target = { platform: "darwin", arch: "arm64" } as const;
const policy = resolveScientAgentArtifactPolicy(target)!;
const receipt: ManagedRuntimeArtifactReceipt = {
  provider: "scient",
  target,
  version: "0.1.0",
  artifactName: "scient-agent-darwin-arm64",
  url: "https://github.com/ScientFactory/scient-agent/releases/download/v0.1.0/scient-agent-darwin-arm64",
  checksum: { algorithm: "sha256", digest: "a".repeat(64) },
  size: 123456,
  catalogRevision: "test:scient:0.1.0",
};

describe("Scient Agent managed release policy", () => {
  it("defines packaging without claiming a published release", () => {
    expect(policy).toMatchObject({
      provider: "scient",
      archiveFormat: "raw",
      smokeArgs: ["--runtime-info"],
    });
    for (const key of ["version", "url", "size", "catalogRevision"]) {
      expect(policy).not.toHaveProperty(key);
    }
    expect(policy.checksum).not.toHaveProperty("digest");
  });

  it("names each platform's release binary as the agent's release workflow does", () => {
    const named = (target: Parameters<typeof resolveScientAgentArtifactPolicy>[0]) => {
      const entry = resolveScientAgentArtifactPolicy(target);
      return entry && [entry.artifactName, entry.executablePath];
    };
    expect(named({ platform: "darwin", arch: "arm64" })).toEqual([
      "scient-agent-darwin-arm64",
      "scient-agent",
    ]);
    expect(named({ platform: "darwin", arch: "x64" })).toEqual([
      "scient-agent-darwin-x64",
      "scient-agent",
    ]);
    expect(named({ platform: "linux", arch: "arm64", libc: "glibc" })).toEqual([
      "scient-agent-linux-arm64",
      "scient-agent",
    ]);
    expect(named({ platform: "linux", arch: "x64", libc: "glibc" })).toEqual([
      "scient-agent-linux-x64",
      "scient-agent",
    ]);
    expect(named({ platform: "win32", arch: "arm64" })).toEqual([
      "scient-agent-windows-arm64.exe",
      "scient-agent.exe",
    ]);
    expect(named({ platform: "win32", arch: "x64" })).toEqual([
      "scient-agent-windows-x64.exe",
      "scient-agent.exe",
    ]);
    // No musl build: the desktop app needs glibc.
    expect(named({ platform: "linux", arch: "x64", libc: "musl" })).toBeUndefined();
  });

  it.each([
    "0.0.9",
    "1.0.0",
    "2.0.0",
    "0.1.0-beta.1",
    "0.1.0+build",
    "v0.1.0",
    "00.1.0",
    "../0.1.0",
  ])("refuses incompatible or nonstable version %s", (version) => {
    expect(isSupportedScientAgentVersion(version)).toBe(false);
    expect(
      hydrateManagedRuntimeArtifact(policy, {
        ...receipt,
        version,
        url: receipt.url.replace("v0.1.0/", `v${version}/`),
      }),
    ).toBeUndefined();
  });

  it("hydrates a real release or durable receipt and keeps its installation private", () => {
    const artifact = hydrateManagedRuntimeArtifact(policy, receipt)!;
    expect(artifact).toMatchObject({
      ...receipt,
      executablePath: "scient-agent",
      supportTier: "fully_assisted",
    });
    expect(
      new ManagedScientAgentRuntime("/scient-data").launchPath(artifact).replaceAll("\\", "/"),
    ).toBe("/scient-data/provider-runtimes/scient-agent/versions/0.1.0/darwin-arm64/scient-agent");
    expect(isSupportedScientAgentVersion("0.2.0")).toBe(true);
  });

  it("binds the release to its exact product, tag, asset, target and checksum policy", () => {
    const invalid: ReadonlyArray<Partial<ManagedRuntimeArtifactReceipt>> = [
      { provider: "omp" },
      { target: { platform: "darwin", arch: "x64" } },
      { artifactName: "omp-darwin-arm64" },
      { url: receipt.url.replace("v0.1.0/", "v0.2.0/") },
      { url: receipt.url.replace("scient-agent-darwin-arm64", "another-asset") },
      { url: `${receipt.url}?download=1` },
      { checksum: { algorithm: "sha512", digest: "a".repeat(128) } },
      { checksum: { algorithm: "sha256", digest: "z".repeat(64) } },
    ];
    for (const change of invalid) {
      expect(hydrateManagedRuntimeArtifact(policy, { ...receipt, ...change })).toBeUndefined();
    }
  });
});
