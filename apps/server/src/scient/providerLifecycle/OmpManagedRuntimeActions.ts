// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  MANAGED_RUNTIME_POLICY,
  ManagedOmpRuntime,
  ManagedProviderRuntimeError,
  detectManagedRuntimeTarget,
  managedRuntimeSmokeEnvironment,
  managedRuntimeTargetKey,
  resolveReviewedOmpArtifact,
} from "@scientfactory/provider-runtime";
import type { OmpSettings } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { OMP_RPC_PROTOCOL_V2 } from "effect-omp-rpc/schema";

import {
  configuredRuntimeVersionSucceeds,
  makeManagedProviderRuntimeResolution,
  nativeProviderRuntimeBackendLabel,
  type ConfiguredRuntimeProbe,
  type ManagedProviderRuntimeResolution,
} from "./ManagedProviderRuntimeActions.ts";
import { ProviderConnectionActionError } from "./ProviderConnectionActions.ts";
import {
  canonicalOmpExecutablePath,
  OmpExecutableGate,
  type OmpExecutableActivation,
  type OmpExecutableGateShape,
} from "../../provider/omp/OmpExecutableGate.ts";
import { OMP_ISOLATED_ARGS, makeOmpRpcProcess } from "../../provider/omp/OmpRpcProcess.ts";

const DEFAULT_OMP_BINARY = "omp";

type ManagedOmpRuntimeDependencies = ConstructorParameters<typeof ManagedOmpRuntime>[1];
type ManagedOmpInstallInput = Parameters<ManagedOmpRuntime["install"]>[0];
type ManagedOmpQualification = (input: {
  readonly executablePath: string;
  readonly expectedVersion: string;
  readonly cwd: string;
  /** Lets the qualification process lease its executable during this activation. */
  readonly activations: ReadonlyArray<OmpExecutableActivation>;
}) => Effect.Effect<void, ProviderConnectionActionError>;

const toRuntimeError = (fallback: string) => (cause: unknown) => {
  if (cause instanceof DOMException && cause.name === "AbortError") return cause;
  return new ManagedProviderRuntimeError(cause instanceof Error ? cause.message : fallback, {
    cause,
  });
};

/**
 * The managed runtime with Scient's two OMP-specific guarantees: activation
 * holds the executable gate from after the idle window until the new state is
 * committed, so no OMP process starts against a runtime that is changing; and
 * a staged binary is activated only after it completes the RPC v2 handshake.
 */
class QualifiedManagedOmpRuntime extends ManagedOmpRuntime {
  private readonly root: string;
  private readonly gate: OmpExecutableGateShape;
  private readonly qualification: ManagedOmpQualification;

  constructor(input: {
    readonly baseDir: string;
    readonly gate: OmpExecutableGateShape;
    readonly qualification: ManagedOmpQualification;
    readonly dependencies?: ManagedOmpRuntimeDependencies;
  }) {
    super(input.baseDir, input.dependencies);
    this.root = NodePath.join(input.baseDir, "provider-runtimes", "omp");
    this.gate = input.gate;
    this.qualification = input.qualification;
  }

  /**
   * Hold every listed executable exclusively until `release` runs. New OMP
   * processes wait behind the hold; live conversations fail it.
   */
  private async holdExecutables(executables: ReadonlyArray<string>, signal: AbortSignal) {
    const scope = await Effect.runPromise(Scope.make());
    const release = () => Effect.runPromise(Scope.close(scope, Exit.void));
    try {
      const activations = await Effect.runPromise(
        Effect.forEach(executables, canonicalOmpExecutablePath).pipe(
          Effect.flatMap((identities) =>
            Effect.forEach([...new Set(identities)], (identity) =>
              this.gate.acquireActivation(identity),
            ),
          ),
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(NodeServices.layer),
        ),
        { signal },
      );
      return { activations, release };
    } catch (cause) {
      await release();
      throw toRuntimeError("Scient could not reserve the Oh My Pi runtime.")(cause);
    }
  }

