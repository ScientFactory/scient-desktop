// @effect-diagnostics nodeBuiltinImport:off -- This generation-scoped fail-closed handoff runs before the server Effect runtime exists so a reparented backend can publish its PID.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const SCIENT_DESKTOP_DEV_BACKEND_PID_HANDOFF_ENV = "SCIENT_DESKTOP_DEV_BACKEND_PID_HANDOFF";
export const SCIENT_DESKTOP_DEV_BACKEND_PID_FILE_ENV = "SCIENT_DESKTOP_DEV_BACKEND_PID_FILE";
export const SCIENT_DESKTOP_DEV_BACKEND_LAUNCH_GENERATION_ENV =
  "SCIENT_DESKTOP_DEV_BACKEND_LAUNCH_GENERATION";

const DEVELOPMENT_LAUNCH_GENERATION_PATTERN = /^[a-f0-9]+(?:-[a-f0-9]+)*$/u;

interface PidHandoffPath {
  readonly isAbsolute: (path: string) => boolean;
  readonly join: (...paths: ReadonlyArray<string>) => string;
}

interface PidHandoffFileSystem {
  readonly lstatSync: (path: string) => { readonly isFile: () => boolean };
  readonly readFileSync: (path: string, encoding: "utf8") => string;
  readonly writeFileSync: (
    path: string,
    contents: string,
    options: { readonly flag: "wx"; readonly mode: number },
  ) => void;
  readonly renameSync: (source: string, destination: string) => void;
  readonly rmSync: (path: string, options: { readonly force: true }) => void;
}

export interface DesktopDevelopmentBackendPidHandoff {
  readonly generation: string;
  readonly pidFilePath: string;
  readonly pendingFilePath: string;
}

export function resolveDesktopDevelopmentBackendPidHandoff(
  environment: Readonly<Record<string, string | undefined>>,
  path: PidHandoffPath = NodePath,
): DesktopDevelopmentBackendPidHandoff | null {
  if (environment[SCIENT_DESKTOP_DEV_BACKEND_PID_HANDOFF_ENV] !== "1") return null;
  const baseDir = environment.SCIENT_NEXT_HOME?.trim();
  const generation = environment[SCIENT_DESKTOP_DEV_BACKEND_LAUNCH_GENERATION_ENV]?.trim();
  const pidFilePath = environment[SCIENT_DESKTOP_DEV_BACKEND_PID_FILE_ENV]?.trim();
  if (
    !baseDir ||
    !generation ||
    !pidFilePath ||
    !path.isAbsolute(baseDir) ||
    !path.isAbsolute(pidFilePath) ||
    !DEVELOPMENT_LAUNCH_GENERATION_PATTERN.test(generation)
  ) {
    return null;
  }

  const launchDirectory = path.join(baseDir, "local-dev-app-runtime", "launches", generation);
  if (pidFilePath !== path.join(launchDirectory, "backend.pid")) return null;
  return {
    generation,
    pidFilePath,
    pendingFilePath: path.join(launchDirectory, "backend.pending"),
  };
}

export function publishDesktopDevelopmentBackendPid({
  environment = process.env,
  fileSystem = NodeFS,
  path = NodePath,
  pid = process.pid,
}: {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fileSystem?: PidHandoffFileSystem;
  readonly path?: PidHandoffPath;
  readonly pid?: number;
} = {}): boolean {
  const handoff = resolveDesktopDevelopmentBackendPidHandoff(environment, path);
  if (handoff === null || !Number.isInteger(pid) || pid <= 0) return false;

  const pidWasPublished = (): boolean => {
    try {
      return fileSystem.readFileSync(handoff.pidFilePath, "utf8").trim() === String(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  if (pidWasPublished()) return true;

  try {
    const pendingStat = fileSystem.lstatSync(handoff.pendingFilePath);
    if (!pendingStat.isFile()) {
      if (pidWasPublished()) return true;
      throw new Error(`Invalid desktop backend PID handoff at ${handoff.pendingFilePath}.`);
    }
    if (fileSystem.readFileSync(handoff.pendingFilePath, "utf8").trim() !== handoff.generation) {
      if (pidWasPublished()) return true;
      throw new Error(`Invalid desktop backend PID handoff at ${handoff.pendingFilePath}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (pidWasPublished()) return true;
      throw new Error(`Missing desktop backend PID handoff at ${handoff.pendingFilePath}.`, {
        cause: error,
      });
    }
    throw error;
  }

  const temporaryPath = `${handoff.pidFilePath}.self-${String(pid)}.tmp`;
  try {
    fileSystem.writeFileSync(temporaryPath, `${String(pid)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fileSystem.renameSync(temporaryPath, handoff.pidFilePath);
    return true;
  } finally {
    fileSystem.rmSync(temporaryPath, { force: true });
  }
}

// This module is imported first by bin.ts. The desktop manager remains the
// primary publisher at its onStarted boundary; this child-side publication
// closes the abrupt parent-death interval between fork and that atomic write.
publishDesktopDevelopmentBackendPid();
