// @effect-diagnostics nodeBuiltinImport:off -- The test places a stand-in executable on a private PATH.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ManagedCursorRuntime,
  resolveReviewedCursorArtifact,
  type ManagedRuntimeCatalogProvider,
} from "@scientfactory/provider-runtime";
import {
  AntigravitySettings,
  ClaudeSettings,
  DroidSettings,
  OmpSettings,
} from "@t3tools/contracts";
import { CursorSettings } from "@t3tools/provider-cursor/settings";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import { PiSettings } from "@t3tools/provider-pi/settings";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterEach, describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeOmpExecutableGate, OmpExecutableGate } from "../../provider/omp/OmpExecutableGate.ts";
import {
  BUNDLED_MANAGED_RUNTIME_CATALOG,
  ManagedRuntimeCatalog,
  type ManagedRuntimeCatalogData,
} from "./ManagedRuntimeCatalog.ts";
import { makeAntigravityManagedRuntimeResolution } from "./AntigravityManagedRuntimeActions.ts";
import { makeClaudeManagedRuntimeResolution } from "./ClaudeManagedRuntimeActions.ts";
import { makeCursorManagedRuntimeResolution } from "./CursorManagedRuntimeActions.ts";
import { makeDroidManagedRuntimeResolution } from "./DroidManagedRuntimeActions.ts";
import { makeGrokManagedRuntimeResolution } from "./GrokManagedRuntimeActions.ts";
import type { ManagedProviderRuntimeResolution } from "./ManagedProviderRuntimeActions.ts";
import { makeOmpManagedRuntimeResolution } from "./OmpManagedRuntimeActions.ts";
import { makePiManagedRuntimeResolution } from "./PiManagedRuntimeActions.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const decodePiSettings = Schema.decodeSync(PiSettings);
const decodeDroidSettings = Schema.decodeSync(DroidSettings);
const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const target = { platform: "darwin", arch: "arm64" } as const;

interface ResolutionInput {
  readonly baseDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly managedInstallationAllowed: boolean;
}

interface ProviderCase {
  readonly name: string;
  readonly runtimeName?: string;
  readonly binary: string;
  readonly catalog: ManagedRuntimeCatalogProvider;
  /** What the provider's own CLI prints for `--version`. */
  readonly versionOutput: (version: string) => string;
  readonly resolve: (input: ResolutionInput) => Effect.Effect<ManagedProviderRuntimeResolution>;
}

const semver = { newer: "99.0.0", older: "0.0.1" };

/** Every provider that offers "Use Scient-managed" through the shared resolution. */
const providers: ReadonlyArray<ProviderCase> = [
  {
    name: "Claude",
    binary: "claude",
    catalog: "claudeAgent",
    versionOutput: (version) => `${version} (Claude Code)\n`,
    resolve: (input) =>
      makeClaudeManagedRuntimeResolution({
        ...input,
        settings: decodeClaudeSettings({}),
      }),
  },
  {
    name: "Pi",
    binary: "pi",
    catalog: "pi",
    versionOutput: (version) => `${version}\n`,
    resolve: (input) =>
      makePiManagedRuntimeResolution({ ...input, settings: decodePiSettings({}) }),
  },
  {
    name: "Droid",
    binary: "droid",
    catalog: "droid",
    versionOutput: (version) => `${version}\n`,
    resolve: (input) =>
      makeDroidManagedRuntimeResolution({
        ...input,
        settings: decodeDroidSettings({}),
      }),
  },
  {
    name: "Grok",
    binary: "grok",
    catalog: "grok",
    versionOutput: (version) => `grok ${version} (eb1a2256660d) [stable]\n`,
    resolve: (input) =>
      makeGrokManagedRuntimeResolution({ ...input, settings: decodeGrokSettings({}) }),
  },
  {
    name: "Oh My Pi",
    binary: "omp",
    catalog: "omp",
    versionOutput: (version) => `omp/${version}\n`,
    resolve: (input) =>
      Effect.gen(function* () {
        const gate = yield* makeOmpExecutableGate({ processWaitTimeout: "50 millis" });
        return yield* makeOmpManagedRuntimeResolution({
          ...input,
          settings: decodeOmpSettings({}),
        }).pipe(Effect.provideService(OmpExecutableGate, gate));
      }),
  },
  {
    name: "Cursor",
    runtimeName: "Cursor CLI",
    binary: "cursor-agent",
    catalog: "cursor",
    versionOutput: (version) => `${version}\n`,
    resolve: (input) =>
      makeCursorManagedRuntimeResolution({
        ...input,
        enabled: true,
        settings: decodeCursorSettings({}),
      }),
  },
  {
    name: "Antigravity",
    binary: "agy",
    catalog: "antigravity",
    versionOutput: (version) => `${version}\n`,
    resolve: (input) =>
      makeAntigravityManagedRuntimeResolution({
        ...input,
        // The system `agy` path; empty selects Scient's ACP runtime instead.
        settings: decodeAntigravitySettings({ binaryPath: "agy" }),
      }),
  },
];