  override async install(input: ManagedOmpInstallInput) {
    let held: Awaited<ReturnType<QualifiedManagedOmpRuntime["holdExecutables"]>> | undefined;
    try {
      return await super.install({
        ...input,
        beforeActivate: async (signal) => {
          // #374's activation window first: it waits for idle turns and stops
          // idle conversations. Then the active copy and the copy being
          // written are held through qualification and the state commit.
          await input.beforeActivate?.(signal);
          const active = await this.status(input.artifact);
          held = await this.holdExecutables(
            [active.launchPath, this.launchPath(input.artifact)],
            signal,
          );
        },
        qualify: async ({ artifact, executablePath, signal }) => {
          signal.throwIfAborted();
          const directory = await NodeFSP.mkdtemp(
            NodePath.join(NodeOS.tmpdir(), "scient-omp-qualification-"),
          );
          try {
            await Effect.runPromise(
              this.qualification({
                executablePath,
                expectedVersion: artifact.version,
                cwd: directory,
                activations: held?.activations ?? [],
              }),
              { signal },
            );
          } catch (cause) {
            throw toRuntimeError("The staged Oh My Pi runtime failed its RPC qualification check.")(
              cause,
            );
          } finally {
            await NodeFSP.rm(directory, { recursive: true, force: true });
          }
        },
      });
    } finally {
      await held?.release();
    }
  }

  override async remove() {
    const state = await this.readState();
    const held = state
      ? await this.holdExecutables(
          [NodePath.resolve(this.root, state.executableRelativePath)],
          new AbortController().signal,
        )
      : undefined;
    try {
      await super.remove();
    } finally {
      await held?.release();
    }
  }
}

/**
 * Oh My Pi's RPC mode exits at startup when it has no model at all, and the
 * isolated home has none of the user's sign-ins. This stub provider gives it
 * one; the check never sends a prompt, so nothing is sent to its unroutable
 * address. Local-server discovery is off so the result does not depend on
 * what else runs on the machine.
 */
const OMP_QUALIFICATION_MODELS = `providers:
  scient-qualification:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    auth: none
    models:
      - id: stub
        name: Scient qualification stub
        input: [text]
        contextWindow: 8192
        maxTokens: 1024
`;
const OMP_QUALIFICATION_CONFIG = `disabledProviders:
  - ollama
  - llama.cpp
  - lm-studio
`;
/** A first launch of the large standalone binary can be slow on a cold machine. */
const OMP_QUALIFICATION_TIMEOUT = "30 seconds";

/**
 * A managed OMP binary is not activated until it completes Scient's RPC v2
 * handshake and answers `get_state`, in an isolated home with no extensions,
 * tools, skills, rules or session.
 */
export const qualifyManagedOmpRuntime = Effect.fn("OmpManagedRuntime.qualify")(function* (input: {
  readonly executablePath: string;
  readonly expectedVersion: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly activations: ReadonlyArray<OmpExecutableActivation>;
}) {
  const identity = yield* canonicalOmpExecutablePath(input.executablePath);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const home = NodePath.join(input.cwd, "qualification-home");
      const agent = NodePath.join(home, "agent");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(agent, { recursive: true, mode: 0o700 });
        await NodeFSP.writeFile(NodePath.join(agent, "models.yml"), OMP_QUALIFICATION_MODELS, {
          mode: 0o600,
        });
        await NodeFSP.writeFile(NodePath.join(agent, "config.yml"), OMP_QUALIFICATION_CONFIG, {
          mode: 0o600,
        });
      });
      const client = yield* makeOmpRpcProcess({
        command: input.executablePath,
        cwd: input.cwd,
        env: {
          ...managedRuntimeSmokeEnvironment(input.environment),
          HOME: home,
          PI_CODING_AGENT_DIR: agent,
        },
        extraArgs: [...OMP_ISOLATED_ARGS],
        executableActivation: input.activations.find(
          (activation) => activation.identity === identity,
        ),
      }).pipe(Effect.timeout(OMP_QUALIFICATION_TIMEOUT));
      const cleanup = client.shutdown.pipe(
        Effect.ignore,
        Effect.andThen(client.close()),
        Effect.uninterruptible,
      );
      yield* Effect.gen(function* () {
        const ready = yield* client.ready;
        // OMP advertises v2 in supportedProtocolVersions while its ready
        // envelope remains on the v1 wire shape.
        if (!ready.supportedProtocolVersions.includes(OMP_RPC_PROTOCOL_V2)) {
          return yield* new ProviderConnectionActionError({
            message: "The staged Oh My Pi runtime did not offer Scient RPC protocol v2.",
          });
        }
        if (client.version !== input.expectedVersion) {
          return yield* new ProviderConnectionActionError({
            message: `The staged Oh My Pi runtime reported ${client.version} instead of ${input.expectedVersion}.`,
          });
        }
        yield* client.getState();
      }).pipe(
        Effect.onExit(() => cleanup),
        Effect.timeout(OMP_QUALIFICATION_TIMEOUT),
      );
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause instanceof ProviderConnectionActionError
        ? cause
        : new ProviderConnectionActionError({
            message: "The staged Oh My Pi runtime failed its RPC qualification check.",
            cause,
          }),
    ),
  );
});

