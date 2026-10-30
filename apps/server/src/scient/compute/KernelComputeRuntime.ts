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
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { sanitizeComputeEnvironment } from "./ComputeEnvironmentPolicy.ts";
import type { ComputeRuntimeBinding } from "./ComputeSessionService.ts";
import { runOwnedProcess } from "./ManagedPythonProvisioner.ts";
import type { KernelBridgeHost } from "./PythonComputeRuntime.ts";
import { normalizeDiagnosticText } from "./PythonDiagnostic.ts";
import { JUPYTER_BRIDGE_TRANSPORT_KIND, buildLaunchPlan } from "./PythonRuntimeAdapter.ts";

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
  /** Identifies the installation; private kernels are kept per installation. */
  readonly home: string;
  /** The kernel package the installation already has for the user, if any. */
  readonly ownKernelVersion: string | null;
}

export interface KernelLaunch {
  readonly argv: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
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
  /** Installs the kernel under `privateDirectory`; the last stdout line is its version. */
  readonly setup: (
    privateDirectory: string,
    environment: Readonly<Record<string, string>>,
  ) => { readonly args: ReadonlyArray<string>; readonly environment: Record<string, string> };
  /** Null `privateDirectory` means the installation's own kernel. */
  readonly launch: (input: {
    readonly executable: string;
    readonly privateDirectory: string | null;
    readonly environment: Readonly<Record<string, string>>;
    readonly platform: NodeJS.Platform;
  }) => KernelLaunch;
  readonly interruptMode: (platform: NodeJS.Platform) => "signal" | "message";
}

const PROBE_TIMEOUT = Duration.seconds(20);
const PROBE_CACHE_MS = 30_000;
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

/** Keeps a private kernel apart per installation and version, since packages are built for one. */
function privateKernelDirectory(
  computeDir: string,
  languageId: string,
  probe: KernelInstallationProbe,
): string {
  const key = NodeCrypto.createHash("sha256")
    .update([probe.home, probe.version, probe.architecture ?? ""].join("\n"))
    .digest("hex")
    .slice(0, 16);
  return NodePath.join(computeDir, "kernels", languageId, key);
}

interface Installation {
  readonly executable: string;
  readonly source: ComputeRuntimeSource;
  /** The installation the user selected, whatever its source label. */
  readonly configured?: true;
}