/**
 * A system installation on a private PATH whose `--version` prints `output`.
 * `system.replace` stands for an upgrade made outside Scient.
 */
const systemRuntime = Effect.fn("systemRuntime")(function* (binary: string, output: string) {
  const baseDir = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-system-switch-")),
  );
  temporaryRoots.push(baseDir);
  const bin = NodePath.join(baseDir, "bin");
  yield* Effect.promise(() => NodeFSP.mkdir(bin, { recursive: true }));
  yield* Effect.promise(() =>
    NodeFSP.writeFile(NodePath.join(bin, binary), "#!/bin/sh\n", { mode: 0o755 }),
  );
  let current = output;
  let present = true;
  let probes = 0;
  const spawner = ChildProcessSpawner.make(() =>
    Effect.sync(() => {
      probes += 1;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(present ? 0 : 1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(current)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return {
    input: {
      baseDir: NodePath.join(baseDir, "managed"),
      environment: { PATH: bin, HOME: baseDir },
      spawner,
      managedInstallationAllowed: true,
    } satisfies ResolutionInput,
    system: {
      replace: (next: string) => {
        current = next;
        present = true;
      },
      /** No system installation (yet): `--version` fails. */
      remove: () => {
        present = false;
      },
      probes: () => probes,
    },
  };
});

/** A release of the provider's own version scheme that is newer or older than `version`. */
const relative = (provider: ProviderCase, direction: "newer" | "older") =>
  provider.name === "Cursor"
    ? direction === "newer"
      ? "2099.01.01-abcdef1"
      : "2020.01.01-abcdef1"
    : semver[direction];

const managedVersion = (provider: ProviderCase) =>
  BUNDLED_MANAGED_RUNTIME_CATALOG.providers[provider.catalog]!.version;

const runtimeName = (provider: ProviderCase) => provider.runtimeName ?? provider.name;

/** What the user decides on before switching to an older managed release. */
const olderSwitch = (provider: ProviderCase, systemVersion: string) =>
  `Scient-managed ${runtimeName(provider)} ${managedVersion(provider)} is older than your installed ${runtimeName(provider)} ${systemVersion}. Scient will use its own verified copy; your installation stays as it is. ${runtimeName(provider)} accounts in this environment that use the default runtime will use that copy; custom paths remain unchanged.`;

/** What the user decides on when Scient does not know the system runtime's release. */
const unknownSwitch = (provider: ProviderCase) =>
  `Scient does not know which ${runtimeName(provider)} version, if any, is installed on this computer (system version unknown), so Scient-managed ${runtimeName(provider)} ${managedVersion(provider)} may be older than it. Scient will use its own verified copy; an existing installation stays as it is. ${runtimeName(provider)} accounts in this environment that use the default runtime will use that copy; custom paths remain unchanged.`;

const planChanged = (provider: ProviderCase) =>
  `The qualified ${runtimeName(provider)} setup plan changed. Review it again before continuing.`;

const onDarwinArm = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  effect.pipe(
    Effect.provideService(HostProcessPlatform, target.platform),
    Effect.provideService(HostProcessArchitecture, target.arch),
    Effect.provide(NodeServices.layer),
  );

describe("switching from a system runtime to the Scient-managed one", () => {
  it.effect.each(providers)(
    "asks again before $name's reviewed switch once the system runtime was upgraded outside Scient",
    (provider) =>
      onDarwinArm(
        Effect.gen(function* () {
          const older = relative(provider, "older");
          const newer = relative(provider, "newer");
          const { input, system } = yield* systemRuntime(
            provider.binary,
            provider.versionOutput(older),
          );
          const resolution = yield* provider.resolve(input);
          expect(resolution.summary).toMatchObject({ source: "system", actions: ["install"] });
          const reviewed = yield* resolution.actions.plan("install");
          expect(reviewed).toMatchObject({ systemVersion: older, olderThanSystem: false });

          // The user upgrades the system tool; this instance is not rebuilt.
          system.replace(provider.versionOutput(newer));

          // The plan reviewed before the upgrade is not carried out as it was.
          const started = yield* resolution.actions
            .run("install", reviewed.catalogRevision, () => Effect.void, Effect.void)
            .pipe(Effect.flip);
          expect(started.message).toBe(planChanged(provider));
          expect(yield* resolution.actions.getSummary).toMatchObject({
            source: "system",
            actions: ["install"],
            managedVersion: null,
          });
          // The switch is still offered, as a new decision that names both releases.
          const replanned = yield* resolution.actions.plan("install");
          expect(replanned).toMatchObject({
            version: managedVersion(provider),
            systemVersion: newer,
            olderThanSystem: true,
            message: olderSwitch(provider, newer),
          });
          expect(replanned.catalogRevision).not.toBe(reviewed.catalogRevision);

          // And the other way: a decision made about an older release is not
          // carried out once the release is no longer older.
          system.replace(provider.versionOutput(older));
          const restarted = yield* resolution.actions
            .run("install", replanned.catalogRevision, () => Effect.void, Effect.void)
            .pipe(Effect.flip);
          expect(restarted.message).toBe(planChanged(provider));
          expect((yield* resolution.actions.plan("install")).catalogRevision).toBe(
            reviewed.catalogRevision,
          );
        }),
      ),
  );

  it.effect("authorizes the release it installs, not a newer one published meanwhile", () =>
    onDarwinArm(
      Effect.gen(function* () {
        const droidCase = providers.find((provider) => provider.name === "Droid")!;
        const captured = BUNDLED_MANAGED_RUNTIME_CATALOG;
        const published: ManagedRuntimeCatalogData = {
          ...captured,
          providers: {
            ...captured.providers,
            droid: { ...captured.providers.droid!, version: "99.9.0" },
          },
        };
        const { input, system } = yield* systemRuntime("droid", droidCase.versionOutput("0.0.1"));
        // A plan captures the catalog it refreshed; another refresh publishes a
        // newer release before the same plan reads the catalog for its summary.
        const resolution = yield* droidCase.resolve(input).pipe(
          Effect.provideService(ManagedRuntimeCatalog, {
            current: Effect.succeed(published),
            refresh: Effect.succeed(captured),
            refreshNow: Effect.succeed(published),
            subscribeChanges: Effect.succeed(Stream.empty),
          }),
        );
        const reviewed = yield* resolution.actions.plan("install");
        expect(reviewed.version).toBe(managedVersion(droidCase));

        // Newer than the reviewed release, older than the one published since:
        // the release that would be installed is the one compared.
        system.replace(droidCase.versionOutput("50.0.0"));
        const replanned = yield* resolution.actions.plan("install");
        expect(replanned).toMatchObject({
          version: managedVersion(droidCase),
          systemVersion: "50.0.0",
          olderThanSystem: true,
          message: olderSwitch(droidCase, "50.0.0"),
        });
        const started = yield* resolution.actions
          .run("install", reviewed.catalogRevision, () => Effect.void, Effect.void)
          .pipe(Effect.flip);
        expect(started.message).toBe(planChanged(droidCase));
      }),
    ),
  );

  describe("a private Cursor copy that is not the explicitly selected runtime", () => {
    const cursor = providers.find((provider) => provider.name === "Cursor")!;
    const reviewedCursor = resolveReviewedCursorArtifact(target)!;

    /** Installs the reviewed (older) release; `legacy` leaves it without an explicit selection. */
    const privateCopy = Effect.fn("privateCopy")(function* (baseDir: string, legacy: boolean) {
      const runtime = new ManagedCursorRuntime(baseDir, {
        download: async ({ destination }) => {
          await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          await NodeFSP.writeFile(destination, "archive", { flag: "wx" });
        },
        verify: async () => undefined,
        materialize: async ({ destination, executablePath }) => {
          const executable = NodePath.join(destination, executablePath);
          await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
          await NodeFSP.writeFile(executable, "launcher", { mode: 0o755 });
          return executable;
        },
        smoke: async () => undefined,
      });
      yield* Effect.promise(() =>
        runtime.install({ artifact: reviewedCursor, signal: new AbortController().signal }),
      );
      if (!legacy) return;
      // Schema-v1 state from before selection was recorded.
      const state = (yield* Effect.promise(() => runtime.readState()))!;
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(baseDir, "provider-runtimes", "cursor", "state.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            targetKey: state.targetKey,
            activeVersion: state.activeVersion,
            previousVersion: state.previousVersion,
            executableRelativePath: state.executableRelativePath,
          })}\n`,
        ),
      );
    });

    /** An enabled instance built while no system Cursor was installed: the legacy copy is its runtime. */
    const builtWithoutSystemCursor = Effect.fn("builtWithoutSystemCursor")(function* () {
      const { input, system } = yield* systemRuntime(cursor.binary, cursor.versionOutput("unused"));
      system.remove();
      yield* privateCopy(input.baseDir, true);
      const resolution = yield* cursor.resolve(input);
      expect(resolution.summary).toMatchObject({
        source: "scient_managed",
        managedVersion: reviewedCursor.version,
        actions: ["update", "repair", "remove"],
      });
      return { resolution, system };
    });

    it.effect(
      "is repaired or updated over a system Cursor installed since only as a decision",
      () =>
        onDarwinArm(
          Effect.gen(function* () {
            const newer = relative(cursor, "newer");
            const older = relative(cursor, "older");
            const { resolution, system } = yield* builtWithoutSystemCursor();

            // Repair and Update would put the copy in use in place of the system Cursor:
            // the same decision as "Use Scient-managed", with both releases.
            system.replace(cursor.versionOutput(newer));
            for (const action of ["repair", "update"] as const) {
              const plan = yield* resolution.actions.plan(action);
              expect(plan).toMatchObject({
                action,
                version: managedVersion(cursor),
                systemVersion: newer,
                olderThanSystem: true,
                message: olderSwitch(cursor, newer),
              });
              expect(plan.catalogRevision).toMatch(/:older-than-system$/u);
            }
            expect(yield* resolution.actions.getSummary).toMatchObject({
              source: "system",
              actions: ["install"],
            });

            system.replace(cursor.versionOutput(older));
            for (const action of ["repair", "update"] as const) {
              const plan = yield* resolution.actions.plan(action);
              expect(plan).toMatchObject({ action, systemVersion: older, olderThanSystem: false });
              expect(plan.message).toContain(`system installation (${older})`);
            }
          }),
        ),
    );

    it.effect("is repaired or updated without a decision while no system Cursor exists", () =>
      onDarwinArm(
        Effect.gen(function* () {
          const { resolution } = yield* builtWithoutSystemCursor();
          // The copy is the only Cursor there is: maintaining it replaces nothing.
          for (const action of ["repair", "update"] as const) {
            const plan = yield* resolution.actions.plan(action);
            expect(plan).toMatchObject({ action, version: managedVersion(cursor) });
            expect(plan).not.toHaveProperty("systemVersion");
            expect(plan).not.toHaveProperty("olderThanSystem");
          }
        }),
      ),
    );

    it.effect("is not put in use on a disabled instance without the unknown-version decision", () =>
      onDarwinArm(
        Effect.gen(function* () {
          const { input, system } = yield* systemRuntime(
            cursor.binary,
            cursor.versionOutput(relative(cursor, "newer")),
          );
          yield* privateCopy(input.baseDir, true);
          const resolution = yield* makeCursorManagedRuntimeResolution({
            ...input,
            enabled: false,
            settings: decodeCursorSettings({}),
          });
          expect(resolution.summary.actions).toEqual(["update", "repair", "remove"]);
          for (const action of ["repair", "update"] as const) {
            const plan = yield* resolution.actions.plan(action);
            // There may be a system Cursor, newer or not: the manager starts this
            // only once it was accepted (see ProviderRuntimeManager.test.ts).
            expect(plan).toMatchObject({
              action,
              version: managedVersion(cursor),
              systemVersion: null,
              olderThanSystem: false,
              message: unknownSwitch(cursor),
            });
            expect(plan.catalogRevision).toMatch(/:system-version-unknown$/u);
          }
          // A disabled provider's tool is never run, not even for `--version`.
          expect(system.probes()).toBe(0);
        }),
      ),
    );

    it.effect(
      "still updates the explicitly selected private copy beside a newer system Cursor",
      () =>
        onDarwinArm(
          Effect.gen(function* () {
            const { input, system } = yield* systemRuntime(
              cursor.binary,
              cursor.versionOutput(relative(cursor, "newer")),
            );
            yield* privateCopy(input.baseDir, false);
            const resolution = yield* cursor.resolve(input);
            expect(resolution.summary).toMatchObject({
              source: "scient_managed",
              actions: ["update", "repair", "remove"],
            });
            const probes = system.probes();

            // The user chose the private copy; the system Cursor is not in use.
            const plan = yield* resolution.actions.plan("update");
            expect(plan.version).toBe(managedVersion(cursor));
            expect((yield* resolution.actions.plan("repair")).version).toBe(managedVersion(cursor));
            expect(system.probes()).toBe(probes);
          }),
        ),
    );
  });

  it.effect(
    "asks before installing for a disabled Cursor, whose system runtime it does not run",
    () =>
      onDarwinArm(
        Effect.gen(function* () {
          const cursor = providers.find((provider) => provider.name === "Cursor")!;
          const { input, system } = yield* systemRuntime(
            cursor.binary,
            cursor.versionOutput(relative(cursor, "newer")),
          );
          const resolution = yield* makeCursorManagedRuntimeResolution({
            ...input,
            enabled: false,
            settings: decodeCursorSettings({}),
          });
          expect(resolution.summary.actions).toEqual(["install"]);

          // There may be a system Cursor, newer or not: the plan says it does not know.
          const decision = yield* resolution.actions.plan("install");
          expect(decision).toMatchObject({
            version: managedVersion(cursor),
            systemVersion: null,
            olderThanSystem: false,
            message: unknownSwitch(cursor),
          });
          // A disabled provider's tool is never run, not even for `--version`.
          expect(system.probes()).toBe(0);
        }),
      ),
  );

  it.effect.each(providers)(
    "offers $name the switch beside a newer system runtime, as a decision that names both releases",
    (provider) =>
      Effect.gen(function* () {
        const newer = relative(provider, "newer");
        const { input } = yield* systemRuntime(provider.binary, provider.versionOutput(newer));
        const resolution = yield* provider.resolve(input);

        expect(resolution.summary).toMatchObject({ source: "system", actions: ["install"] });
        const plan = yield* resolution.actions.plan("install");
        expect(plan).toMatchObject({
          action: "install",
          version: managedVersion(provider),
          systemVersion: newer,
          olderThanSystem: true,
          message: olderSwitch(provider, newer),
        });
      }).pipe(
        Effect.provideService(HostProcessPlatform, target.platform),
        Effect.provideService(HostProcessArchitecture, target.arch),
        Effect.provide(NodeServices.layer),
      ),
  );

  it.effect.each(providers)(
    "names both versions before $name switches from an older system runtime",
    (provider) =>
      Effect.gen(function* () {
        const older = relative(provider, "older");
        const { input } = yield* systemRuntime(provider.binary, provider.versionOutput(older));
        const resolution = yield* provider.resolve(input);

        expect(resolution.summary).toMatchObject({ source: "system", actions: ["install"] });
        const plan = yield* resolution.actions.plan("install");
        const managed = BUNDLED_MANAGED_RUNTIME_CATALOG.providers[provider.catalog]!.version;
        expect(plan).toMatchObject({
          version: managed,
          systemVersion: older,
          olderThanSystem: false,
        });
        expect(plan.message).toContain(`${runtimeName(provider)} ${managed}`);
        expect(plan.message).toContain(`system installation (${older})`);
      }).pipe(
        Effect.provideService(HostProcessPlatform, target.platform),
        Effect.provideService(HostProcessArchitecture, target.arch),
        Effect.provide(NodeServices.layer),
      ),
  );

  it.effect("says the system version is unknown when the system runtime does not report one", () =>
    Effect.gen(function* () {
      const { input } = yield* systemRuntime("droid", "droid development build\n");
      const resolution = yield* makeDroidManagedRuntimeResolution({
        ...input,
        settings: decodeDroidSettings({}),
      });

      expect(resolution.summary).toMatchObject({ source: "system", actions: ["install"] });
      const droid = providers.find((provider) => provider.name === "Droid")!;
      const plan = yield* resolution.actions.plan("install");
      // Neither older nor newer is claimed; the plan is its own decision.
      expect(plan).toMatchObject({
        systemVersion: null,
        olderThanSystem: false,
        message: unknownSwitch(droid),
      });
      expect(plan.catalogRevision).toMatch(/:system-version-unknown$/u);
    }).pipe(
      Effect.provideService(HostProcessPlatform, target.platform),
      Effect.provideService(HostProcessArchitecture, target.arch),
      Effect.provide(NodeServices.layer),
    ),
  );
});
