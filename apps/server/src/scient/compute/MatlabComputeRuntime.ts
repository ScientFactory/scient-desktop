// @effect-diagnostics nodeBuiltinImport:off -- Engine discovery inspects one selected installation.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ComputeRuntimeError, REQUIRED_COMPUTE_CAPABILITIES } from "@scientfactory/compute";
import { ExecutionRunId } from "@scientfactory/execution";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DuplexProcess } from "../execution/LocalDuplexProcess.ts";
import { ExecutionProcess } from "../execution/LocalExecutionProcess.ts";
import { sanitizeComputeEnvironment } from "./ComputeEnvironmentPolicy.ts";
import type { ComputeRuntimeBinding } from "./ComputeSessionService.ts";
import { makeComputeBridgeTransport } from "./ComputeBridgeTransport.ts";
import {
  MATLAB_LANGUAGE_ID,
  makeMatlabRuntimeAdapter,
  matlabEngineDirectory,
  matlabInstallationRoot,
  type MatlabEngineProbeResult,
} from "./MatlabRuntimeAdapter.ts";
import {
  BRIDGE_SCRIPT_NAME,
  STAGED_BRIDGE_DIRECTORY,
  moduleDirectory,
} from "./PythonComputeRuntime.ts";

export const MATLAB_BRIDGE_SCRIPT_NAME = "scient_matlab_engine_bridge.py";
const PROBE_TIMEOUT = Duration.seconds(20);
const PROBE_DRAIN_GRACE = Duration.seconds(2);
const MAXIMUM_PROBE_BYTES = 256 * 1024;

const HOST_PROBE_SCRIPT = [
  "import json, os, platform, sys",
  "sys.path.insert(0, sys.argv[1])",
  "import matlab.engine",
  "print(json.dumps({",
  '  "hostExecutable": os.path.realpath(sys.executable),',
  '  "hostVersion": platform.python_version(),',
  '  "engineModule": os.path.realpath(matlab.engine.__file__),',
  '}, separators=(",", ":")))',
].join("\n");

const HostProbeResult = Schema.Struct({
  hostExecutable: Schema.String,
  hostVersion: Schema.String,
  engineModule: Schema.String,
});
type HostProbeResult = typeof HostProbeResult.Type;
const decodeHostProbe = Schema.decodeUnknownSync(HostProbeResult);

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

export function pathIsInside(directory: string, candidate: string): boolean {
  const relative = NodePath.relative(NodePath.resolve(directory), NodePath.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative)
  );
}

export function matlabBridgePathCandidates(directory: string): ReadonlyArray<string> {
  return [
    NodePath.join(directory, "bridge", MATLAB_BRIDGE_SCRIPT_NAME),
    NodePath.join(directory, STAGED_BRIDGE_DIRECTORY, MATLAB_BRIDGE_SCRIPT_NAME),
  ];
}

export const resolveMatlabBridgePath = (
  directory: string,
): Effect.Effect<string, ComputeRuntimeError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const candidates = matlabBridgePathCandidates(directory);
    for (const candidate of candidates) {
      const protocolPath = NodePath.join(NodePath.dirname(candidate), BRIDGE_SCRIPT_NAME);
      if (
        (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) &&
        (yield* fileSystem.exists(protocolPath).pipe(Effect.orElseSucceed(() => false)))
      ) {
        return candidate;
      }
    }
    return yield* runtimeError(
      `Unable to find ${MATLAB_BRIDGE_SCRIPT_NAME} with its shared ${BRIDGE_SCRIPT_NAME} sibling. Looked in: ${candidates.join(", ")}.`,
    );
  });

function hostCandidates(): ReadonlyArray<string> {
  return ["python3.13", "python3.12", "python3.11", "python3.10", "python3.9", "python3", "python"];
}

function parseHostProbe(value: string): HostProbeResult {
  return decodeHostProbe(JSON.parse(value.trim()));
}

function parseVersionInfo(value: string): { readonly release: string; readonly version: string } {
  const release = /<release>([^<]+)<\/release>/u.exec(value)?.[1]?.trim();
  const version = /<version>([^<]+)<\/version>/u.exec(value)?.[1]?.trim();
  if (release === undefined || version === undefined) {
    throw new Error("MATLAB VersionInfo.xml did not contain a release and version.");
  }
  return { release, version };
}

function matlabArchitecture(engineDirectory: string): string | null {
  try {
    const entries = NodePath.join(engineDirectory, "matlab", "engine");
    const architecture = NodeFS.readdirSync(entries).find((name: string) =>
      /^(?:glnxa64|maca64|maci64|win64)$/u.test(name),
    );
    return architecture ?? null;
  } catch {
    return null;
  }
}

