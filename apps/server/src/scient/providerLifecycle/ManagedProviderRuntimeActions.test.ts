// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the local process and managed-runtime filesystem boundaries.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { afterEach, describe, expect } from "vite-plus/test";

import {
  ManagedProviderRuntimeError,
  ManagedProviderRuntime,
  ManagedRuntimeFileError,
  resolveReviewedClaudeArtifact,
  type ManagedRuntimeArtifact,
} from "@scientfactory/provider-runtime";
import * as Effect from "effect/Effect";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";
import * as Stream from "effect/Stream";
import { BUNDLED_MANAGED_RUNTIME_CATALOG, ManagedRuntimeCatalog } from "./ManagedRuntimeCatalog.ts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as Sink from "effect/Sink";

import {
  isManagedRuntimeDowngrade,
  makeManagedProviderRuntimeDiagnostics,
  makeManagedProviderRuntimeResolution,
  managedRuntimeInstallationFailureMessage,
  nativeProviderRuntimeBackendLabel,
  parseConfiguredRuntimeVersion,
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
  allowedUrlPathPrefixes: ["/"],
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
        managedSelected: true,
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

  it("offers the switch whatever release the system runtime is, and knows when it is older", () => {
    expect(
      resolveManagedRuntimePolicy({
        source: "system",
        artifact: reviewedArtifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: true,
        systemToManagedSwitchAllowed: true,
      }).actions,
    ).toEqual(["install"]);

    const older = (systemVersion: string | null, artifact = reviewedArtifact) =>
      isManagedRuntimeDowngrade({ artifact, systemVersion });
    expect(older("1.2.0")).toBe(true);
    expect(older("1.0.1")).toBe(true);
    expect(older("1.0.0")).toBe(false);
    expect(older("0.9.0")).toBe(false);
    // A version Scient could not read or compare is not known to be newer.
    expect(older(null)).toBe(false);
    expect(older("nightly")).toBe(false);

    // Cursor releases are dated, not semantic versions.
    const cursor = {
      ...reviewedArtifact,
      provider: "cursor",
      version: "2026.09.02-c22c1a3",
    } as const;
    expect(older("2026.10.01-abcdef1", cursor)).toBe(true);
    expect(older("2026.08.11-e8db854", cursor)).toBe(false);
  });

  it("reads each provider's own version output", () => {
    expect(parseConfiguredRuntimeVersion("claudeAgent", "2.1.286 (Claude Code)\n")).toBe("2.1.286");
    expect(parseConfiguredRuntimeVersion("grok", "grok 1.0.40 (eb1a2256660d) [stable]\n")).toBe(
      "1.0.40",
    );
    expect(parseConfiguredRuntimeVersion("omp", "omp/18.3.1\n")).toBe("18.3.1");
    expect(parseConfiguredRuntimeVersion("droid", "0.230.0\n")).toBe("0.230.0");
    expect(parseConfiguredRuntimeVersion("cursor", "2026.08.11-e8db854\n")).toBe(
      "2026.08.11-e8db854",
    );
    expect(parseConfiguredRuntimeVersion("cursor", "cursor-agent\n")).toBeNull();
    expect(parseConfiguredRuntimeVersion("pi", "development build\n")).toBeNull();
  });

  it.effect("exposes the qualified handoff through the real generic resolution boundary", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-managed-provider-resolution-")),
      );
      temporaryRoots.push(baseDir);
      // The stand-in system runtime is this Node binary: the managed release is newer than it.
      const artifact = { ...reviewedArtifact, version: "999.0.0" };
      const runtime = new ManagedProviderRuntime(
        baseDir,
        {
          providerDirectory: "claude",
          displayName: "Claude",
        },
        {
          download: async ({ destination }) => {
            await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
            await NodeFSP.writeFile(destination, "downloaded", { flag: "wx" });
          },
          verify: async () => undefined,
          materialize: async ({ destination, executablePath }) => {
            await NodeFSP.mkdir(destination, { recursive: true });
            const executable = NodePath.join(destination, executablePath);
            await NodeFSP.writeFile(executable, "managed", { mode: 0o755 });
            return executable;
          },
          smoke: async () => undefined,
        },
      );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const resolve = () =>
        makeManagedProviderRuntimeResolution({
          configuredBinaryPath: process.execPath,
          defaultBinary: process.execPath,
          providerName: "Claude",
          providerSlug: "claude",
          runtime,
          bundledArtifact: artifact,
          contractRevision: 1,
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
      const resolution = yield* resolve();

      expect(resolution.summary).toMatchObject({ source: "system", actions: ["install"] });
      const plan = yield* resolution.actions.plan("install");
      expect(plan).toMatchObject({
        action: "install",
        message: expect.stringContaining("system installation"),
      });
      expect(resolution.effectiveBinaryPath).toBe(process.execPath);
      expect(resolution.usesManagedPath).toBe(false);

      // A window that cannot stop sessions leaves the runtime untouched and
      // keeps its own explanation.
      const blocked = yield* resolution.actions
        .run(
          "install",
          plan.catalogRevision,
          () => Effect.void,
          Effect.fail(
            new ProviderConnectionActionError({ message: "Could not stop idle sessions." }),
          ),
        )
        .pipe(Effect.flip);
      expect(blocked.message).toBe("Could not stop idle sessions.");
      expect(yield* resolution.actions.getSummary).toMatchObject({ source: "system" });

      yield* resolution.actions.run(
        "install",
        plan.catalogRevision,
        () => Effect.void,
        Effect.void,
      );

      expect(yield* resolution.actions.getSummary).toMatchObject({
        source: "scient_managed",
        actions: ["repair", "remove"],
        managedVersion: "999.0.0",
      });
      expect(yield* Effect.promise(() => runtime.status(artifact))).toMatchObject({
        installed: true,
        selected: true,
      });
      const managedResolution = yield* resolve();
      expect(managedResolution.effectiveBinaryPath).toBe(runtime.launchPath(artifact));
      expect(managedResolution.usesManagedPath).toBe(true);

      const removePlan = yield* managedResolution.actions.plan("remove");
      yield* managedResolution.actions.run(
        "remove",
        removePlan.catalogRevision,
        () => Effect.void,
        Effect.void,
      );
      const restoredResolution = yield* resolve();
      expect(restoredResolution.summary).toMatchObject({
        source: "system",
        actions: ["install"],
        managedVersion: null,
      });
      expect(restoredResolution.effectiveBinaryPath).toBe(process.execPath);
      expect(restoredResolution.usesManagedPath).toBe(false);
      yield* Effect.promise(() => NodeFSP.access(process.execPath));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "install and repair refresh the catalog, preserve failed activation, and remove without refresh",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-managed-provider-catalog-")),
        );
        temporaryRoots.push(baseDir);
        let failSmoke = false;
        const bundledArtifact = resolveReviewedClaudeArtifact({
          platform: "darwin",
          arch: "arm64",
        });
        if (!bundledArtifact) throw new Error("Reviewed Claude test policy is missing.");
        const runtime = new ManagedProviderRuntime(
          baseDir,
          { providerDirectory: "claude", displayName: "Claude" },
          {
            download: async ({ destination }) => {
              await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
              await NodeFSP.writeFile(destination, "downloaded", { flag: "wx" });
            },
            verify: async () => undefined,
            materialize: async ({ destination, executablePath }) => {
              await NodeFSP.mkdir(destination, { recursive: true });
              const executable = NodePath.join(destination, executablePath);
              await NodeFSP.writeFile(executable, "managed", { mode: 0o755 });
              return executable;
            },
            smoke: async () => {
              if (failSmoke) throw new Error("simulated failed smoke");
            },
          },
        );
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        let catalog = BUNDLED_MANAGED_RUNTIME_CATALOG;
        let refreshes = 0;
        let available = catalog;
        const catalogService = ManagedRuntimeCatalog.of({
          current: Effect.sync(() => catalog),
          refresh: Effect.sync(() => {
            refreshes++;
            catalog = available;
            return catalog;
          }),
          refreshNow: Effect.sync(() => {
            refreshes++;
            catalog = available;
            return catalog;
          }),
          subscribeChanges: Effect.succeed(Stream.empty),
        });
        const resolution = yield* makeManagedProviderRuntimeResolution({
          configuredBinaryPath: "__scient_missing_claude__",
          defaultBinary: "__scient_missing_claude__",
          providerName: "Claude",
          providerSlug: "claude",
          runtime,
          bundledArtifact,
          contractRevision: 1,
          targetLabel: "darwin-arm64",
          environment: process.env,
          spawner,
          managedInstallationAllowed: true,
          systemToManagedSwitchAllowed: true,
          sourceLabel: "Official Anthropic Claude Code release",
          managedInstallationLimitation: "Managed installation is unavailable here.",
          diagnosticsHomePath: null,
          diagnosticsBackend: "macOS native",
        }).pipe(Effect.provideService(ManagedRuntimeCatalog, catalogService));

        const expectedVersion = BUNDLED_MANAGED_RUNTIME_CATALOG.providers.claudeAgent!.version;
        const plan = yield* resolution.actions.plan("install");
        expect(plan.version).toBe(expectedVersion);
        yield* resolution.actions.run(
          "install",
          plan.catalogRevision,
          () => Effect.void,
          Effect.void,
        );
        expect(yield* Effect.promise(() => runtime.status(bundledArtifact))).toMatchObject({
          installed: true,
          activeVersion: expectedVersion,
        });
        const release = catalog.providers.claudeAgent!;
        const parts = release.version.split(".").map(Number);
        const nextVersion = `${parts[0]}.${parts[1]}.${parts[2]! + 1}`;
        available = {
          ...catalog,
          providers: {
            ...catalog.providers,
            claudeAgent: {
              ...release,
              version: nextVersion,
              artifacts: Object.fromEntries(
                Object.entries(release.artifacts).map(([key, artifact]) => [
                  key,
                  {
                    ...artifact,
                    url: artifact.url.replace(release.version, nextVersion),
                    checksum: { algorithm: "sha256" as const, digest: "b".repeat(64) },
                  },
                ]),
              ),
            },
          },
        };
        const repair = yield* resolution.actions.plan("repair");
        expect(refreshes).toBe(3); // install plan, install run, repair plan
        expect(repair.version).toBe(nextVersion);
        expect(repair.catalogRevision).not.toBe(plan.catalogRevision);
        expect(yield* resolution.actions.getSummary).toMatchObject({
          actions: ["update", "repair", "remove"],
          managedVersion: expectedVersion,
          availableManagedVersion: nextVersion,
        });
        failSmoke = true;
        yield* resolution.actions
          .run("repair", repair.catalogRevision, () => Effect.void, Effect.void)
          .pipe(Effect.flip);
        expect((yield* Effect.promise(() => runtime.status(bundledArtifact))).activeVersion).toBe(
          expectedVersion,
        );
        failSmoke = false;
        yield* resolution.actions.run(
          "repair",
          repair.catalogRevision,
          () => Effect.void,
          Effect.void,
        );
        expect((yield* Effect.promise(() => runtime.status(bundledArtifact))).activeVersion).toBe(
          nextVersion,
        );
        const repeatRepair = yield* resolution.actions.plan("repair");
        expect(repeatRepair.version).toBe(nextVersion);
        const beforeRemove = refreshes;
        const remove = yield* resolution.actions.plan("remove");
        yield* resolution.actions.run(
          "remove",
          remove.catalogRevision,
          () => Effect.void,
          Effect.void,
        );
        expect(refreshes).toBe(beforeRemove);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

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

  it("offers Update only when the reviewed artifact is provably newer", () => {
    const base = {
      source: "scient_managed" as const,
      artifact: reviewedArtifact,
      installed: true,
      managedInstallationAllowed: true,
      systemToManagedSwitchAllowed: true,
    };

    expect(resolveManagedRuntimePolicy({ ...base, installedVersion: "0.9.0" }).actions).toEqual([
      "update",
      "repair",
      "remove",
    ]);
    expect(resolveManagedRuntimePolicy({ ...base, installedVersion: "1.0.0" }).actions).toEqual([
      "repair",
      "remove",
    ]);
    expect(resolveManagedRuntimePolicy({ ...base, installedVersion: "2.0.0" }).actions).toEqual([
      "repair",
      "remove",
    ]);
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

describe("configured runtime health probe", () => {
  it.effect("keeps every other provider's probe on the extended server environment", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-managed-provider-probe-")),
      );
      temporaryRoots.push(baseDir);
      const spawned: Array<ChildProcess.StandardCommand> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        spawned.push(command as ChildProcess.StandardCommand);
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const environment = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/tmp/claude" };
      const resolution = yield* makeManagedProviderRuntimeResolution({
        configuredBinaryPath: "claude-custom",
        defaultBinary: "claude",
        providerName: "Claude",
        providerSlug: "claude",
        runtime: new ManagedProviderRuntime(baseDir, {
          providerDirectory: "claude",
          displayName: "Claude",
        }),
        bundledArtifact: reviewedArtifact,
        contractRevision: 1,
        targetLabel: "darwin-arm64",
        environment,
        spawner,
        managedInstallationAllowed: true,
        systemToManagedSwitchAllowed: true,
        sourceLabel: "Official Anthropic Claude Code release",
        managedInstallationLimitation: "Managed installation is unavailable here.",
        diagnosticsHomePath: null,
        diagnosticsBackend: "macOS native",
      });

      expect(resolution.summary.source).toBe("custom");
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.command).toBe("claude-custom");
      expect(spawned[0]!.args).toEqual(["--version"]);
      expect(spawned[0]!.options).toMatchObject({ env: environment, extendEnv: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
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
