// @effect-diagnostics nodeBuiltinImport:off -- private kernel locations are hashed host paths.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ComputeOperationError,
  ComputeRuntimeError,
  REQUIRED_COMPUTE_CAPABILITIES,
  type ComputeCapability,
  type ComputeLanguageAdapter,
  type ComputeLanguageId,
  type ComputeManagedRuntimeAction,
  type ComputeManagedRuntimeFailure,
  type ComputeManagedRuntimeStatus,
  type ComputeRuntimeInstallation,
  type ComputeRuntimeProfile,
  type ComputeRuntimeSource,
} from "@scientfactory/compute";
import type { ExecutionProcessPort } from "@scientfactory/execution";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { sanitizeComputeEnvironment } from "./ComputeEnvironmentPolicy.ts";
import type { ComputeRuntimeBinding } from "./ComputeSessionService.ts";
import { kernelPrograms, privateKernelDirectory } from "./KernelSpecs.ts";
import { runOwnedProcess } from "./ManagedPythonProvisioner.ts";
import type { KernelBridgeHost } from "./PythonComputeRuntime.ts";
import { normalizeDiagnosticText } from "./PythonDiagnostic.ts";
import { JUPYTER_BRIDGE_TRANSPORT_KIND, buildLaunchPlan } from "./PythonRuntimeAdapter.ts";
import {
  condaPrefixes,
  discoveryContext,
  originFromPath,
  pathMatches,
  pathModule,
  versionedEntries,
  type DiscoveryContext,
} from "./RuntimeDiscovery.ts";
import { makeRuntimeProbeCache } from "./RuntimeProbeCache.ts";

/** A directory whose newest `prefix*` entry holds the executable at `relative`. */
export interface KernelVersionedPath {
  readonly directory: string;
  readonly prefix: string;
  readonly relative: string;
}

/** What one run of a language's probe reports about an installation. */
export interface KernelInstallationProbe {
  readonly version: string;
  readonly architecture: string | null;
  readonly home: string;
  /** The kernel package the installation already has for the user, if any. */
  readonly ownKernelVersion: string | null;
}

/** What an installation's files say, without starting it. */
export interface KernelInstallationFacts {
  readonly version: string | null;
  readonly architecture: string | null;
  readonly ownKernelVersion: string | null;
}

export interface KernelLaunch {
  readonly argv: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
  /** Otherwise the language's own. */
  readonly interruptMode?: "signal" | "message";
  readonly interruptedReplyIsOk?: boolean;
}

/** A language whose Jupyter kernel is a package installed into the user's own runtime. */
export interface KernelLanguage {
  readonly languageId: ComputeLanguageId;
  readonly displayName: string;
  /** The `language_info.name` its kernel reports. */
  readonly kernelLanguage: string;
  /** The kernel package, as users know it. */
  readonly kernelPackage: string;
  readonly sourceExtensions: ReadonlyArray<string>;
  readonly variablesExpression: string | null;
  readonly startupTimeoutMs?: number;
  /** In precedence order; bare names resolve through PATH. */
  readonly candidates: (
    platform: NodeJS.Platform,
    environment: Readonly<Record<string, string>>,
  ) => ReadonlyArray<string | KernelVersionedPath>;
  /** Prints the probe marker, version, architecture, home and its own kernel version, tab-separated. */
  readonly probeArgs: ReadonlyArray<string>;
  readonly readFacts: (context: DiscoveryContext, executable: string) => KernelInstallationFacts;
  /** False where a person's kernel cannot do what Scient needs, so Scient's own is used. */
  readonly ownKernelUsable?: (platform: NodeJS.Platform) => boolean;
  /** The language's own program, lowercase, as a kernel would start it. */
  readonly programName: string;
  /** Where installers recorded it, when that can be outside the usual folders. */
  readonly registered?: (context: DiscoveryContext) => Promise<ReadonlyArray<string>>;
  /** The program to start, when that differs from the one people run. */
  readonly program?: (context: DiscoveryContext, executable: string) => string;
  /** Where the executable sits inside a conda-style environment. */
  readonly inEnvironment: (platform: NodeJS.Platform) => ReadonlyArray<string>;
  /** Installs the kernel under `privateDirectory`, running the language or adding a program. */
  readonly setup:
    | ((
        privateDirectory: string,
        environment: Readonly<Record<string, string>>,
        platform: NodeJS.Platform,
      ) => { readonly args: ReadonlyArray<string>; readonly environment: Record<string, string> })
    | {
        readonly version: string;
        readonly add: (input: {
          readonly directory: string;
          readonly platform: NodeJS.Platform;
          readonly arch: NodeJS.Architecture;
          readonly signal: AbortSignal;
        }) => Promise<void>;
      };
  /** Null `privateDirectory` means the installation's own kernel. */
  readonly launch: (input: {
    readonly executable: string;
    readonly privateDirectory: string | null;
    readonly environment: Readonly<Record<string, string>>;
    readonly platform: NodeJS.Platform;
    readonly home: string;
  }) => KernelLaunch;
  readonly interruptMode: (platform: NodeJS.Platform) => "signal" | "message";
}

