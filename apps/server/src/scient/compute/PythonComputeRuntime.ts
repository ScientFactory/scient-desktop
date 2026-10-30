// @effect-diagnostics nodeBuiltinImport:off -- the bridge is a file shipped
// beside this module, so finding it means asking the loader where this module
// is; the probe's working directory is the host's temporary directory.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  ComputeRuntimeError,
  ComputeTransportError,
  REQUIRED_COMPUTE_CAPABILITIES,
  type ComputeLanguageAdapter,
  type ComputeTransport,
} from "@scientfactory/compute";
import { ExecutionRunId, type ExecutionProcessPort } from "@scientfactory/execution";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { OwnedLocalEndpointRegistry } from "../../localEndpoints/OwnedLocalEndpointRegistry.ts";
import { ExecutionProcess } from "../execution/LocalExecutionProcess.ts";
import { DuplexProcess } from "../execution/LocalDuplexProcess.ts";
import { sanitizeComputeEnvironment } from "./ComputeEnvironmentPolicy.ts";
import * as ComputeProjectOutputObserver from "./ComputeProjectOutputObserver.ts";
import {
  DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS,
  layerWithRuntimeBindings,
  type ComputeRuntimeBinding,
} from "./ComputeSessionService.ts";
import { makeComputeBridgeTransport } from "./ComputeBridgeTransport.ts";
import { makeManagedPythonEnvironmentManager } from "./ManagedPythonEnvironment.ts";
import {
  makeManagedPythonProvisioner,
  resolveManagedPythonSpecPath,
} from "./ManagedPythonProvisioner.ts";
import { makeManagedPythonRuntimeController } from "./ManagedPythonRuntimeController.ts";
import { ComputeRecipeNetwork, makeComputeRecipeSource } from "./ComputeRecipeSource.ts";
import {
  PROBE_SCRIPT,
  PYTHON_LANGUAGE_ID,
  makePythonRuntimeAdapter,
  type ProbeResult,
} from "./PythonRuntimeAdapter.ts";
import { makeRuntimeProbeCache } from "./RuntimeProbeCache.ts";
import { PYTHON_TOOLKIT_CATALOG, assessPythonToolkits } from "./PythonToolkitCatalog.ts";

/**
 * Keep installation bridge lookup and real probe execution here; language policy belongs to
 * PythonRuntimeAdapter and protocol behavior to ComputeBridgeTransport.
 */

export const BRIDGE_SCRIPT_NAME = "scient_compute_bridge.py";

/**
 * Where the build stages the bridge next to the bundled server.
 *
 * Named rather than inlined because two places have to agree on it: the build
 * that copies the bridge there and the resolver below that looks for it.
 */
export const STAGED_BRIDGE_DIRECTORY = "scient-compute-bridge";

/** What another language needs from Python to run its Jupyter kernel behind the same bridge. */
export interface KernelBridgeHost {
  readonly bridgePath: string;
  /** Reserves private kernel ports and keeps a managed host generation in use while it runs. */
  readonly transport: (startupTimeoutMs?: number) => ComputeTransport;
  /** A Python that can run the bridge, given the configured Python preference. */
  readonly executable: (
    configuredExecutable: string | null,
  ) => Effect.Effect<string, ComputeRuntimeError>;
  /** Discovers Pythons with Scient-managed Python first, whatever Python's own default is. */
  readonly managedPythonAdapter: ComputeLanguageAdapter;
  readonly managedRuntime?: NonNullable<ComputeRuntimeBinding["managedRuntime"]>;
}

/**
 * Allow cold interpreter/disk startup but bound silence so an arbitrary configured interpreter
 * cannot hold discovery forever.
 */
const PROBE_TIMEOUT = Duration.seconds(20);

/**
 * Wrappers can leave descendants holding stdout after interpreter exit. Bound post-exit drain while
 * preserving buffered bytes, rather than waiting forever for EOF.
 */
const PROBE_DRAIN_GRACE = Duration.seconds(2);

