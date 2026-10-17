import { describe, expect, it } from "vite-plus/test";
import {
  hydrateManagedRuntimeArtifact,
  type ManagedRuntimeArtifactReceipt,
} from "./managedRuntimeArtifact.ts";
import { compareManagedRuntimeVersions } from "./managedRuntimeVersion.ts";
import { managedRuntimeTargetKey } from "./target.ts";
import { MUSE_DOWNLOAD_URL, MUSE_TARGETS, resolveMuseArtifactPolicy } from "./museManifest.ts";
import { parseManagedMuseVersion } from "./museVersion.ts";

const version = "1.4.6-R6000.1";

describe("Muse managed runtime policy", () => {
  it("names the official six raw executables, never the installer package", () => {
    expect(
      MUSE_TARGETS.map((target) => resolveMuseArtifactPolicy(target)?.artifactName).sort(),
    ).toEqual([
      "muse-aarch64-linux",
      "muse-aarch64-macos",
      "muse-aarch64-windows.exe",
      "muse-x86-linux",
      "muse-x86-macos",
      "muse-x86-windows.exe",
    ]);
  });
  it.each(MUSE_TARGETS)("binds every raw target's identity: %j", (target) => {
    const policy = resolveMuseArtifactPolicy(target)!;
    const receipt: ManagedRuntimeArtifactReceipt = {
      provider: "muse",
      target,
      version,
      artifactName: policy.artifactName,
      url: `${MUSE_DOWNLOAD_URL}?channel=muse&version=${version}&file=${policy.artifactName}`,
      checksum: { algorithm: "sha256", digest: "a".repeat(64) },
      size: 463_719_160,
      catalogRevision: `test:${managedRuntimeTargetKey(target)}`,
    };
    expect(hydrateManagedRuntimeArtifact(policy, receipt)).toMatchObject({
      archiveFormat: "raw",
      smokeVersionFormat: "muse",
      executablePath: target.platform === "win32" ? "muse.exe" : "muse",
      smokeEnvironment: { MUSE_NO_AUTO_UPDATE: "1", MUSE_LOGIN: "0" },
    });
    for (const url of [
      receipt.url.replace("channel=muse", "channel=canary"),
      receipt.url.replace(version, "1.4.6-R6000.2"),
      `${receipt.url}&file=another-file`,
      `${receipt.url}&extra=1`,
      `${receipt.url}#fragment`,
      receipt.url.replace("lookaside.facebook.com", "lookaside.facebook.com.example.test"),
      receipt.url.replace("https://", "https://user:password@"),
      receipt.url.replace("/download/", "/download/other/"),
    ]) {
      expect(hydrateManagedRuntimeArtifact(policy, { ...receipt, url })).toBeUndefined();
    }
    expect(
      hydrateManagedRuntimeArtifact(policy, { ...receipt, version: "1.4.5-R9999.1" }),
    ).toBeUndefined();
    expect(
      hydrateManagedRuntimeArtifact(policy, { ...receipt, artifactName: "muse.pkg" }),
    ).toBeUndefined();
  });

  it("does not claim musl support", () => {
    expect(
      resolveMuseArtifactPolicy({ platform: "linux", arch: "x64", libc: "musl" }),
    ).toBeUndefined();
    expect(resolveMuseArtifactPolicy({ platform: "linux", arch: "arm64" })).toBeUndefined();
  });

  it.each([
    ["1.4.6-R9.1", "1.4.6-R10.1", "newer"],
    ["1.4.6-R10.1", "1.4.6-R9.1", "older"],
    ["1.4.6-R6000.1", "1.4.6-R6000.2", "newer"],
    ["1.4.6-R6000.1", "1.4.7-R1", "newer"],
    ["1.4.6-R6000.1", "1.4.6-R6000.1", "equal"],
    ["1.4.6-R6000.1", "1.4.6-R9007199254740992", "unknown"],
    ["1.4.6-R6000.1", "1.4.6-R6000.1-canary", "unknown"],
  ] as const)("orders %s against %s numerically", (current, candidate, expected) => {
    expect(compareManagedRuntimeVersions({ provider: "muse", current, candidate })).toBe(expected);
  });

  it("requires the full revision in native version output", () => {
    expect(parseManagedMuseVersion("Muse Code 1.4.6 (1.4.6-R6000.1)\n")).toBe(version);
    for (const output of [
      "1.4.6",
      "1.4.6-R6000.1-canary",
      "1.4.6-R6000.1.2",
      "1.4.6-R06000.1",
      "9.1.4.6-R6000.1",
    ]) {
      expect(parseManagedMuseVersion(output)).toBeUndefined();
    }
  });
});
