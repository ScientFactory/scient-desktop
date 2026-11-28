// SCIENT-OWNED: the parts of the backend launch configuration that Scient adds.
// DesktopBackendConfiguration.ts calls these from short marked lines.
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { SCIENT_ANALYTICS_METADATA_ENV_NAMES } from "./scientAnalyticsMetadata.ts";

export const WSL_CANDIDATE_ENV_NAMES = [
  ...SCIENT_ANALYTICS_METADATA_ENV_NAMES,
  "T3CODE_HOME",
  "SCIENT_NEXT_HOME",
  "SCIENT_NEXT_DEVELOPMENT_STATE",
  "SCIENT_NEXT_SAFETY_ENVELOPE",
  "SCIENT_DESKTOP_BACKGROUND_RUNNING",
] as const;

function syncTexNavigatorBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "synctex.exe" : "synctex";
}

export const resolveSyncTexNavigatorPath = Effect.fn(
  "desktop.backendConfiguration.resolveSyncTexNavigatorPath",
)(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const binaryName = syncTexNavigatorBinaryName(environment.platform);
  const platformKey = `${environment.platform}-${environment.processArch}`;
  const candidates = environment.isDevelopment
    ? [
        environment.path.join(
          environment.rootDir,
          "native/synctex-runtime",
          platformKey,
          binaryName,
        ),
      ]
    : environment.isPackaged
      ? [environment.path.join(environment.resourcesPath, "synctex-runtime", binaryName)]
      : environment.resolveResourcePathCandidates(
          environment.path.join("synctex-runtime", binaryName),
        );

  for (const candidate of candidates) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return Option.some(candidate);
    }
  }

  return Option.none<string>();
});

interface ScientBackendEnvInput {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
}

interface ScientLaunchSettings {
  /** The effective "Keep Scient running in the background"; a change applies at the next start. */
  readonly keepsRunningInBackground: boolean;
}

// Matches the server's DESKTOP_BACKGROUND_RUNNING_ENV: while on, unattended Accounts work leaves
// a macOS or Linux keychain that could ask closed until the person's first use.
const backgroundRunningEnv = (launch: ScientLaunchSettings) => ({
  SCIENT_DESKTOP_BACKGROUND_RUNNING: launch.keepsRunningInBackground ? "true" : "false",
});

/** Environment entries the primary backend gets on top of the inherited ones. */
export function scientPrimaryBackendEnv(
  environment: ScientBackendEnvInput,
  launch: ScientLaunchSettings,
) {
  return {
    // Keep the server's derived state directory identical to the
    // desktop-owned data directory. The server still understands
    // T3CODE_HOME for upstream compatibility, but Scient launches use the
    // established Scient compatibility alias explicitly.
    T3CODE_HOME: environment.baseDir,
    SCIENT_NEXT_HOME: environment.baseDir,
    SCIENT_NEXT_DEVELOPMENT_STATE: environment.isDevelopment ? "true" : undefined,
    SCIENT_DEV_SCRATCH_ROOT: environment.isDevelopment
      ? process.env.SCIENT_DEV_SCRATCH_ROOT
      : undefined,
    SCIENT_NEXT_SAFETY_ENVELOPE: SCIENT_DESKTOP_IDENTITY.safetyEnvelopeMarker,
    ...backgroundRunningEnv(launch),
  };
}

/** Environment entries the WSL backend gets on top of the inherited ones. */
export function scientWslBackendEnv(
  environment: Pick<ScientBackendEnvInput, "isDevelopment">,
  launch: ScientLaunchSettings,
) {
  return {
    // Keep WSL state on the Linux filesystem and outside any installed T3
    // home. The server expands this POSIX path against the distro HOME.
    T3CODE_HOME: "~/.scient-next",
    SCIENT_NEXT_HOME: "~/.scient-next",
    SCIENT_NEXT_DEVELOPMENT_STATE: environment.isDevelopment ? "true" : undefined,
    SCIENT_NEXT_SAFETY_ENVELOPE: SCIENT_DESKTOP_IDENTITY.safetyEnvelopeMarker,
    ...backgroundRunningEnv(launch),
  };
}
