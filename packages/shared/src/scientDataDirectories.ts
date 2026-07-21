import { ensurePrivateDirectorySync } from "./privatePathPermissions";

export interface ScientDataDirectoryPaths {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly secretsDir: string;
  readonly worktreesDir: string;
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly providerLogsDir: string;
  readonly terminalLogsDir: string;
}

type ScientStateDirectoryPaths = Omit<ScientDataDirectoryPaths, "baseDir" | "worktreesDir">;

/** Secures children of an application-data home without modifying the home itself. */
export function ensurePrivateScientStateDirectoriesSync(
  paths: ScientStateDirectoryPaths,
  platform: NodeJS.Platform = process.platform,
): void {
  const privateDirectories = [
    paths.stateDir,
    paths.secretsDir,
    paths.attachmentsDir,
    paths.logsDir,
    paths.providerLogsDir,
    paths.terminalLogsDir,
  ];

  for (const directoryPath of new Set(privateDirectories)) {
    ensurePrivateDirectorySync(directoryPath, platform);
  }
}

/**
 * Creates or repairs every security-boundary directory derived from
 * SCIENT_HOME. User-selected project/workspace paths are deliberately absent.
 */
export function ensurePrivateScientDirectoriesSync(
  paths: ScientDataDirectoryPaths,
  platform: NodeJS.Platform = process.platform,
): void {
  ensurePrivateDirectorySync(paths.baseDir, platform);
  ensurePrivateScientStateDirectoriesSync(paths, platform);
  ensurePrivateDirectorySync(paths.worktreesDir, platform);
}
