// @effect-diagnostics nodeBuiltinImport:off -- runtime discovery is an operating-system adapter.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  ComputeLanguageId,
  ComputeRuntimeError,
  ComputeTransportKind,
  type ComputeDiagnostic,
  type ComputeEnvironmentFingerprint,
  type ComputeLanguageAdapter,
  type ComputeRuntimeProfile,
  type ComputeRuntimeSource,
} from "@scientfactory/compute";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { sanitizeComputeEnvironment, validateProjectRoot } from "./ComputeEnvironmentPolicy.ts";

export const MATLAB_LANGUAGE_ID = ComputeLanguageId.make("matlab");
const MATLAB_ENGINE_TRANSPORT_KIND = ComputeTransportKind.make("matlab-engine-bridge");

const PROBE_CACHE_TTL_MS = 30_000;

export interface MatlabEngineProbeResult {
  readonly executable: string;
  readonly executableRealpath: string;
  readonly executableMtimeNs: string;
  readonly installationRoot: string;
  readonly release: string;
  readonly version: string;
  readonly architecture: string | null;
  readonly engineDirectory: string;
  readonly hostExecutable: string;
  readonly hostVersion: string;
}

interface MatlabCandidate {
  readonly executable: string;
  readonly source: ComputeRuntimeSource;
}