/**
 * The managed OMP runtime with its executable gate and RPC qualification.
 * Also used by the managed-runtime catalog qualification script.
 */
export const makeQualifiedManagedOmpRuntime = Effect.fn("OmpManagedRuntime.makeRuntime")(
  function* (input: {
    readonly baseDir: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly dependencies?: ManagedOmpRuntimeDependencies;
    /** Test seam for the RPC handshake. */
    readonly qualification?: ManagedOmpQualification;
  }) {
    const gate = yield* OmpExecutableGate;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const qualification: ManagedOmpQualification =
      input.qualification ??
      ((qualificationInput) =>
        qualifyManagedOmpRuntime({ ...qualificationInput, environment: input.environment }).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(OmpExecutableGate, gate),
        ));
    return new QualifiedManagedOmpRuntime({
      baseDir: input.baseDir,
      gate,
      qualification,
      ...(input.dependencies ? { dependencies: input.dependencies } : {}),
    });
  },
);

/**
 * The configured-runtime health probe is an OMP process like any other. It
 * leases its executable through the gate, so it cannot run a binary that a
 * managed activation is replacing, and it runs with the filtered OMP process
 * environment only, never extended with the server's own environment.
 */
const probeConfiguredOmpRuntime =
  (gate: OmpExecutableGateShape): ConfiguredRuntimeProbe =>
  (binary, environment, spawner) =>
    Effect.gen(function* () {
      // Resolved once, like makeOmpRpcProcess: the leased identity and the
      // spawned path cannot diverge through a PATH change.
      const resolvedBinary = yield* resolveCommandPath(binary, {
        env: environment,
        bypassCache: true,
      }).pipe(Effect.orElseSucceed(() => binary));
      const identity = yield* canonicalOmpExecutablePath(resolvedBinary);
      yield* gate.acquireProcess(identity, { kind: "one-shot" });
      return yield* configuredRuntimeVersionSucceeds({
        binary: resolvedBinary,
        environment,
        extendEnv: false,
        spawner,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      // Busy behind an activation: not provably healthy right now.
      Effect.orElseSucceed(() => false),
    );

function detectTargetSafely(input: { readonly platform: NodeJS.Platform; readonly arch: string }) {
  try {
    return detectManagedRuntimeTarget(input);
  } catch {
    return undefined;
  }
}

export const makeOmpManagedRuntimeResolution = Effect.fn("OmpManagedRuntime.makeResolution")(
  function* (input: {
    readonly settings: OmpSettings;
    readonly baseDir: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly managedInstallationAllowed: boolean;
  }): Effect.fn.Return<ManagedProviderRuntimeResolution, never, OmpExecutableGate> {
    const platform = yield* HostProcessPlatform;
    const arch = yield* HostProcessArchitecture;
    const target = detectTargetSafely({ platform, arch });
    const artifact = target ? resolveReviewedOmpArtifact(target) : undefined;
    const targetLabel = target ? managedRuntimeTargetKey(target) : `${platform}-${arch}`;
    const gate = yield* OmpExecutableGate;
    return yield* makeManagedProviderRuntimeResolution({
      configuredBinaryPath: input.settings.binaryPath,
      defaultBinary: DEFAULT_OMP_BINARY,
      providerName: "Oh My Pi",
      providerSlug: "omp",
      runtime: yield* makeQualifiedManagedOmpRuntime({
        baseDir: input.baseDir,
        environment: input.environment,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner)),
      bundledArtifact: artifact,
      contractRevision: MANAGED_RUNTIME_POLICY.omp.revision,
      targetLabel,
      environment: input.environment,
      spawner: input.spawner,
      probeConfiguredRuntime: probeConfiguredOmpRuntime(gate),
      managedInstallationAllowed: input.managedInstallationAllowed,
      systemToManagedSwitchAllowed: true,
      sourceLabel: "Official Oh My Pi release",
      managedInstallationLimitation:
        "Scient can use a healthy Oh My Pi runtime here, but managed installation is only enabled in the local desktop app.",
      diagnosticsHomePath: input.environment.HOME?.trim() || null,
      diagnosticsBackend: nativeProviderRuntimeBackendLabel(platform),
    });
  },
);