export const makeMatlabEngineInspector = Effect.fn("makeMatlabEngineInspector")(function* () {
  const processes = yield* ExecutionProcess;
  const hostEnvironment = yield* HostProcessEnvironment;
  const { environment } = sanitizeComputeEnvironment(definedEnvironment(hostEnvironment));
  const runCounter = yield* Ref.make(0);

  const probeHost = Effect.fn("probeMatlabEngineHost")(function* (
    executable: string,
    engineDirectory: string,
  ) {
    const count = yield* Ref.updateAndGet(runCounter, (value) => value + 1);
    const handle = yield* processes
      .start({
        runId: ExecutionRunId.make(`scient-matlab-engine-probe-${String(count)}`),
        executable,
        args: ["-I", "-B", "-c", HOST_PROBE_SCRIPT, engineDirectory],
        cwd: NodeOS.tmpdir(),
        environment,
        extendEnv: false,
      })
      .pipe(Effect.mapError((cause) => runtimeError(`Unable to run ${executable}.`, cause)));
    const stdoutRef = yield* Ref.make("");
    const stderrRef = yield* Ref.make("");
    const bytesRef = yield* Ref.make(0);
    const outputExceeded = yield* Deferred.make<void>();
    const drain = yield* handle.output.pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const bytes = Buffer.byteLength(chunk.text, "utf8");
          const total = yield* Ref.updateAndGet(bytesRef, (current) => current + bytes);
          if (total > MAXIMUM_PROBE_BYTES) {
            yield* Deferred.succeed(outputExceeded, undefined);
            return;
          }
          yield* Ref.update(
            chunk.stream === "stdout" ? stdoutRef : stderrRef,
            (text) => `${text}${chunk.text}`,
          );
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("MATLAB Engine probe output ended early", { cause }),
      ),
      Effect.forkScoped,
    );
    const exitCode = yield* Effect.raceFirst(
      handle.exitCode.pipe(Effect.timeoutOption(PROBE_TIMEOUT)),
      Deferred.await(outputExceeded).pipe(Effect.as(Option.none<number>())),
    );
    if (Option.isNone(exitCode)) yield* handle.cancel.pipe(Effect.ignoreCause());
    yield* Fiber.join(drain).pipe(Effect.timeoutOption(PROBE_DRAIN_GRACE), Effect.ignoreCause());
    if (Option.isNone(exitCode)) {
      return yield* runtimeError(
        (yield* Ref.get(bytesRef)) > MAXIMUM_PROBE_BYTES
          ? `${executable} exceeded the MATLAB Engine probe output limit.`
          : `${executable} did not answer the MATLAB Engine probe in time.`,
      );
    }
    if (exitCode.value !== 0) {
      const detail = (yield* Ref.get(stderrRef)).trim().slice(-2048);
      return yield* runtimeError(
        `${executable} cannot host this MATLAB Engine${detail === "" ? "." : `: ${detail}`}`,
      );
    }
    const stdout = yield* Ref.get(stdoutRef);
    return yield* Effect.try({
      try: () => parseHostProbe(stdout),
      catch: (cause) => runtimeError(`${executable} returned an invalid Engine probe.`, cause),
    });
  });

  return Effect.fn("inspectMatlabEngine")(function* (
    executable: string,
  ): Effect.fn.Return<MatlabEngineProbeResult, ComputeRuntimeError> {
    if (!NodePath.isAbsolute(executable)) {
      return yield* runtimeError("The MATLAB executable path must be absolute.");
    }
    const resolved = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(executable),
      catch: (cause) => runtimeError(`MATLAB executable '${executable}' was not found.`, cause),
    });
    const stat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(resolved, { bigint: true }),
      catch: (cause) => runtimeError(`MATLAB executable '${resolved}' could not be read.`, cause),
    });
    if (!stat.isFile())
      return yield* runtimeError(`MATLAB executable '${resolved}' is not a file.`);
    const installationRoot = matlabInstallationRoot(resolved);
    const engineDirectory = matlabEngineDirectory(resolved);
    const versionInfo = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(NodePath.join(installationRoot, "VersionInfo.xml"), "utf8"),
      catch: (cause) => runtimeError("MATLAB VersionInfo.xml could not be read.", cause),
    });
    const version = yield* Effect.try({
      try: () => parseVersionInfo(versionInfo),
      catch: (cause) => runtimeError("MATLAB version information was malformed.", cause),
    });
    const host = yield* Effect.firstSuccessOf(
      hostCandidates().map((candidate) =>
        probeHost(candidate, engineDirectory).pipe(Effect.scoped),
      ),
    ).pipe(
      Effect.mapError((cause) =>
        runtimeError(
          "MATLAB is installed, but no compatible Python host could import its Engine API.",
          cause,
        ),
      ),
    );
    if (!pathIsInside(engineDirectory, host.engineModule)) {
      return yield* runtimeError("The Engine host imported MATLAB from a different installation.");
    }
    return {
      executable,
      executableRealpath: resolved,
      executableMtimeNs: stat.mtimeNs.toString(),
      installationRoot,
      release: version.release,
      version: version.version,
      architecture: matlabArchitecture(engineDirectory),
      engineDirectory,
      hostExecutable: host.hostExecutable,
      hostVersion: host.hostVersion,
    };
  });
});

export const matlabRuntimeBinding: Effect.Effect<
  ComputeRuntimeBinding,
  ComputeRuntimeError,
  DuplexProcess | ExecutionProcess | FileSystem.FileSystem
> = Effect.gen(function* () {
  const bridgePath = yield* resolveMatlabBridgePath(moduleDirectory());
  const inspect = yield* makeMatlabEngineInspector();
  const duplexProcesses = yield* DuplexProcess;
  const hostEnvironment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const { environment } = sanitizeComputeEnvironment(definedEnvironment(hostEnvironment));
  const runtime = makeMatlabRuntimeAdapter(inspect, environment, platform, bridgePath);
  const transport = makeComputeBridgeTransport(duplexProcesses, { startupTimeoutMs: 180_000 });
  return {
    adapter: runtime.adapter,
    transport,
    descriptor: {
      languageId: MATLAB_LANGUAGE_ID,
      displayName: "MATLAB",
      sourceExtensions: [".m"],
      capabilities: [...REQUIRED_COMPUTE_CAPABILITIES, "variables"],
    },
  };
});