function runtimeError(
  operation: ComputeRuntimeError["operation"],
  message: string,
  cause?: unknown,
): ComputeRuntimeError {
  return new ComputeRuntimeError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = NodeFS.statSync(path);
    if (!stat.isFile()) return false;
    if (platform === "win32") return true;
    NodeFS.accessSync(path, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function directoryNames(path: string): ReadonlyArray<string> {
  try {
    return NodeFS.readdirSync(path);
  } catch {
    return [];
  }
}

export function matlabReleaseFromExecutablePath(executable: string): string | null {
  const match = /(?:^|[^a-z0-9])(R\d{4}[ab])(?:[^a-z0-9]|$)/iu.exec(executable);
  return match?.[1] ?? null;
}

export function matlabInstallationRoot(executable: string): string {
  return NodePath.dirname(NodePath.dirname(executable));
}

export function matlabEngineDirectory(executable: string): string {
  return NodePath.join(matlabInstallationRoot(executable), "extern", "engines", "python", "dist");
}

function pathCandidates(
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  const pathValue = environment.PATH;
  if (pathValue === undefined) return [];
  const executableName = platform === "win32" ? "matlab.exe" : "matlab";
  return pathValue
    .split(NodePath.delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => NodePath.join(entry, executableName));
}

function conventionalCandidates(
  platform: NodeJS.Platform,
  environment: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  if (platform === "darwin") {
    return directoryNames("/Applications")
      .filter((name) => /^MATLAB_R\d{4}[ab]\.app$/u.test(name))
      .toSorted((left, right) => right.localeCompare(left))
      .map((name) => NodePath.join("/Applications", name, "bin", "matlab"));
  }
  if (platform === "win32") {
    const roots = [environment.ProgramFiles, environment["ProgramFiles(x86)"]].filter(
      (root): root is string => root !== undefined && root.length > 0,
    );
    return roots.flatMap((root) => {
      const matlabRoot = NodePath.join(root, "MATLAB");
      return directoryNames(matlabRoot)
        .toSorted((left, right) => right.localeCompare(left))
        .map((release) => NodePath.join(matlabRoot, release, "bin", "matlab.exe"));
    });
  }
  return directoryNames("/usr/local/MATLAB")
    .toSorted((left, right) => right.localeCompare(left))
    .map((release) => NodePath.join("/usr/local/MATLAB", release, "bin", "matlab"));
}

export function discoverMatlabCandidates(
  configuredExecutable: string | null,
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): ReadonlyArray<MatlabCandidate> {
  if (configuredExecutable !== null && configuredExecutable.trim().length > 0) {
    return [{ executable: configuredExecutable.trim(), source: "configured" }];
  }
  const candidates = [
    ...pathCandidates(environment, platform).map((executable) => ({
      executable,
      source: "path" as const,
    })),
    ...conventionalCandidates(platform, environment).map((executable) => ({
      executable,
      source: "conventional" as const,
    })),
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!isExecutable(candidate.executable, platform)) return false;
    const key = (() => {
      try {
        return NodeFS.realpathSync(candidate.executable);
      } catch {
        return NodePath.resolve(candidate.executable);
      }
    })();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function matlabProfile(
  probe: MatlabEngineProbeResult,
  source: ComputeRuntimeSource,
): ComputeRuntimeProfile {
  return {
    languageId: MATLAB_LANGUAGE_ID,
    source,
    executable: probe.executableRealpath,
    languageVersion: probe.release || probe.version,
    architecture: probe.architecture,
    displayName: `MATLAB ${probe.release || probe.version} (${source})`,
  };
}

function unavailableProfile(
  executable: string,
  source: ComputeRuntimeSource,
): ComputeRuntimeProfile {
  return {
    languageId: MATLAB_LANGUAGE_ID,
    source,
    executable,
    languageVersion: matlabReleaseFromExecutablePath(executable) ?? "unknown",
    architecture: null,
    displayName: `MATLAB (${source}, not usable)`,
  };
}

function engineHostRequirementIsMissing(cause: ComputeRuntimeError): boolean {
  return /no compatible (?:Python )?host could import its Engine API|no compatible Engine host/iu.test(
    cause.message,
  );
}

function diagnosticFrame(
  line: string,
  context: Parameters<ComputeLanguageAdapter["normalizeDiagnostic"]>[1],
): ComputeDiagnostic["frames"][number] | null {
  const match = /^(.*?):(\d+):([^:]+)$/u.exec(line);
  if (match === null) return null;
  const absolute = match[1] ?? "";
  const runtimeLine = Number(match[2]);
  if (absolute === "<submitted>" && context.submittedSource !== null) {
    return {
      relativePath: context.submittedSource.relativePath,
      line: context.submittedSource.startLine + runtimeLine,
      column: null,
      functionName: (match[3] ?? "").slice(0, 256) || null,
    };
  }
  const relative = NodePath.relative(context.projectRoot, absolute);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  ) {
    return null;
  }
  return {
    relativePath: relative.split(NodePath.sep).join("/").slice(0, 4096),
    line: runtimeLine,
    column: null,
    functionName: (match[3] ?? "").slice(0, 256) || null,
  };
}

export function computeMatlabFingerprint(
  profile: ComputeRuntimeProfile,
  probe: MatlabEngineProbeResult,
): ComputeEnvironmentFingerprint {
  const contributors = [
    "executable",
    "executableMtimeNs",
    "languageVersion",
    "architecture",
    "installationRoot",
    "engineHostExecutable",
    "engineHostVersion",
  ];
  const content = [
    probe.executableRealpath,
    probe.executableMtimeNs,
    profile.languageVersion,
    profile.architecture ?? "",
    probe.installationRoot,
    probe.hostExecutable,
    probe.hostVersion,
  ].join("|");
  return {
    hash: `sha256:${NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex")}`,
    contributors,
  };
}

export interface MatlabRuntimeAdapterResult {
  readonly adapter: ComputeLanguageAdapter;
  readonly clearProbeCache: () => void;
  readonly readProbe: (
    executable: string,
    refresh?: boolean,
  ) => Effect.Effect<MatlabEngineProbeResult, ComputeRuntimeError>;
}

export function makeMatlabRuntimeAdapter(
  inspect: (executable: string) => Effect.Effect<MatlabEngineProbeResult, ComputeRuntimeError>,
  environment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
  bridgePath?: string,
): MatlabRuntimeAdapterResult {
  const cache = new Map<
    string,
    { readonly observedAt: number; readonly result: MatlabEngineProbeResult }
  >();

  const readProbe = (executable: string, refresh = false) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = cache.get(executable);
      if (!refresh && cached !== undefined && now - cached.observedAt < PROBE_CACHE_TTL_MS) {
        return cached.result;
      }
      const result = yield* inspect(executable);
      const observedAt = yield* Clock.currentTimeMillis;
      cache.set(executable, { observedAt, result });
      cache.set(result.executableRealpath, { observedAt, result });
      return result;
    });

  const adapter: ComputeLanguageAdapter = {
    languageId: MATLAB_LANGUAGE_ID,
    transportKind: MATLAB_ENGINE_TRANSPORT_KIND,
    discover: (request) =>
      Effect.forEach(
        discoverMatlabCandidates(request.configuredExecutable, environment, platform),
        (candidate) =>
          readProbe(candidate.executable, request.refresh).pipe(
            Effect.map((probe) => matlabProfile(probe, candidate.source)),
            // Discovery already checked the executable. A broken helper or license
            // must remain visible with its actionable verification failure.
            Effect.catch(() =>
              Effect.succeed(unavailableProfile(candidate.executable, candidate.source)),
            ),
          ),
        { concurrency: 1 },
      ),
    verify: (request) =>
      readProbe(request.profile.executable).pipe(
        Effect.map((probe) => ({
          profile: matlabProfile(probe, request.profile.source),
          readiness: "ready" as const,
          connection: "detected" as const,
          missingRequirements: [],
          message: null,
          packages: [],
        })),
        Effect.catch((cause) => {
          const missingEngineHost = engineHostRequirementIsMissing(cause);
          return Effect.succeed({
            profile: request.profile,
            readiness: missingEngineHost ? ("missing-requirement" as const) : ("unusable" as const),
            missingRequirements: missingEngineHost ? ["MATLAB Engine for Python"] : [],
            message: cause.message.slice(0, 4096),
            packages: [],
          });
        }),
      ),
    prepareLaunch: (request) =>
      Effect.gen(function* () {
        if (bridgePath === undefined) {
          return yield* runtimeError("prepare", "The MATLAB bridge is unavailable.");
        }
        const probe = yield* readProbe(request.profile.executable, true);
        return {
          executable: probe.hostExecutable,
          args: [
            "-I",
            "-B",
            "-u",
            bridgePath,
            "--engine-directory",
            probe.engineDirectory,
            "--matlab-root",
            probe.installationRoot,
          ],
          cwd: validateProjectRoot(request.cwd),
          environment: sanitizeComputeEnvironment(request.environment).environment,
        };
      }),
    normalizeDiagnostic: (report, context) => [
      {
        errorName: (report.name || "MATLAB:ExecutionError").slice(0, 256),
        message: report.value.slice(0, 4096),
        traceback: report.traceback.map((line) => line.slice(0, 4096)).slice(0, 200),
        frames: report.traceback
          .map((line) => diagnosticFrame(line, context))
          .filter((frame) => frame !== null)
          .slice(0, 64),
      },
    ],
    fingerprintEnvironment: (profile) =>
      readProbe(profile.executable).pipe(
        Effect.map((probe) => computeMatlabFingerprint(profile, probe)),
        Effect.mapError((cause) => runtimeError("fingerprint", cause.message, cause)),
      ),
  };

  return { adapter, readProbe, clearProbeCache: () => cache.clear() };
}