/** A probe emits one small JSON object; anything larger is not a probe result. */
export const MAXIMUM_PROBE_STDOUT_BYTES = 256 * 1024;

const PROBE_ARGS: ReadonlyArray<string> = ["-I", "-c", PROBE_SCRIPT];

function runtimeError(message: string, cause?: unknown): ComputeRuntimeError {
  return new ComputeRuntimeError({
    operation: "discover",
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * The directory this module was loaded from.
 *
 * From source that is this source directory; from the bundle it is the
 * directory holding the one file the server was collapsed into.
 */
export function moduleDirectory(): string {
  return NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
}

/**
 * Try source bridge before staged build output so developers never execute a stale copy left by an
 * earlier build.
 */
export function bridgePathCandidates(directory: string): ReadonlyArray<string> {
  // External interpreters cannot read Electron's virtual ASAR filesystem.
  // Packaging puts both bridge scripts in the archive's physical sibling.
  const physicalDirectory = directory.replace(/\.asar([\\/])/u, ".asar.unpacked$1");
  return [
    NodePath.join(physicalDirectory, "bridge", BRIDGE_SCRIPT_NAME),
    NodePath.join(physicalDirectory, STAGED_BRIDGE_DIRECTORY, BRIDGE_SCRIPT_NAME),
  ];
}

/**
 * Resolve the bridge once at service construction: a missing installation asset cannot be repaired
 * by an individual session and should be reported at startup.
 */
export const resolveBridgePath = Effect.fn("PythonComputeRuntime.resolveBridgePath")(function* (
  directory: string,
): Effect.fn.Return<string, ComputeRuntimeError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const candidates = bridgePathCandidates(directory);
  for (const candidate of candidates) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return yield* runtimeError(
    `Unable to find ${BRIDGE_SCRIPT_NAME}. Looked in: ${candidates.join(", ")}.`,
  );
});

/**
 * Probe with the same sanitized environment and extendEnv false as launch; otherwise readiness
 * could advertise packages the bridge cannot import. Keep process failure interpretation in the
 * adapter.
 */
export const makeSpawnProbe = Effect.fn("PythonComputeRuntime.makeSpawnProbe")(function* (
  processes: ExecutionProcessPort,
  options: {
    readonly environment: Readonly<Record<string, string>>;
    readonly cwd: string;
    readonly timeout?: Duration.Duration;
  },
): Effect.fn.Return<
  (
    executable: string,
    acquireUsage?: Effect.Effect<() => void, ComputeRuntimeError>,
  ) => Effect.Effect<string, ComputeRuntimeError>
> {
  // The port wants an id per run. Nothing reads it here; it only has to tell
  // two probes apart in a trace.
  const runCounter = yield* Ref.make(0);
  const timeout = options.timeout ?? PROBE_TIMEOUT;

  return (executable: string, acquireUsage?: Effect.Effect<() => void, ComputeRuntimeError>) =>
    Effect.gen(function* () {
      const count = yield* Ref.updateAndGet(runCounter, (value) => value + 1);
      const start = processes
        .start({
          runId: ExecutionRunId.make(`scient-compute-probe-${String(count)}`),
          executable,
          args: PROBE_ARGS,
          cwd: options.cwd,
          environment: options.environment,
          extendEnv: false,
        })
        .pipe(Effect.mapError((cause) => runtimeError(`Unable to run ${executable}.`, cause)));
      const handle = yield* acquireUsage === undefined
        ? start
        : Effect.uninterruptible(
            Effect.gen(function* () {
              const release = yield* acquireUsage;
              const handle = yield* start.pipe(Effect.onError(() => Effect.sync(release)));
              // Scope closure is not proof that the process tree stopped. Keep
              // its generation reserved if cleanup fails, even on cancellation.
              yield* Effect.addFinalizer(() =>
                handle.cancel.pipe(
                  Effect.andThen(Effect.sync(release)),
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      "Python probe cleanup failed; its managed environment remains protected",
                      { cause },
                    ),
                  ),
                ),
              );
              return handle;
            }),
          );
      // Drained on its own fiber, so an interpreter that writes more than a
      // pipe holds cannot block on a reader that is waiting for it to exit.
      const stdoutRef = yield* Ref.make("");
      const stdoutBytesRef = yield* Ref.make(0);
      const outputExceeded = yield* Deferred.make<void>();
      const drain = yield* handle.output.pipe(
        Stream.runForEach((chunk) =>
          chunk.stream !== "stdout"
            ? Effect.void
            : Effect.gen(function* () {
                const bytes = Buffer.byteLength(chunk.text, "utf8");
                const total = yield* Ref.updateAndGet(stdoutBytesRef, (current) => current + bytes);
                if (total > MAXIMUM_PROBE_STDOUT_BYTES) {
                  yield* Deferred.succeed(outputExceeded, undefined);
                  return;
                }
                yield* Ref.update(stdoutRef, (text) => text + chunk.text);
              }),
        ),
        Effect.catchCause((cause) =>
          Effect.logDebug("compute probe output ended early", { cause }),
        ),
        Effect.forkScoped,
      );
      const exitCode = yield* Effect.raceFirst(
        handle.exitCode.pipe(
          Effect.mapError((cause) => runtimeError(`Unable to wait for ${executable}.`, cause)),
          Effect.timeoutOption(timeout),
        ),
        Deferred.await(outputExceeded).pipe(Effect.as(Option.none<number>())),
      );
      // A silent interpreter is killed as a tree: the probe is isolated, but
      // nothing stops it from having started something of its own.
      if (Option.isNone(exitCode)) yield* handle.cancel.pipe(Effect.ignoreCause());
      yield* Fiber.join(drain).pipe(Effect.timeoutOption(PROBE_DRAIN_GRACE), Effect.ignoreCause());
      if (Option.isNone(exitCode)) {
        if ((yield* Ref.get(stdoutBytesRef)) > MAXIMUM_PROBE_STDOUT_BYTES) {
          return yield* runtimeError(
            `${executable} exceeded the ${String(MAXIMUM_PROBE_STDOUT_BYTES)}-byte probe output limit.`,
          );
        }
        return yield* runtimeError(
          `${executable} did not answer the probe in ${Duration.format(timeout)}.`,
        );
      }
      if (exitCode.value !== 0) {
        return yield* runtimeError(`${executable} exited with code ${String(exitCode.value)}.`);
      }
      return yield* Ref.get(stdoutRef);
    }).pipe(Effect.scoped);
});

