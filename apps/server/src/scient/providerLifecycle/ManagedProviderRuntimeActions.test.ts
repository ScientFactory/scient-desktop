// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the local process and managed-runtime filesystem boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  ManagedProviderRuntimeError,
  ManagedProviderRuntime,
  ManagedRuntimeFileError,
  type ManagedRuntimeArtifact,
} from "@scientfactory/provider-runtime";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  makeManagedProviderRuntimeDiagnostics,
  makeManagedProviderRuntimeResolution,
  managedRuntimeInstallationFailureMessage,
  nativeProviderRuntimeBackendLabel,
  resolveManagedRuntimePolicy,
  resolveManagedRuntimeSource,
} from "./ManagedProviderRuntimeActions.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const reviewedArtifact: ManagedRuntimeArtifact = {
  provider: "claudeAgent",
  version: "1.0.0",
  target: { platform: "darwin", arch: "arm64" },
  artifactName: "claude",
  url: "https://example.com/claude",
  allowedHosts: ["example.com"],
  checksum: { algorithm: "sha256", digest: "0".repeat(64) },
  size: 100,
  archiveFormat: "raw",
  executablePath: "claude",
  smokeArgs: ["--version"],
  catalogRevision: "test:claude:1.0.0",
  supportTier: "fully_assisted",
  supportMessage: "Managed Claude is supported.",
};

describe("managed provider runtime source", () => {
  it("reports an unhealthy custom runtime honestly without replacing it", () => {
    expect(
      resolveManagedRuntimeSource({
        hasCustomRuntime: true,
        configuredRuntimeHealthy: false,
        managedInstalled: true,
        managedSelected: true,
      }),
    ).toBe("unknown");
  });

  it("distinguishes healthy configured, managed, and missing runtimes", () => {
    expect(
      resolveManagedRuntimeSource({
        hasCustomRuntime: true,
        configuredRuntimeHealthy: true,
        managedInstalled: false,
        managedSelected: false,
      }),
    ).toBe("custom");
    expect(
      resolveManagedRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: false,
        managedInstalled: true,
        managedSelected: false,
      }),
    ).toBe("scient_managed");
    expect(
      resolveManagedRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: false,
        managedInstalled: false,
        managedSelected: false,
      }),
    ).toBe("missing");
  });

  it("uses an explicit managed selection without silently promoting legacy state", () => {
    expect(
      resolveManagedRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: true,
        managedInstalled: true,
        managedSelected: false,
      }),
    ).toBe("system");
    expect(
      resolveManagedRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: true,
        managedInstalled: true,
        managedSelected: true,
      }),
    ).toBe("scient_managed");
    expect(
      resolveManagedRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: true,
        managedInstalled: false,
        managedSelected: true,
      }),
    ).toBe("scient_managed");
  });
});

describe("managed provider runtime policy", () => {
  it("advertises system-to-managed installation only after explicit provider qualification", () => {
    const base = {
      source: "system" as const,
      artifact: reviewedArtifact,
      installed: false,
      installedVersion: null,
      managedInstallationAllowed: true,
    };

    expect(
      resolveManagedRuntimePolicy({ ...base, systemToManagedSwitchAllowed: false }).actions,
    ).toEqual([]);
    expect(
      resolveManagedRuntimePolicy({ ...base, systemToManagedSwitchAllowed: true }).actions,
    ).toEqual(["install"]);
  });

  it("exposes the qualified handoff through the real generic resolution boundary", async () => {
    const baseDir = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "scient-managed-provider-resolution-"),
    );
    temporaryRoots.push(baseDir);
    const resolution = await Effect.runPromise(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return yield* makeManagedProviderRuntimeResolution({
          configuredBinaryPath: process.execPath,
          defaultBinary: process.execPath,
          providerName: "Claude",
          providerSlug: "claude",
          runtime: new ManagedProviderRuntime(baseDir, {
            providerDirectory: "claude",
            displayName: "Claude",
          }),
          artifact: reviewedArtifact,
          targetLabel: "darwin-arm64",
          environment: process.env,
          spawner,
          managedInstallationAllowed: true,
          systemToManagedSwitchAllowed: true,
          sourceLabel: "Official Anthropic Claude Code release",
          managedInstallationLimitation: "Managed installation is unavailable here.",
          diagnosticsHomePath: null,
          diagnosticsBackend: "macOS native",
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(resolution.summary).toMatchObject({ source: "system", actions: ["install"] });
    expect(await Effect.runPromise(resolution.actions.plan("install"))).toMatchObject({
      action: "install",
      message: expect.stringContaining("system installation"),
    });
    expect(resolution.effectiveBinaryPath).toBe(process.execPath);
    expect(resolution.usesManagedPath).toBe(false);
  });

  it("keeps a selected but damaged managed runtime repairable and removable", () => {
    expect(
      resolveManagedRuntimePolicy({
        source: "scient_managed",
        artifact: reviewedArtifact,
        installed: false,
        installedVersion: "1.0.0",
        managedInstallationAllowed: true,
        systemToManagedSwitchAllowed: true,
      }).actions,
    ).toEqual(["repair", "remove"]);
  });

  it("fails closed outside the local managed-install boundary", () => {
    expect(
      resolveManagedRuntimePolicy({
        source: "system",
        artifact: reviewedArtifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: false,
        systemToManagedSwitchAllowed: true,
      }),
    ).toMatchObject({ actions: [], supportTier: "external_runtime_supported" });
  });
});

describe("managed provider runtime diagnostics", () => {
  it("reports managed versions without inventing a version for external runtimes", () => {
    expect(
      makeManagedProviderRuntimeDiagnostics({
        executable: "/private/claude",
        source: "scient_managed",
        managedVersion: "2.1.241",
        homePath: "/private/claude-home",
        backend: "macOS native",
      }),
    ).toEqual({
      executable: "/private/claude",
      version: "2.1.241",
      homePath: "/private/claude-home",
      backend: "macOS native",
    });
    expect(
      makeManagedProviderRuntimeDiagnostics({
        executable: "/usr/local/bin/claude",
        source: "system",
        managedVersion: null,
        homePath: null,
        backend: "macOS native",
      }).version,
    ).toBeNull();
  });

  it("uses truthful platform-specific backend labels", () => {
    expect(nativeProviderRuntimeBackendLabel("darwin")).toBe("macOS native");
    expect(nativeProviderRuntimeBackendLabel("win32")).toBe("Windows native");
    expect(nativeProviderRuntimeBackendLabel("linux")).toBe("Linux native");
  });
});

describe("managed provider runtime installation failures", () => {
  it("preserves safe download and verification details for recovery", () => {
    expect(
      managedRuntimeInstallationFailureMessage(
        "Claude",
        new ManagedRuntimeFileError("Managed runtime download failed with HTTP 404."),
      ),
    ).toBe(
      "Scient could not install the private Claude runtime. Managed runtime download failed with HTTP 404.",
    );
    expect(
      managedRuntimeInstallationFailureMessage(
        "Claude",
        new ManagedProviderRuntimeError("Managed Claude smoke test failed with code 1."),
      ),
    ).toContain("Managed Claude smoke test failed with code 1.");
  });

  it("does not expose unknown failure details", () => {
    expect(
      managedRuntimeInstallationFailureMessage(
        "Claude",
        new Error("secret-bearing implementation detail"),
      ),
    ).toBe("Scient could not install the private Claude runtime.");
  });
});
