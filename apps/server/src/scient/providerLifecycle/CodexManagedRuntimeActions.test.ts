// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the managed Codex companion-file boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  ManagedCodexRuntime,
  resolveReviewedCodexArtifact,
  type ManagedRuntimeArtifact,
} from "@scientfactory/provider-runtime";
import {
  type CodexCapabilityCheck,
  hasManagedCodexCodeModeHost,
  makeCodexManagedRuntimeResolution,
  resolveCodexCatalogCandidate,
  resolveCodexCodeModeHostPath,
  describeCodexCapabilityFailure,
  isStandInForManagedCodex,
  resolveCodexManagedRuntimePolicy,
  resolveCodexRuntimeHomePath,
  resolveCodexRuntimeSource,
  shouldProbeManagedCodexRuntime,
  shouldSkipConfiguredCodexProbe,
} from "./CodexManagedRuntimeActions.ts";
import {
  BUNDLED_MANAGED_RUNTIME_CATALOG,
  ManagedRuntimeCatalog,
  type ManagedRuntimeCatalogData,
} from "./ManagedRuntimeCatalog.ts";

const artifact = {
  version: "2.0.0",
  supportTier: "fully_assisted",
} as ManagedRuntimeArtifact;

const codexCatalogAt = (version: string): ManagedRuntimeCatalogData => {
  const codex = BUNDLED_MANAGED_RUNTIME_CATALOG.providers.codex;
  if (!codex) throw new Error("Bundled Codex catalog entry is missing.");
  const darwinArm = codex.artifacts["darwin-arm64"];
  if (!darwinArm) throw new Error("Bundled Codex darwin-arm64 artifact is missing.");
  return {
    schemaVersion: 1,
    providers: {
      codex: {
        ...codex,
        version,
        artifacts: {
          ...codex.artifacts,
          "darwin-arm64": {
            ...darwinArm,
            artifactName: `codex-${version}.tar.gz`,
            url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-${version}.tar.gz`,
            checksum: { algorithm: "sha256", digest: "b".repeat(64) },
          },
        },
      },
    },
  };
};

describe("Codex managed runtime policy", () => {
  effectIt.effect("requires a real executable code-mode host beside a managed Codex binary", () =>
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-codex-health-")),
      );
      const binary = NodePath.join(root, "bin/codex");
      const host = NodePath.join(root, "bin/codex-code-mode-host");
      try {
        yield* Effect.tryPromise(() =>
          NodeFSP.mkdir(NodePath.dirname(binary), { recursive: true }),
        );
        yield* Effect.tryPromise(() => NodeFSP.writeFile(binary, "codex", { mode: 0o755 }));
        expect(yield* hasManagedCodexCodeModeHost(binary, "darwin")).toBe(false);

        yield* Effect.tryPromise(() => NodeFSP.writeFile(host, "host", { mode: 0o600 }));
        expect(yield* hasManagedCodexCodeModeHost(binary, "darwin")).toBe(false);

        yield* Effect.tryPromise(() => NodeFSP.chmod(host, 0o755));
        expect(yield* hasManagedCodexCodeModeHost(binary, "darwin")).toBe(true);

        yield* Effect.tryPromise(() => NodeFSP.rm(host));
        yield* Effect.tryPromise(() => NodeFSP.symlink(binary, host));
        expect(yield* hasManagedCodexCodeModeHost(binary, "darwin")).toBe(false);
        expect(resolveCodexCodeModeHostPath("C:\\Codex\\bin\\codex.exe", "win32")).toBe(
          "C:\\Codex\\bin\\codex-code-mode-host.exe",
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
      }
    }),
  );

  it("preserves a configured custom runtime without taking ownership of it", () => {
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: true,
        configuredRuntimeHealthy: false,
        managedInstalled: true,
        managedRuntimeHealthy: true,
      }),
    ).toBe("unknown");
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: true,
        configuredRuntimeHealthy: true,
        managedInstalled: true,
        managedRuntimeHealthy: true,
      }),
    ).toBe("custom");
  });

  it("keeps an installed healthy managed runtime stable when PATH Codex is also healthy", () => {
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: true,
        managedInstalled: true,
        managedRuntimeHealthy: true,
      }),
    ).toBe("scient_managed");
  });

  it("falls back from an unhealthy managed copy only to a capability-proven PATH runtime", () => {
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: true,
        managedInstalled: true,
        managedRuntimeHealthy: false,
      }),
    ).toBe("system");
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: false,
        managedInstalled: true,
        managedRuntimeHealthy: false,
      }),
    ).toBe("scient_managed");
  });

  it("uses a healthy PATH runtime when no private runtime is installed", () => {
    expect(
      resolveCodexRuntimeSource({
        hasCustomRuntime: false,
        configuredRuntimeHealthy: true,
        managedInstalled: false,
        managedRuntimeHealthy: false,
      }),
    ).toBe("system");
  });

  it("probes only runtimes that can participate in selection", () => {
    expect(
      shouldProbeManagedCodexRuntime({
        hasCustomRuntime: false,
        managedInstalled: true,
      }),
    ).toBe(true);
    expect(
      shouldProbeManagedCodexRuntime({
        hasCustomRuntime: true,
        managedInstalled: true,
      }),
    ).toBe(false);
    expect(
      shouldSkipConfiguredCodexProbe({
        hasCustomRuntime: false,
        managedRuntimeHealthy: true,
      }),
    ).toBe(true);
    expect(
      shouldSkipConfiguredCodexProbe({
        hasCustomRuntime: false,
        managedRuntimeHealthy: false,
      }),
    ).toBe(false);
    expect(
      shouldSkipConfiguredCodexProbe({
        hasCustomRuntime: true,
        managedRuntimeHealthy: true,
      }),
    ).toBe(false);
  });

  it("uses the exact effective Codex home for probes and diagnostics", () => {
    expect(
      resolveCodexRuntimeHomePath({
        effectiveHomePath: "  /private/scient/codex-shadow  ",
        configuredHomePath: "/shared/codex-home",
      }),
    ).toBe("/private/scient/codex-shadow");
    expect(
      resolveCodexRuntimeHomePath({
        effectiveHomePath: undefined,
        configuredHomePath: "  /shared/codex-home  ",
      }),
    ).toBe("/shared/codex-home");
  });

  it("offers installation for a reviewed local-desktop target", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "missing",
        artifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: true,
        systemVersion: null,
      }),
    ).toEqual({
      supportTier: "fully_assisted",
      actions: ["install"],
      useManagedPath: true,
    });
  });

  it("offers managed installation beside a healthy system runtime", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "system",
        artifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: true,
        systemVersion: null,
      }),
    ).toEqual({
      supportTier: "fully_assisted",
      actions: ["install"],
      useManagedPath: false,
    });
  });

  it("offers the switch to the managed release whatever release PATH Codex is", () => {
    const actions = (systemVersion: string | null) =>
      resolveCodexManagedRuntimePolicy({
        source: "system",
        artifact: { ...artifact, version: "0.153.4" },
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: true,
        systemVersion,
      }).actions;

    expect(actions("0.159.2")).toEqual(["install"]);
    expect(actions("0.153.4")).toEqual(["install"]);
    expect(actions("0.150.0")).toEqual(["install"]);
    // A version the app-server did not report is not known to be newer.
    expect(actions(null)).toEqual(["install"]);
  });

  it("keeps a broken private copy from replacing a newer PATH Codex that stands in for it", () => {
    // Private 0.150.0 failed its check, PATH 0.159.0 is in use, the candidate is 0.153.0.
    const actions = (systemVersion: string | null) =>
      resolveCodexManagedRuntimePolicy({
        source: "system",
        artifact: { ...artifact, provider: "codex", version: "0.153.0" },
        installed: true,
        installedVersion: "0.150.0",
        managedInstallationAllowed: true,
        systemVersion,
      }).actions;

    expect(actions("0.159.0")).toEqual(["remove"]);
    expect(actions("0.153.0")).toEqual(["update", "repair", "remove"]);
    expect(actions("0.151.0")).toEqual(["update", "repair", "remove"]);
    expect(actions(null)).toEqual(["update", "repair", "remove"]);
  });

  it("offers Repair by the release Repair installs, not by the catalog's", () => {
    // Private 0.170.0 failed its check, PATH 0.160.0 is in use, the catalog offers 0.153.4.
    const policy = (repairVersion: string) =>
      resolveCodexManagedRuntimePolicy({
        source: "system",
        artifact: { ...artifact, provider: "codex", version: "0.153.4" },
        repairArtifact: { ...artifact, provider: "codex", version: repairVersion },
        installed: true,
        installedVersion: "0.170.0",
        managedInstallationAllowed: true,
        systemVersion: "0.160.0",
      }).actions;

    expect(policy("0.170.0")).toEqual(["repair", "remove"]);
    expect(policy("0.153.4")).toEqual(["remove"]);
  });

  it("does not claim managed-update ownership for system or custom runtimes", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "system",
        artifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: true,
        systemVersion: null,
      }).actions,
    ).toEqual(["install"]);
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "custom",
        artifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: true,
        systemVersion: null,
      }).actions,
    ).toEqual([]);
  });

  it("keeps a broken private copy repairable while using healthy PATH Codex", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "system",
        artifact,
        installed: true,
        installedVersion: "2.0.0",
        managedInstallationAllowed: true,
        systemVersion: null,
      }).actions,
    ).toEqual(["repair", "remove"]);
  });

  it("keeps a short reason when the capability check fails", () => {
    expect(describeCodexCapabilityFailure(Cause.fail(new Cause.TimeoutError()))).toBe(
      "it did not answer within 8 seconds",
    );
    expect(describeCodexCapabilityFailure(Cause.fail(new Error("spawn EACCES\nstack trace")))).toBe(
      "it failed to start: spawn EACCES",
    );
    expect(
      describeCodexCapabilityFailure(
        Cause.fail(
          new Error(
            "Failed to spawn Codex App Server process for command: /private/path/bin/codex app-server",
          ),
        ),
      ),
    ).toBe("it failed to start: Failed to spawn Codex App Server process");
  });

  it("offers PATH Codex updates only when no private copy is installed", () => {
    const standIn = {
      source: "system",
      managedVersion: "0.157.0",
      actions: ["repair", "remove"],
    } as const;
    expect(isStandInForManagedCodex(standIn)).toBe(true);
    expect(isStandInForManagedCodex({ ...standIn, managedVersion: null })).toBe(false);
    expect(isStandInForManagedCodex({ ...standIn, source: "scient_managed" })).toBe(false);
    // Without a managed fix (a remote server, no assisted artifact), keep PATH updates.
    expect(isStandInForManagedCodex({ ...standIn, actions: [] })).toBe(false);
  });

  it("keeps a newer managed release reachable while PATH Codex stands in", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "system",
        artifact,
        installed: true,
        installedVersion: "1.0.0",
        managedInstallationAllowed: true,
        systemVersion: null,
      }),
    ).toEqual({
      supportTier: "fully_assisted",
      actions: ["update", "repair", "remove"],
      useManagedPath: false,
    });
  });

  it("does not advertise managed mutation outside the local desktop", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "missing",
        artifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: false,
        systemVersion: null,
      }),
    ).toEqual({
      supportTier: "external_runtime_supported",
      actions: [],
      useManagedPath: false,
    });
  });

  it("preserves an existing managed runtime without taking ownership of external runtimes", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "scient_managed",
        artifact,
        installed: true,
        installedVersion: "2.0.0",
        managedInstallationAllowed: true,
        systemVersion: null,
      }).actions,
    ).toEqual(["repair", "remove"]);
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "custom",
        artifact,
        installed: false,
        installedVersion: null,
        managedInstallationAllowed: true,
        systemVersion: null,
      }).actions,
    ).toEqual([]);
  });

  it("offers a verified update while preserving an older managed runtime", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "scient_managed",
        artifact,
        installed: true,
        installedVersion: "1.0.0",
        managedInstallationAllowed: true,
        systemVersion: null,
      }).actions,
    ).toEqual(["update", "repair", "remove"]);
  });

  it("does not offer a downgrade when the managed runtime is newer than the artifact", () => {
    expect(
      resolveCodexManagedRuntimePolicy({
        source: "scient_managed",
        artifact,
        installed: true,
        installedVersion: "3.0.0",
        managedInstallationAllowed: true,
        systemVersion: null,
      }).actions,
    ).toEqual(["repair", "remove"]);
  });
});

describe("Codex managed runtime release selection", () => {
  const bundled = resolveReviewedCodexArtifact({ platform: "darwin", arch: "arm64" });
  if (!bundled) throw new Error("Reviewed Codex darwin-arm64 artifact is missing.");

  it("selects a strictly newer qualified catalog release", () => {
    const candidate = resolveCodexCatalogCandidate({
      bundledArtifact: bundled,
      catalog: codexCatalogAt("0.150.0"),
    });
    expect(candidate?.version).toBe("0.150.0");
    expect(candidate?.executablePath).toBe(bundled.executablePath);
    expect(candidate?.smokeArgs).toEqual(bundled.smokeArgs);
  });

  it("never accepts a catalog downgrade or same-version repack", () => {
    expect(
      resolveCodexCatalogCandidate({
        bundledArtifact: bundled,
        catalog: codexCatalogAt("0.148.0"),
      }),
    ).toBe(bundled);
    expect(
      resolveCodexCatalogCandidate({
        bundledArtifact: bundled,
        catalog: codexCatalogAt(bundled.version),
      }),
    ).toBe(bundled);
  });
});

describe("Codex managed runtime and a newer PATH Codex", () => {
  const decodeCodexSettings = Schema.decodeSync(CodexSettings);
  const temporaryRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
    );
  });

  const reviewed = resolveReviewedCodexArtifact({ platform: "darwin", arch: "arm64" })!;
  const candidateVersion = BUNDLED_MANAGED_RUNTIME_CATALOG.providers.codex!.version;
  const refusal = (pathVersion: string) =>
    `Scient-managed Codex ${candidateVersion} is older than the Codex ${pathVersion} installed on this computer, so Scient keeps using the system installation.`;
  const olderSwitch = (pathVersion: string) =>
    `Scient-managed Codex ${candidateVersion} is older than your installed Codex ${pathVersion}. Scient will use its own verified copy; your installation stays as it is. Codex accounts in this environment that use the default runtime will use that copy; custom paths remain unchanged.`;
  const planChanged = "The qualified Codex setup plan changed. Review it again before continuing.";

  /**
   * A resolution over a private runtime root, with PATH Codex answering the
   * capability check as `pathCodex.version` and the private copy failing it.
   */
  const fixture = Effect.fn("fixture")(function* (options: {
    readonly pathVersion: string;
    /** Installed private release: the reviewed floor, or the named version. */
    readonly privateCopy: boolean | string;
  }) {
    const baseDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-codex-path-")),
    );
    temporaryRoots.push(baseDir);
    const runtime = new ManagedCodexRuntime(baseDir, {
      download: async ({ destination }) => {
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.writeFile(destination, "codex", { flag: "wx" });
      },
      verify: async () => undefined,
      materialize: async ({ destination, executablePath }) => {
        await NodeFSP.mkdir(destination, { recursive: true });
        const executable = NodePath.join(destination, executablePath);
        await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
        await NodeFSP.writeFile(executable, "codex", { mode: 0o755 });
        return executable;
      },
      smoke: async () => undefined,
    });
    if (options.privateCopy !== false) {
      const installed =
        options.privateCopy === true ? reviewed : { ...reviewed, version: options.privateCopy };
      yield* Effect.promise(() =>
        runtime.install({ artifact: installed, signal: new AbortController().signal }),
      );
    }
    const pathCodex = { version: options.pathVersion, probes: 0 };
    const resolution = yield* makeCodexManagedRuntimeResolution({
      settings: decodeCodexSettings({}),
      baseDir,
      cwd: baseDir,
      environment: { PATH: "/usr/bin", HOME: baseDir },
      spawner: ChildProcessSpawner.make(() => Effect.die("the capability check is a fixture")),
      managedInstallationAllowed: true,
      dependencies: {
        runtime,
        probeRuntime: (binaryPath) =>
          Effect.sync((): CodexCapabilityCheck => {
            if (binaryPath !== "codex") return { healthy: false, reason: "fixture failure" };
            pathCodex.probes += 1;
            return { healthy: true, version: pathCodex.version };
          }),
      },
    });
    return { resolution, pathCodex };
  });
  const onDarwinArm = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
    effect.pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(HostProcessArchitecture, "arm64"),
      Effect.provide(NodeServices.layer),
    );

  effectIt.effect("does not repair or update a broken private copy over a newer PATH Codex", () =>
    onDarwinArm(
      Effect.gen(function* () {
        // The private copy (the reviewed floor) failed its check; PATH Codex is in use.
        const { resolution, pathCodex } = yield* fixture({
          pathVersion: "99.0.0",
          privateCopy: true,
        });
        expect(resolution.summary).toMatchObject({
          source: "system",
          managedVersion: reviewed.version,
          actions: ["remove"],
        });
        for (const action of ["update", "repair"] as const) {
          const refused = yield* resolution.actions.plan(action).pipe(Effect.flip);
          expect(refused.message).toBe(refusal("99.0.0"));
        }

        // An older PATH Codex may be replaced by the qualified release.
        pathCodex.version = "0.0.1";
        const plan = yield* resolution.actions.plan("update");
        expect(plan.version).toBe(candidateVersion);
        expect((yield* resolution.actions.getSummary).actions).toEqual([
          "update",
          "repair",
          "remove",
        ]);
      }),
    ),
  );

  effectIt.effect("repairs a broken private copy whose own release is newer than PATH Codex", () =>
    onDarwinArm(
      Effect.gen(function* () {
        // Private 99.0.0 failed its check, PATH Codex 50.0.0 stands in, and the
        // catalog (after a withdrawal or offline) is older than both. Repair
        // reinstalls the installed release, which replaces nothing newer.
        const { resolution } = yield* fixture({ pathVersion: "50.0.0", privateCopy: "99.0.0" });
        expect(resolution.summary).toMatchObject({
          source: "system",
          managedVersion: "99.0.0",
          actions: ["repair", "remove"],
        });
        const plan = yield* resolution.actions.plan("repair");
        expect(plan).toMatchObject({ action: "repair", version: "99.0.0" });
      }),
    ),
  );

  effectIt.effect("authorizes the release it installs, not a newer one published meanwhile", () =>
    onDarwinArm(
      Effect.gen(function* () {
        // A plan captures the catalog it refreshed (the bundled release); another
        // refresh publishes a newer one before the plan reads the catalog again.
        const published = codexCatalogAt("99.9.0");
        const { resolution, pathCodex } = yield* fixture({
          pathVersion: "0.0.1",
          privateCopy: false,
        }).pipe(
          Effect.provideService(ManagedRuntimeCatalog, {
            current: Effect.succeed(published),
            refresh: Effect.succeed(BUNDLED_MANAGED_RUNTIME_CATALOG),
            refreshNow: Effect.succeed(published),
            subscribeChanges: Effect.succeed(Stream.empty),
          }),
        );
        const reviewedPlan = yield* resolution.actions.plan("install");
        expect(reviewedPlan.version).toBe(candidateVersion);

        // Newer than the reviewed release, older than the one published since:
        // the release that would be installed is the one compared.
        pathCodex.version = "50.0.0";
        const replanned = yield* resolution.actions.plan("install");
        expect(replanned).toMatchObject({
          version: candidateVersion,
          systemVersion: "50.0.0",
          olderThanSystem: true,
          message: olderSwitch("50.0.0"),
        });
        const started = yield* resolution.actions
          .run("install", reviewedPlan.catalogRevision, () => Effect.void, Effect.void)
          .pipe(Effect.flip);
        expect(started.message).toBe(planChanged);
      }),
    ),
  );

  effectIt.effect(
    "offers the switch beside a newer PATH Codex as a decision on both releases",
    () =>
      onDarwinArm(
        Effect.gen(function* () {
          const { resolution } = yield* fixture({ pathVersion: "99.0.0", privateCopy: false });
          expect(resolution.summary).toMatchObject({ source: "system", actions: ["install"] });
          const plan = yield* resolution.actions.plan("install");
          expect(plan).toMatchObject({
            action: "install",
            version: candidateVersion,
            systemVersion: "99.0.0",
            olderThanSystem: true,
            message: olderSwitch("99.0.0"),
          });
        }),
      ),
  );

  effectIt.effect("asks again before a reviewed install once PATH Codex was upgraded", () =>
    onDarwinArm(
      Effect.gen(function* () {
        const { resolution, pathCodex } = yield* fixture({
          pathVersion: "0.0.1",
          privateCopy: false,
        });
        expect(resolution.summary).toMatchObject({ source: "system", actions: ["install"] });
        const reviewedPlan = yield* resolution.actions.plan("install");
        expect(reviewedPlan).toMatchObject({ systemVersion: "0.0.1", olderThanSystem: false });
        expect(reviewedPlan.message).toContain("system installation (0.0.1)");

        pathCodex.version = "99.0.0";
        // The plan reviewed before the upgrade is not carried out as it was.
        const started = yield* resolution.actions
          .run("install", reviewedPlan.catalogRevision, () => Effect.void, Effect.void)
          .pipe(Effect.flip);
        expect(started.message).toBe(planChanged);
        expect(yield* resolution.actions.getSummary).toMatchObject({
          source: "system",
          actions: ["install"],
          managedVersion: null,
        });
        // The switch is still offered, as a new decision that names both releases.
        const replanned = yield* resolution.actions.plan("install");
        expect(replanned).toMatchObject({
          systemVersion: "99.0.0",
          olderThanSystem: true,
          message: olderSwitch("99.0.0"),
        });
        expect(replanned.catalogRevision).not.toBe(reviewedPlan.catalogRevision);
      }),
    ),
  );
});