/**
 * The Python binding this server can actually run.
 *
 * Built as an effect because both halves have to be acquired: the bridge is
 * found on disk and the probe needs the process port.
 */
export const pythonRuntimeBinding: Effect.Effect<
  ComputeRuntimeBinding & {
    readonly managedRuntime?: ReturnType<typeof makeManagedPythonRuntimeController>;
    readonly kernelHost: KernelBridgeHost;
  },
  ComputeRuntimeError,
  | DuplexProcess
  | ExecutionProcess
  | FileSystem.FileSystem
  | Scope.Scope
  | ServerConfig
  | OwnedLocalEndpointRegistry
> = Effect.gen(function* () {
  const bridgePath = yield* resolveBridgePath(moduleDirectory());
  const processes = yield* ExecutionProcess;
  const duplexProcesses = yield* DuplexProcess;
  const ownedLocalEndpoints = yield* OwnedLocalEndpointRegistry;
  const config = yield* ServerConfig;
  const hostEnvironment = yield* HostProcess.Environment;
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;
  const recipeNetwork = yield* ComputeRecipeNetwork;
  const { environment } = sanitizeComputeEnvironment(definedEnvironment(hostEnvironment));
  const spawnProbe = yield* makeSpawnProbe(processes, {
    environment,
    // A probe belongs to no project, so it runs somewhere that always exists
    // and holds nothing it could import. `-I` already keeps the working
    // directory off the interpreter's path; this keeps a deleted project
    // directory from failing a probe that has nothing to do with it.
    cwd: NodeOS.tmpdir(),
  });
  const managedSetup = yield* Effect.gen(function* () {
    const managedPythonSpecPath = yield* Effect.tryPromise({
      try: () => resolveManagedPythonSpecPath(moduleDirectory()),
      catch: (cause) => runtimeError("Unable to find the managed Python specification.", cause),
    });
    const provisioner = yield* Effect.try({
      try: () =>
        makeManagedPythonProvisioner({
          computeDir: config.computeDir,
          specDirectory: managedPythonSpecPath,
          processes,
          spawnProbe,
          environment,
          platform: hostPlatform,
          arch: hostArchitecture,
        }),
      catch: (cause) => runtimeError("Scientific Python is unavailable on this platform.", cause),
    });
    const manager = makeManagedPythonEnvironmentManager(config.computeDir, provisioner, "python", {
      trackUsage: true,
    });
    yield* Effect.tryPromise({
      try: () => manager.reconcile(),
      catch: (cause) => runtimeError("Unable to reconcile Scientific Python.", cause),
    });
    return {
      manager,
      managedRuntime: makeManagedPythonRuntimeController({
        recipes: makeComputeRecipeSource({
          computeDir: config.computeDir,
          specDirectory: managedPythonSpecPath,
          purpose: "python",
          target: `${hostPlatform}-${hostArchitecture}`,
          network: recipeNetwork,
        }),
        manager,
        toolkitIds: PYTHON_TOOLKIT_CATALOG.map((toolkit) => toolkit.toolkitId),
        requiredToolkitIds: PYTHON_TOOLKIT_CATALOG.filter((toolkit) => toolkit.required).map(
          (toolkit) => toolkit.toolkitId,
        ),
      }),
    };
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.logWarning(
          "Scient-managed Python is unavailable; existing Python runtimes remain available",
          { cause },
        ).pipe(Effect.as(null)),
      onSuccess: (setup) => Effect.succeed(setup),
    }),
  );
  if (managedSetup !== null) {
    yield* Effect.addFinalizer(() => Effect.sync(() => managedSetup.managedRuntime.dispose()));
  }
  const retain = (executable: string) =>
    Effect.tryPromise({
      try: () =>
        managedSetup === null
          ? Promise.resolve(() => undefined)
          : managedSetup.manager.acquire(executable),
      catch: (cause) =>
        runtimeError("The requested Python environment is unavailable or being removed.", cause),
    });
  const inspectManaged = () =>
    managedSetup === null
      ? Effect.succeed(null)
      : Effect.tryPromise({
          try: () => managedSetup.manager.inspect(),
          catch: (cause) =>
            new ComputeRuntimeError({
              operation: "discover",
              message: "Unable to inspect Scientific Python.",
              cause,
            }),
        });
  const probeCache = makeRuntimeProbeCache<ProbeResult>();
  const makeAdapter = (preferManaged: boolean) =>
    makePythonRuntimeAdapter(
      (executable) => spawnProbe(executable, retain(executable)),
      bridgePath,
      managedSetup === null
        ? { probeCache }
        : {
            probeCache,
            managedRuntime: () =>
              inspectManaged().pipe(
                Effect.map((status) =>
                  status === null
                    ? null
                    : {
                        executable: status.executable,
                        selected: preferManaged || status.record.selection === "managed",
                        available: status.available,
                        version: status.record.active.pythonVersion,
                      },
                ),
              ),
          },
    );
  const adapter = makeAdapter(false);
  const managedPythonAdapter = makeAdapter(true);
  const bridgeTransport = (startupTimeoutMs?: number) =>
    makeComputeBridgeTransport(duplexProcesses, {
      ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
      prepareKernelEndpoints: (request) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const releaseUsage = yield* retain(request.launch.executable).pipe(
              Effect.mapError(
                (cause) =>
                  new ComputeTransportError({
                    operation: "open",
                    message: cause.message,
                    cause,
                  }),
              ),
            );
            return yield* ownedLocalEndpoints
              .reserveProtectedLoopbackTcpPorts({
                owner: `compute/${request.sessionId}`,
                purpose: "jupyter-kernel-channels",
                count: 5,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ComputeTransportError({
                      operation: "open",
                      message: "Unable to reserve private kernel endpoints.",
                      cause,
                    }),
                ),
                Effect.flatMap((lease) => {
                  const [shell, iopub, stdin, heartbeat, control] = lease.ports;
                  if (
                    shell === undefined ||
                    iopub === undefined ||
                    stdin === undefined ||
                    heartbeat === undefined ||
                    control === undefined
                  ) {
                    return lease.release.pipe(
                      Effect.andThen(
                        Effect.fail(
                          new ComputeTransportError({
                            operation: "open",
                            message: "The private kernel endpoint reservation was incomplete.",
                          }),
                        ),
                      ),
                    );
                  }
                  return Effect.succeed({
                    ports: { ip: "127.0.0.1" as const, shell, iopub, stdin, heartbeat, control },
                    handoff: lease.handoff.pipe(
                      Effect.mapError(
                        (cause) =>
                          new ComputeTransportError({
                            operation: "handshake",
                            message: "Unable to hand private endpoints to the Python kernel.",
                            cause,
                          }),
                      ),
                    ),
                    // The transport releases this composite lease only after the
                    // process tree is confirmed stopped (or never started).
                    release: lease.release.pipe(Effect.andThen(Effect.sync(releaseUsage))),
                  });
                }),
                Effect.onError(() => Effect.sync(releaseUsage)),
              );
          }),
        ),
    });
  // Any ready Python can host the bridge for another language's kernel; prefer the managed one.
  const hostExecutable = Effect.fn("PythonComputeRuntime.kernelHostExecutable")(function* (
    configuredExecutable: string | null,
  ) {
    const managed = yield* inspectManaged();
    if (managed?.available === true) return managed.executable;
    const profiles = yield* adapter.discover({ projectRoot: null, configuredExecutable });
    for (const profile of profiles) {
      const verification = yield* adapter.verify({
        profile,
        cwd: NodeOS.tmpdir(),
        environment,
      });
      if (verification.readiness === "ready") return profile.executable;
    }
    return yield* new ComputeRuntimeError({
      operation: "prepare",
      message: "Set up Scientific Python, or choose a Python with jupyter_client and ipykernel.",
    });
  });
  const managedRuntime =
    managedSetup === null ? undefined : { ...managedSetup.managedRuntime, tracksUsage: true };
  return {
    adapter,
    transport: bridgeTransport(),
    kernelHost: {
      bridgePath,
      transport: bridgeTransport,
      executable: hostExecutable,
      managedPythonAdapter,
      ...(managedRuntime === undefined ? {} : { managedRuntime }),
    },
    descriptor: {
      languageId: PYTHON_LANGUAGE_ID,
      displayName: "Python",
      sourceExtensions: [".py"],
      capabilities: [...REQUIRED_COMPUTE_CAPABILITIES, "variables", "tables"],
    },
    toolkitSupport: {
      descriptors: PYTHON_TOOLKIT_CATALOG,
      assess: assessPythonToolkits,
    },
    ...(managedRuntime === undefined ? {} : { managedRuntime }),
  };
});

/**
 * Default to no idle timeout so reading output cannot silently destroy a user's namespace. Missing
 * bridge assets disable Python rather than the whole editor; release qualification must catch the
 * packaging defect.
 */
export const layer = layerWithRuntimeBindings(
  pythonRuntimeBinding.pipe(
    Effect.map((binding) => [binding]),
    Effect.catch((cause) =>
      Effect.as(
        Effect.logWarning("compute is unavailable: no Python runtime could be prepared", {
          reason: cause.message,
        }),
        [],
      ),
    ),
  ),
  DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS,
  ComputeProjectOutputObserver.liveLayer,
);
