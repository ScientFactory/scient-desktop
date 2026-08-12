// @effect-diagnostics nodeBuiltinImport:off -- MATLAB discovery is an operating-system adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  AnalysisRuntimeId,
  type AnalysisRuntimeAdapter,
  type AnalysisRuntimeProfile,
  type AnalysisRunSource,
} from "@scientfactory/analysis";

export const MATLAB_RUNTIME_ID = AnalysisRuntimeId.make("matlab:local");
export const MATLAB_RUNTIME_KIND = "matlab" as const;
export const MATLAB_BATCH_EXPRESSION = "run(getenv('SCIENT_MATLAB_ENTRYPOINT'))";

interface MatlabDiscoveryInput {
  readonly customExecutablePath?: string | undefined;
  readonly inspectedAt: string;
  readonly platform: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

function executableName(platform: string): string {
  return platform === "win32" ? "matlab.exe" : "matlab";
}

export function matlabReleaseFromExecutablePath(executablePath: string): string | null {
  const match = /(?:^|[^a-z0-9])(R\d{4}[ab])(?:[^a-z0-9]|$)/iu.exec(executablePath);
  if (!match?.[1]) return null;
  return `${match[1].slice(0, -1).toUpperCase()}${match[1].at(-1)?.toLowerCase()}`;
}

async function executableFile(candidate: string, platform: string): Promise<boolean> {
  try {
    const stat = await NodeFSP.stat(candidate);
    if (!stat.isFile()) return false;
    if (platform !== "win32") await NodeFSP.access(candidate, NodeFSP.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function directoryNames(directory: string): Promise<ReadonlyArray<string>> {
  try {
    return (await NodeFSP.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted()
      .toReversed();
  } catch {
    return [];
  }
}

async function conventionalCandidates(
  platform: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ReadonlyArray<string>> {
  if (platform === "darwin") {
    const releases = (await directoryNames("/Applications")).filter((name) =>
      /^MATLAB_R\d{4}[ab]\.app$/u.test(name),
    );
    return releases.map((name) => NodePath.join("/Applications", name, "bin", "matlab"));
  }
  if (platform === "win32") {
    const roots = [environment.ProgramFiles, environment["ProgramFiles(x86)"]].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    const candidates: string[] = [];
    for (const root of roots) {
      const matlabRoot = NodePath.join(root, "MATLAB");
      for (const release of await directoryNames(matlabRoot)) {
        candidates.push(NodePath.join(matlabRoot, release, "bin", "matlab.exe"));
      }
    }
    return candidates;
  }
  if (platform === "linux") {
    const root = "/usr/local/MATLAB";
    return (await directoryNames(root)).map((release) =>
      NodePath.join(root, release, "bin", "matlab"),
    );
  }
  return [];
}

function pathCandidates(
  platform: string,
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> {
  const pathValue = environment.PATH;
  if (!pathValue) return [];
  return pathValue
    .split(NodePath.delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => NodePath.join(entry, executableName(platform)));
}

export async function inspectMatlabRuntime(
  input: MatlabDiscoveryInput,
): Promise<AnalysisRuntimeProfile> {
  const platform = input.platform;
  const environment = input.environment;
  const customPath = input.customExecutablePath?.trim();
  if (customPath) {
    const absolutePath = NodePath.resolve(customPath);
    const available = await executableFile(absolutePath, platform);
    return {
      id: MATLAB_RUNTIME_ID,
      kind: MATLAB_RUNTIME_KIND,
      label: "MATLAB",
      availability: available ? "available" : "invalid",
      source: "custom",
      executablePath: absolutePath,
      version: matlabReleaseFromExecutablePath(absolutePath),
      detail: available
        ? "Configured MATLAB executable."
        : "The configured MATLAB executable does not exist or is not executable.",
      capabilities: ["run-file", "stream-output", "cancel-process-tree"],
      inspectedAt: input.inspectedAt,
    };
  }

  for (const candidate of pathCandidates(platform, environment)) {
    if (await executableFile(candidate, platform)) {
      return {
        id: MATLAB_RUNTIME_ID,
        kind: MATLAB_RUNTIME_KIND,
        label: "MATLAB",
        availability: "available",
        source: "path",
        executablePath: candidate,
        version: matlabReleaseFromExecutablePath(candidate),
        detail: "MATLAB found on PATH.",
        capabilities: ["run-file", "stream-output", "cancel-process-tree"],
        inspectedAt: input.inspectedAt,
      };
    }
  }
  for (const candidate of await conventionalCandidates(platform, environment)) {
    if (await executableFile(candidate, platform)) {
      return {
        id: MATLAB_RUNTIME_ID,
        kind: MATLAB_RUNTIME_KIND,
        label: "MATLAB",
        availability: "available",
        source: "conventional-install",
        executablePath: candidate,
        version: matlabReleaseFromExecutablePath(candidate),
        detail: "MATLAB found in a conventional installation folder.",
        capabilities: ["run-file", "stream-output", "cancel-process-tree"],
        inspectedAt: input.inspectedAt,
      };
    }
  }
  return {
    id: MATLAB_RUNTIME_ID,
    kind: MATLAB_RUNTIME_KIND,
    label: "MATLAB",
    availability: "missing",
    source: "unconfigured",
    executablePath: null,
    version: null,
    detail: "MATLAB was not found. Choose its executable to enable Run File.",
    capabilities: ["run-file", "stream-output", "cancel-process-tree"],
    inspectedAt: input.inspectedAt,
  };
}

export function prepareMatlabCommand(input: {
  readonly profile: AnalysisRuntimeProfile;
  readonly source: AnalysisRunSource;
  readonly absoluteSourcePath: string;
}) {
  if (input.profile.executablePath === null) {
    throw new Error("MATLAB executable is unavailable.");
  }
  return {
    executable: input.profile.executablePath,
    args: ["-batch", MATLAB_BATCH_EXPRESSION],
    cwd: input.source.cwd,
    environment: { SCIENT_MATLAB_ENTRYPOINT: input.absoluteSourcePath },
  } as const;
}

/** MATLAB-specific behavior behind the runtime-neutral analysis adapter port. */
export const matlabRuntimeAdapter: AnalysisRuntimeAdapter = {
  id: MATLAB_RUNTIME_ID,
  kind: MATLAB_RUNTIME_KIND,
  fileExtensions: [".m"],
  inspect: inspectMatlabRuntime,
  prepare: (context) =>
    prepareMatlabCommand({
      profile: context.runtime,
      source: context.source,
      absoluteSourcePath: context.absoluteSourcePath,
    }),
};