interface KernelState {
  readonly probe: KernelInstallationProbe;
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
    readonly host: Pick<KernelBridgeHost, "bridgePath" | "transport" | "executable">;
    readonly computeDir: string;
    readonly processes: ExecutionProcessPort;
    readonly configuredExecutable: (languageId: string) => Effect.Effect<string | null>;
  },
): Effect.fn.Return<ComputeRuntimeBinding, never, FileSystem.FileSystem | Scope.Scope> {
  const fileSystem = yield* FileSystem.FileSystem;
  const scope = yield* Scope.Scope;
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  const { environment } = sanitizeComputeEnvironment(
    Object.fromEntries(
      Object.entries(hostEnvironment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  );
  const probeCache = new Map<
    string,
    { readonly probe: KernelInstallationProbe; readonly at: number }
  >();

  const exists = (path: string) => fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));

  const expand = Effect.fn("KernelComputeRuntime.expandCandidate")(function* (
    candidate: string | KernelVersionedPath,
  ) {
    if (typeof candidate === "string") return [candidate];
    const entries = yield* fileSystem
      .readDirectory(candidate.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    return entries
      .filter((entry) => entry.startsWith(candidate.prefix))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
      .map((entry) => NodePath.join(candidate.directory, entry, candidate.relative));
  });

  /** Existing installations in precedence order, each named once. */
  const installations = Effect.fn("KernelComputeRuntime.installations")(function* (
    configured: string | null,
  ) {
    const resolveExecutable = yield* SpawnExecutableResolution;
    const found: Array<Installation & { readonly identity: string }> = [];
    const add = Effect.fn("KernelComputeRuntime.addInstallation")(function* (
      name: string,
      source: ComputeRuntimeSource,
      configuredInstallation = false,
    ) {
      const bare = !NodePath.isAbsolute(name);
      const executable = bare ? resolveExecutable(name, platform, hostEnvironment) : name;
      if (executable === undefined || !(yield* exists(executable))) return;
      const identity = yield* fileSystem
        .realPath(executable)
        .pipe(Effect.orElseSucceed(() => executable));
      if (found.some((installation) => installation.identity === identity)) return;
      found.push({
        executable,
        source: bare ? "path" : source,
        identity,
        ...(configuredInstallation ? { configured: true as const } : {}),
      });
    });
    if (configured) yield* add(configured, "configured", true);
    for (const candidate of language.candidates(platform, environment)) {
      for (const path of yield* expand(candidate)) yield* add(path, "conventional");
    }
    return found;
  });

  const probe = Effect.fn("KernelComputeRuntime.probe")(function* (executable: string) {
    const now = yield* Clock.currentTimeMillis;
    const cached = probeCache.get(executable);
    if (cached !== undefined && now - cached.at < PROBE_CACHE_MS) return cached.probe;
    const stdout = yield* runOwnedProcess(input.processes, {
      runId: `scient-${language.languageId}-probe-${NodeCrypto.randomUUID()}`,
      executable,
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
    const result = yield* Effect.try({
      try: () => parseKernelProbe(stdout.value),
      catch: (cause) =>
        runtimeError("discover", `${executable} is not a usable ${language.displayName}.`, cause),
    });
    probeCache.set(executable, { probe: result, at: now });
    return result;
  });

  const kernelState = Effect.fn("KernelComputeRuntime.kernelState")(function* (executable: string) {
    const installationProbe = yield* probe(executable);
    const privateDirectory = privateKernelDirectory(
      input.computeDir,
      language.languageId,
      installationProbe,
    );
    const marker = yield* fileSystem
      .readFileString(NodePath.join(privateDirectory, MARKER_FILE))
      .pipe(
        Effect.map((text) => decodeMarker(text).kernelVersion),
        Effect.orElseSucceed(() => null),
      );
    return {
      probe: installationProbe,
      privateDirectory,
      privateKernelVersion: marker,
    } satisfies KernelState;
  });

  const profileFor = (
    installation: Installation,
    installationProbe: KernelInstallationProbe,
  ): ComputeRuntimeProfile => ({
    languageId: language.languageId,
    source: installation.source,
    executable: installation.executable,
    languageVersion: installationProbe.version,
    architecture: installationProbe.architecture,
    displayName: `${language.displayName} ${installationProbe.version} (${installation.source})`,
  });

  const discover: ComputeLanguageAdapter["discover"] = Effect.fn("KernelComputeRuntime.discover")(
    function* (request) {
      if (request.refresh === true) probeCache.clear();
      const configured = request.configuredExecutable?.trim() || null;
      const found = yield* installations(configured);
      // The selected installation keeps its own failure instead of silently falling back.
      const unavailable = (executable: string): ComputeRuntimeProfile => ({
        languageId: language.languageId,
        source: "configured",
        executable,
        languageVersion: "unknown",
        architecture: null,
        displayName: `${language.displayName} (configured, not found)`,
      });
      if (configured !== null && !found.some((installation) => installation.configured))
        return [unavailable(configured)];
      const profiles: ComputeRuntimeProfile[] = [];
      for (const installation of found) {
        const result = yield* Effect.result(probe(installation.executable));
        if (result._tag === "Success") profiles.push(profileFor(installation, result.success));
        else if (installation.configured) return [unavailable(installation.executable)];
      }
      return profiles;
    },
  );

  const hostExecutable = Effect.fn("KernelComputeRuntime.hostExecutable")(function* () {
    return yield* input.host.executable(yield* input.configuredExecutable("python"));
  });

  const verify: ComputeLanguageAdapter["verify"] = Effect.fn("KernelComputeRuntime.verify")(
    function* (request) {
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
      const host = yield* Effect.result(hostExecutable());
      const missing = [
        ...(kernelVersion === null ? [language.kernelPackage] : []),
        ...(host._tag === "Failure" ? ["Python with jupyter_client"] : []),
      ];
      return {
        profile: request.profile,
        readiness: missing.length === 0 ? ("ready" as const) : ("missing-requirement" as const),
        ...(missing.length === 0 ? { connection: "detected" as const } : {}),
        missingRequirements: missing,
        message:
          kernelVersion === null
            ? `${language.kernelPackage} is not set up.`
            : host._tag === "Failure"
              ? host.failure.message
              : null,
        packages: [{ name: language.kernelPackage.toLowerCase(), version: kernelVersion }],
      };
    },
  );

  const prepareLaunch: ComputeLanguageAdapter["prepareLaunch"] = Effect.fn(
    "KernelComputeRuntime.prepareLaunch",
  )(function* (request) {
    const state = yield* kernelState(request.profile.executable).pipe(
      Effect.mapError((cause) => runtimeError("prepare", cause.message, cause)),
    );
    if (state.probe.ownKernelVersion === null && state.privateKernelVersion === null)
      return yield* runtimeError("prepare", `${language.kernelPackage} is not set up.`);
    const host = yield* hostExecutable();
    const kernel = language.launch({
      executable: request.profile.executable,
      privateDirectory: state.probe.ownKernelVersion === null ? state.privateDirectory : null,
      environment: request.environment,
      platform,
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
        interruptMode: language.interruptMode(platform),
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
      state.probe.home,
      state.probe.version,
      state.probe.architecture ?? "",
      state.probe.ownKernelVersion ?? `private:${state.privateKernelVersion ?? ""}`,
    ].join("|");
    return {
      hash: `sha256:${NodeCrypto.createHash("sha256").update(data).digest("hex")}`,
      contributors: ["executable", "home", "languageVersion", "architecture", "kernel"],
    };
  });

  const listInstallations: NonNullable<ComputeLanguageAdapter["listInstallations"]> = Effect.fn(
    "KernelComputeRuntime.listInstallations",
  )(function* (request) {
    const configured = request.configuredExecutable?.trim() || null;
    const found: ComputeRuntimeInstallation[] = (yield* installations(configured)).map(
      (installation) => ({
        executable: installation.executable,
        source: installation.source,
        ...(installation.configured ? { configured: true } : {}),
        version: probeCache.get(installation.executable)?.probe.version ?? null,
        problem: null,
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

  const target = Effect.fn("KernelComputeRuntime.setupTarget")(function* () {
    const configured = yield* input.configuredExecutable(language.languageId);
    for (const installation of yield* installations(configured)) {
      if (configured !== null && installation.configured !== true) return null;
      const state = yield* Effect.result(kernelState(installation.executable));
      if (state._tag === "Success") return { installation, state: state.success };
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
    yield* fileSystem.remove(privateDirectory, { recursive: true }).pipe(Effect.ignore);
    yield* fileSystem.makeDirectory(privateDirectory, { recursive: true });
    const setup = language.setup(privateDirectory, environment);
    const stdout = yield* runOwnedProcess(input.processes, {
      runId: `scient-${language.languageId}-kernel-setup-${NodeCrypto.randomUUID()}`,
      executable,
      args: setup.args,
      cwd: privateDirectory,
      environment: setup.environment,
      stdoutOnly: true,
    });
    const kernelVersion = stdout.trim().split("\n").pop()?.trim();
    if (!kernelVersion) return yield* manageError(`${language.kernelPackage} did not install.`);
    yield* fileSystem.writeFileString(
      NodePath.join(privateDirectory, MARKER_FILE),
      encodeMarker({ kernelVersion }),
    );
  });

  const manage = Effect.fn("KernelComputeRuntime.manage")(function* (
    action: ComputeManagedRuntimeAction,
  ) {
    if (action === "use-managed" || action === "use-existing")
      return yield* manageError(`${language.kernelPackage} has no runtime choice.`);
    if (operation !== null) return yield* status();
    const current = yield* target();
    if (current === null) return yield* manageError(`${language.displayName} was not found.`);
    const { privateDirectory } = current.state;
    const work = Effect.gen(function* () {
      if (action === "remove")
        return yield* fileSystem.remove(privateDirectory, { recursive: true });
      yield* install(current.installation.executable, privateDirectory).pipe(
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
          probeCache.clear();
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
    return yield* status();
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
