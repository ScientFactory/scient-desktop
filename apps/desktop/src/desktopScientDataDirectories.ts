import path from "node:path";

import {
  ensurePrivateScientDirectoriesSync,
  type ScientDataDirectoryPaths,
} from "@synara/shared/scientDataDirectories";

export function deriveDesktopScientDataDirectories(baseDir: string): ScientDataDirectoryPaths {
  const stateDir = path.join(baseDir, "userdata");
  const logsDir = path.join(stateDir, "logs");
  return {
    baseDir,
    stateDir,
    secretsDir: path.join(stateDir, "secrets"),
    worktreesDir: path.join(baseDir, "worktrees"),
    attachmentsDir: path.join(stateDir, "attachments"),
    logsDir,
    providerLogsDir: path.join(logsDir, "provider"),
    terminalLogsDir: path.join(logsDir, "terminals"),
  };
}

/** Secures desktop-owned state before logging or the backend child can touch it. */
export function ensurePrivateDesktopScientDataDirectoriesSync(
  baseDir: string,
  platform: NodeJS.Platform = process.platform,
): ScientDataDirectoryPaths {
  const paths = deriveDesktopScientDataDirectories(baseDir);
  ensurePrivateScientDirectoriesSync(paths, platform);
  return paths;
}