const PROBE_TIMEOUT = Duration.seconds(20);
const MARKER_FILE = "scient-kernel.json";
const Marker = Schema.Struct({ kernelVersion: Schema.String });
const decodeMarker = Schema.decodeUnknownSync(Schema.fromJsonString(Marker));
const encodeMarker = Schema.encodeSync(Schema.fromJsonString(Marker));

function runtimeError(
  operation: ComputeRuntimeError["operation"],
  message: string,
  cause?: unknown,
): ComputeRuntimeError {
  return new ComputeRuntimeError({ operation, message, ...(cause === undefined ? {} : { cause }) });
}

function manageError(message: string, cause?: unknown): ComputeOperationError {
  return new ComputeOperationError({
    operation: "manage",
    reason: "operation-failed",
    message: message.slice(0, 4096),
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The tab-separated line a probe prints after this marker, whatever startup files print. */
export const KERNEL_PROBE_MARKER = "scient-probe";

function parseKernelProbe(stdout: string): KernelInstallationProbe {
  const line = stdout
    .split(/\r?\n/u)
    .findLast((candidate) => candidate.startsWith(`${KERNEL_PROBE_MARKER}\t`));
  const [, version, architecture, home, ownKernelVersion] = (line ?? "")
    .split("\t")
    .map((field) => field.trim());
  if (!version || !home) throw new Error("The probe output was incomplete.");
  return {
    version,
    architecture: architecture || null,
    home,
    ownKernelVersion: ownKernelVersion || null,
  };
}

interface Installation {
  readonly executable: string;
  readonly source: ComputeRuntimeSource;
  /** The installation the user selected, whatever its source label. */
  readonly configured?: true;
  readonly origin: string | null;
}

interface KernelState {
  readonly probe: KernelInstallationFacts;
  readonly privateDirectory: string;
  /** Scient's private kernel version, when one is installed for this installation. */
  readonly privateKernelVersion: string | null;
}

/**
 * One binding per kernel language. Discovery, readiness and the private kernel setup are
 * shared; the language supplies paths, its probe and its kernel command line.
 */
export const makeKernelRuntimeBinding = Effect.fn("KernelComputeRuntime.makeBinding")(function* (
  language: KernelLanguage,
  input: {
    readonly host: Pick<KernelBridgeHost, "bridgePath" | "transport" | "executable" | "mayHost">;
    readonly computeDir: string;
    readonly processes: ExecutionProcessPort;
    readonly configuredExecutable: (languageId: string) => Effect.Effect<string | null>;
  },
): Effect.fn.Return<ComputeRuntimeBinding, never, FileSystem.FileSystem | Scope.Scope> {
  const fileSystem = yield* FileSystem.FileSystem;
  const scope = yield* Scope.Scope;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const hostEnvironment = yield* HostProcess.Environment;
  const { environment } = sanitizeComputeEnvironment(
    Object.fromEntries(
      Object.entries(hostEnvironment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  );
  const probes = makeRuntimeProbeCache<KernelInstallationProbe>({ concurrency: 2 });
  /** Why a discovered installation cannot run, for the verification of its unusable profile. */
  const problems = new Map<string, string>();

  /** Existing installations in precedence order, each named once. */
  const installations = Effect.fn("KernelComputeRuntime.installations")(function* (
    configured: string | null,
  ) {
    const context = yield* discoveryContext;
    const path = pathModule(platform);
    const found: Array<Installation & { readonly identity: string }> = [];
    const add = (
      name: string,
      source: ComputeRuntimeSource,
      configuredInstallation = false,
      origin: string | null = null,
    ) => {
      const bare = !path.isAbsolute(name);
      // A bare name is every PATH match, except a configured one, which means what a shell runs.
      const matches = bare ? pathMatches(context, [name]) : [name];
      for (const executable of configuredInstallation ? matches.slice(0, 1) : matches) {
        if (!context.host.isExecutable(executable)) continue;
        const resolved = context.host.realPath(executable) ?? executable;
        const identity = platform === "win32" ? resolved.toLowerCase() : resolved;
        if (found.some((installation) => installation.identity === identity)) continue;
        found.push({
          executable,
          source: bare ? "path" : source,
          identity,
          origin: origin ?? originFromPath(context, executable),
          ...(configuredInstallation ? { configured: true as const } : {}),
        });
      }
    };
    if (configured) add(configured, "configured", true);
    for (const candidate of language.candidates(platform, environment)) {
      if (typeof candidate === "string") add(candidate, "conventional");
      else
        for (const directory of versionedEntries(context, candidate.directory, candidate.prefix))
          add(path.join(directory, candidate.relative), "conventional");
    }
    for (const { prefix, origin } of condaPrefixes(context))
      for (const relative of language.inEnvironment(platform))
        add(path.join(prefix, relative), "conventional", false, origin);
    for (const executable of yield* Effect.promise(
      () => language.registered?.(context) ?? Promise.resolve([]),
    ))
      add(executable, "conventional");
    const isLanguage = (name: string) => name.replace(/\.exe$/u, "") === language.programName;
    for (const { executable, kernel } of kernelPrograms(
      context,
      language.kernelLanguage,
      isLanguage,
    ))
      add(executable, "conventional", false, `Kernel: ${kernel}`);
    return found;
  });

  /** A person's own kernel, unless this language cannot use it on this computer. */
  const ownKernelVersion = (state: KernelState) =>
    language.ownKernelUsable?.(platform) === false ? null : state.probe.ownKernelVersion;

  const programOf = (executable: string) =>
    Effect.map(
      discoveryContext,
      (context) => language.program?.(context, executable) ?? executable,
    );

  const probe = (executable: string) =>
    probes.get(
      executable,
      Effect.gen(function* () {
        const stdout = yield* runOwnedProcess(input.processes, {
          runId: `scient-${language.languageId}-probe-${NodeCrypto.randomUUID()}`,
          executable: yield* programOf(executable),
          args: language.probeArgs,
          cwd: NodeOS.tmpdir(),
          environment,
          stdoutOnly: true,
        }).pipe(
          Effect.timeoutOption(PROBE_TIMEOUT),
          Effect.mapError((cause) => runtimeError("discover", cause.message, cause)),
        );
        if (stdout._tag === "None")
          return yield* runtimeError("discover", `${executable} did not answer in time.`);
        return yield* Effect.try({
          try: () => parseKernelProbe(stdout.value),
          catch: (cause) =>
            runtimeError(
              "discover",
              `${executable} is not a usable ${language.displayName}.`,
              cause,
            ),
        });
      }),
    );

  const privateKernelVersion = (privateDirectory: string) =>
    fileSystem.readFileString(NodePath.join(privateDirectory, MARKER_FILE)).pipe(
      Effect.map((text) => decodeMarker(text).kernelVersion),
      Effect.orElseSucceed(() => null),
    );

  /** An installation's state from its files; nothing starts. */
  const fileState = Effect.fn("KernelComputeRuntime.fileState")(function* (executable: string) {
    const context = yield* discoveryContext;
    const facts = language.readFacts(context, executable);
    const privateDirectory = privateKernelDirectory(
      input.computeDir,
      language.languageId,
      context.host.realPath(executable) ?? executable,
      facts.version,
    );
    return {
      probe: facts,
      privateDirectory,
      privateKernelVersion: yield* privateKernelVersion(privateDirectory),
    } satisfies KernelState;
  });

  /** The same state as a running installation reports it: a Test or a Run asks this. */
  const kernelState = Effect.fn("KernelComputeRuntime.kernelState")(function* (executable: string) {
    const installationProbe = yield* probe(executable);
    const { privateDirectory, privateKernelVersion: version } = yield* fileState(executable);
    return {
      probe: installationProbe,
      privateDirectory,
      privateKernelVersion: version,
    } satisfies KernelState;
  });

  const profileFor = (
    installation: Installation,
    facts: KernelInstallationFacts,
  ): ComputeRuntimeProfile => ({
    languageId: language.languageId,
    source: installation.source,
    executable: installation.executable,
    languageVersion: facts.version ?? "unknown",
    architecture: facts.architecture,
    displayName: `${language.displayName} ${facts.version ?? ""} (${installation.source})`.replace(
      "  ",
      " ",
    ),
    ...(installation.origin === null ? {} : { origin: installation.origin }),
  });

  const unusable = (
    executable: string,
    source: ComputeRuntimeSource,
    problem: string,
  ): ComputeRuntimeProfile => {
    problems.set(executable, problem);
    return {
      languageId: language.languageId,
      source,
      executable,
      languageVersion: "unknown",
      architecture: null,
      displayName: `${language.displayName} (${source}, unavailable)`,
    };
  };

  const discover: ComputeLanguageAdapter["discover"] = Effect.fn("KernelComputeRuntime.discover")(
    function* (request) {
      if (request.refresh === true) probes.clear();
      const context = yield* discoveryContext;
      const configured = request.configuredExecutable?.trim() || null;
      const found = yield* installations(configured);
      // The selected installation keeps its own failure first; alternatives stay listed after it.
      const missing =
        configured !== null && !found.some((installation) => installation.configured)
          ? [
              unusable(
                configured,
                "configured",
                `The selected ${language.displayName} executable was not found.`,
              ),
            ]
          : [];
      return [
        ...missing,
        ...found.map((installation) => {
          problems.delete(installation.executable);
          return profileFor(installation, language.readFacts(context, installation.executable));
        }),
      ];
    },
  );

  const hostExecutable = Effect.fn("KernelComputeRuntime.hostExecutable")(function* () {
    return yield* input.host.executable(yield* input.configuredExecutable("python"));
  });

  const verify: ComputeLanguageAdapter["verify"] = Effect.fn("KernelComputeRuntime.verify")(
    function* (request) {
      const known = problems.get(request.profile.executable);
      if (known !== undefined) {
        return {
          profile: request.profile,
          readiness: "unusable" as const,
          missingRequirements: [],
          message: known,
          packages: [],
        };
      }
      const state = yield* Effect.result(kernelState(request.profile.executable));
      if (state._tag === "Failure") {
        return {
          profile: request.profile,
          readiness: "unusable" as const,
          missingRequirements: [],
          message: state.failure.message,
          packages: [],
        };
      }
      const kernelVersion =
        state.success.probe.ownKernelVersion ?? state.success.privateKernelVersion;
      const hostFound = yield* input.host.mayHost(yield* input.configuredExecutable("python"));
      return {
        profile: request.profile,
        readiness: hostFound ? ("ready" as const) : ("missing-requirement" as const),
        ...(hostFound ? { connection: "detected" as const } : {}),
        missingRequirements: hostFound ? [] : ["Python with jupyter_client"],
        message: hostFound
          ? null
          : "Set up Scientific Python, or choose a Python with jupyter_client and ipykernel.",
        packages: [{ name: language.kernelPackage.toLowerCase(), version: kernelVersion }],
      };
    },
  );

  const assess: NonNullable<ComputeLanguageAdapter["assess"]> = Effect.fn(
    "KernelComputeRuntime.assess",
  )(function* (profile) {
    const known = problems.get(profile.executable);
    if (known !== undefined)
      return {
        profile,
        readiness: "unusable" as const,
        missingRequirements: [],
        message: known,
        packages: [],
      };
    const state = yield* fileState(profile.executable);
    const kernelVersion = state.probe.ownKernelVersion ?? state.privateKernelVersion;
    const hostFound = yield* input.host.mayHost(yield* input.configuredExecutable("python"));
    return {
      profile,
      readiness: hostFound ? ("ready" as const) : ("missing-requirement" as const),
      ...(hostFound ? { connection: "detected" as const } : {}),
      missingRequirements: hostFound ? [] : ["Python with jupyter_client"],
      message: hostFound
        ? null
        : "Set up Scientific Python, or choose a Python with jupyter_client and ipykernel.",
      packages: [{ name: language.kernelPackage.toLowerCase(), version: kernelVersion }],
    };
  });

  const prepareLaunch: ComputeLanguageAdapter["prepareLaunch"] = Effect.fn(
    "KernelComputeRuntime.prepareLaunch",
  )(function* (request) {
    const readState = kernelState(request.profile.executable).pipe(
      Effect.mapError((cause) => runtimeError("prepare", cause.message, cause)),
    );
    let state = yield* readState;
    // Run needs no setup step: a missing kernel is added here, in Scient's own folder.
    if (ownKernelVersion(state) === null && state.privateKernelVersion === null) {
      yield* addKernel(request.profile.executable, state.privateDirectory);
      state = yield* readState;
    }
    const host = yield* hostExecutable();
    const kernel = language.launch({
      executable: yield* programOf(request.profile.executable),
      privateDirectory: ownKernelVersion(state) === null ? state.privateDirectory : null,
      environment: request.environment,
      platform,
      home: state.probe.home,
    });
    const plan = yield* Effect.try({
      try: () =>
        buildLaunchPlan(
          {
            profile: { ...request.profile, executable: host },
            cwd: request.cwd,
            environment: { ...request.environment, ...kernel.environment },
          },
          input.host.bridgePath,
        ),
      catch: (cause) => runtimeError("prepare", "The launch request was not usable.", cause),
    });
    return {
      ...plan,
      kernel: {
        argv: kernel.argv,
        language: language.kernelLanguage,
        interruptMode: kernel.interruptMode ?? language.interruptMode(platform),
        ...(kernel.interruptedReplyIsOk ? { interruptedReplyIsOk: true } : {}),
        variablesExpression: language.variablesExpression,
        ...(language.startupTimeoutMs === undefined
          ? {}
          : { startupTimeoutSeconds: Math.ceil(language.startupTimeoutMs / 1000) }),
      },
    };
  });

  const fingerprintEnvironment: ComputeLanguageAdapter["fingerprintEnvironment"] = Effect.fn(
    "KernelComputeRuntime.fingerprintEnvironment",
  )(function* (profile) {
    const state = yield* kernelState(profile.executable).pipe(
      Effect.mapError((cause) => runtimeError("fingerprint", cause.message, cause)),
    );
    const data = [
      profile.executable,
      state.probe.version,
      state.probe.architecture ?? "",
      state.probe.ownKernelVersion ?? `private:${state.privateKernelVersion ?? ""}`,
    ].join("|");
    return {
      hash: `sha256:${NodeCrypto.createHash("sha256").update(data).digest("hex")}`,
      contributors: ["executable", "languageVersion", "architecture", "kernel"],
    };
  });

  const listInstallations: NonNullable<ComputeLanguageAdapter["listInstallations"]> = Effect.fn(
    "KernelComputeRuntime.listInstallations",
  )(function* (request) {
    const context = yield* discoveryContext;
    const configured = request.configuredExecutable?.trim() || null;
    const found: ComputeRuntimeInstallation[] = (yield* installations(configured)).map(
      (installation) => ({
        executable: installation.executable,
        source: installation.source,
        ...(installation.configured ? { configured: true } : {}),
        version: language.readFacts(context, installation.executable).version,
        problem: null,
        ...(installation.origin === null ? {} : { origin: installation.origin }),
      }),
    );
    if (configured !== null && !found.some((installation) => installation.configured))
      found.unshift({
        executable: configured,
        source: "configured",
        configured: true,
        version: null,
        problem: `The selected ${language.displayName} executable was not found.`,
      });
    return found;
  });

  // Setup installs the kernel for the installation new sessions use by default.
  let operation: {
    readonly operationId: string;
    readonly action: ComputeManagedRuntimeAction;
    readonly startedAt: string;
    readonly fiber: Fiber.Fiber<void, never>;
  } | null = null;
  let failure: ComputeManagedRuntimeFailure | null = null;
  /** Two first runs must not install over each other. */
  const setupLock = yield* Semaphore.make(1);

  const target = Effect.fn("KernelComputeRuntime.setupTarget")(function* () {
    const configured = yield* input.configuredExecutable(language.languageId);
    for (const installation of yield* installations(configured)) {
      if (configured !== null && installation.configured !== true) return null;
      return { installation, state: yield* fileState(installation.executable) };
    }
    return null;
  });

  const status = Effect.fn("KernelComputeRuntime.status")(function* () {
    const current = yield* target().pipe(Effect.orElseSucceed(() => null));
    const own = current?.state.probe.ownKernelVersion ?? null;
    const installed = current?.state.privateKernelVersion ?? null;
    const kernelVersion = own ?? installed;
    return {
      displayName: language.kernelPackage,
      ...(current === null ? {} : { installationExecutable: current.installation.executable }),
      installed: installed !== null,
      selection: own === null ? ("managed" as const) : ("existing" as const),
      updateAvailable: false,
      runtimeVersion: kernelVersion,
      toolkitRevision: null,
      toolkitIds: [],
      operation:
        operation === null
          ? null
          : {
              operationId: operation.operationId,
              action: operation.action,
              phase:
                operation.action === "remove"
                  ? ("removing" as const)
                  : ("installing-packages" as const),
              startedAt: operation.startedAt,
              downloadedBytes: null,
              totalBytes: null,
            },
      failure,
      failureMessage: failure?.detail ?? null,
    } satisfies ComputeManagedRuntimeStatus;
  });

  const install = Effect.fn("KernelComputeRuntime.installKernel")(function* (
    executable: string,
    privateDirectory: string,
  ) {
    // A running session keeps the copy it started with. Windows refuses while files are in use,
    // and the failure says so instead of breaking the session.
    const previous = `${privateDirectory}.previous-${NodeCrypto.randomUUID()}`;
    const replaced = yield* fileSystem.rename(privateDirectory, previous).pipe(
      Effect.as(true),
      Effect.catchIf(
        (cause) => cause._tag === "PlatformError" && cause.reason._tag === "NotFound",
        () => Effect.succeed(false),
      ),
    );
    const restore = fileSystem
      .remove(privateDirectory, { recursive: true, force: true })
      .pipe(
        Effect.andThen(replaced ? fileSystem.rename(previous, privateDirectory) : Effect.void),
        Effect.ignore,
      );
    const addKernelFiles = Effect.gen(function* () {
      yield* fileSystem.makeDirectory(privateDirectory, { recursive: true });
      const { setup } = language;
      const kernelVersion =
        typeof setup === "function"
          ? (yield* runOwnedProcess(input.processes, {
              runId: `scient-${language.languageId}-kernel-setup-${NodeCrypto.randomUUID()}`,
              executable: yield* programOf(executable),
              args: setup(privateDirectory, environment, platform).args,
              cwd: privateDirectory,
              environment: setup(privateDirectory, environment, platform).environment,
              stdoutOnly: true,
            }))
              .trim()
              .split("\n")
              .pop()
              ?.trim()
          : yield* Effect.tryPromise({
              try: (signal) =>
                setup
                  .add({ directory: privateDirectory, platform, arch, signal })
                  .then(() => setup.version),
              catch: (cause) =>
                manageError(cause instanceof Error ? cause.message : String(cause), cause),
            });
      if (!kernelVersion) return yield* manageError(`${language.kernelPackage} did not install.`);
      yield* fileSystem.writeFileString(
        NodePath.join(privateDirectory, MARKER_FILE),
        encodeMarker({ kernelVersion }),
      );
    });
    yield* addKernelFiles.pipe(Effect.onError(() => restore));
    if (replaced)
      yield* fileSystem.remove(previous, { recursive: true, force: true }).pipe(Effect.ignore);
  });

  const manage = Effect.fn("KernelComputeRuntime.manage")(function* (
    action: ComputeManagedRuntimeAction,
  ) {
    if (action === "use-managed" || action === "use-existing")
      return yield* manageError(`${language.kernelPackage} has no runtime choice.`);
    if (operation !== null) return yield* status();
    yield* setupLock.withPermits(1)(
      Effect.gen(function* () {
        if (operation !== null) return;
        const current = yield* target();
        if (current === null) return yield* manageError(`${language.displayName} was not found.`);
        yield* begin(action, current.installation.executable, current.state.privateDirectory);
      }),
    );
    return yield* status();
  });

  /** The kernel for a Run, sharing any setup already under way. */
  const addKernel = Effect.fn("KernelComputeRuntime.addKernel")(function* (
    executable: string,
    privateDirectory: string,
  ) {
    yield* setupLock.withPermits(1)(
      Effect.gen(function* () {
        if (operation !== null) yield* Fiber.await(operation.fiber);
        const known = yield* fileState(executable);
        if (known.privateKernelVersion !== null) return;
        yield* Fiber.await(yield* begin("install", executable, privateDirectory));
        if (failure !== null)
          return yield* runtimeError("prepare", `${failure.summary}: ${failure.detail}`);
      }),
    );
  });

  const begin = Effect.fn("KernelComputeRuntime.begin")(function* (
    action: ComputeManagedRuntimeAction,
    executable: string,
    privateDirectory: string,
  ) {
    const work = Effect.gen(function* () {
      if (action === "remove")
        return yield* fileSystem.remove(privateDirectory, { recursive: true });
      yield* install(executable, privateDirectory).pipe(
        Effect.onInterrupt(() =>
          fileSystem.remove(privateDirectory, { recursive: true }).pipe(Effect.ignore),
        ),
      );
    });
    const operationId = NodeCrypto.randomUUID();
    const fiber = yield* work.pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.sync(() => {
            if (Cause.hasInterruptsOnly(cause)) return;
            const error = Cause.squash(cause);
            failure = {
              reason: action === "remove" ? "remove-failed" : "provision-failed",
              action,
              summary: `${language.kernelPackage} ${action === "remove" ? "removal" : "setup"} failed`,
              detail: (error instanceof Error ? error.message : String(error)).slice(0, 4096),
            };
          }),
        onSuccess: () =>
          Effect.sync(() => {
            failure = null;
          }),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          probes.clear();
          if (operation?.operationId === operationId) operation = null;
        }),
      ),
      Effect.forkIn(scope),
    );
    operation = {
      operationId,
      action,
      startedAt: DateTime.formatIso(yield* DateTime.now),
      fiber,
    };
    return fiber;
  });

  const cancel = Effect.fn("KernelComputeRuntime.cancel")(function* () {
    if (operation !== null) yield* Fiber.interrupt(operation.fiber);
    return yield* status();
  });

  const variables: ReadonlyArray<ComputeCapability> =
    language.variablesExpression === null ? [] : ["variables"];
  return {
    adapter: {
      languageId: language.languageId,
      transportKind: JUPYTER_BRIDGE_TRANSPORT_KIND,
      listInstallations,
      discover,
      assess,
      verify,
      prepareLaunch,
      normalizeDiagnostic: (report) => [{ ...normalizeDiagnosticText(report), frames: [] }],
      fingerprintEnvironment,
    },
    transport: input.host.transport(language.startupTimeoutMs),
    descriptor: {
      languageId: language.languageId,
      displayName: language.displayName,
      sourceExtensions: language.sourceExtensions,
      capabilities: [...REQUIRED_COMPUTE_CAPABILITIES, ...variables],
    },
    managedRuntime: {
      isRemoving: () => operation?.action === "remove",
      rebuildsInPlace: true,
      status: () => status(),
      manage: (action) => manage(action),
      cancel: () => cancel(),
    },
  };
});
