import { isCiEnvironment, isDoNotTrackSet } from "@t3tools/shared/otelEnvironment";

/** Packaged availability and release attribution. User consent remains server-owned. */
export const SCIENT_ANALYTICS_METADATA_ENV_NAMES = [
  "SCIENT_ANALYTICS_APP_VERSION",
  "SCIENT_ANALYTICS_BUILD_CHANNEL",
  "SCIENT_ANALYTICS_ENABLED",
] as const;

export function scientAnalyticsMetadata(
  input: {
    readonly appVersion: string;
    readonly isDevelopment: boolean;
    readonly isPackaged: boolean;
  },
  env: Readonly<Record<string, string | undefined>> = {},
): Record<(typeof SCIENT_ANALYTICS_METADATA_ENV_NAMES)[number], string> {
  const version = input.isPackaged && !input.isDevelopment ? input.appVersion : "unknown";
  const channel = input.isDevelopment
    ? "development"
    : /^\d+\.\d+\.\d+$/.test(version)
      ? "stable"
      : /^\d+\.\d+\.\d+-nightly\./.test(version)
        ? "nightly"
        : /^\d+\.\d+\.\d+-(beta|rc)\./.test(version)
          ? "beta"
          : "unknown";
  const enabledOverride = env.SCIENT_ANALYTICS_ENABLED;
  return {
    SCIENT_ANALYTICS_APP_VERSION: version,
    SCIENT_ANALYTICS_BUILD_CHANNEL: channel,
    SCIENT_ANALYTICS_ENABLED: isDoNotTrackSet(env)
      ? "false"
      : enabledOverride === undefined
        ? input.isPackaged && !input.isDevelopment && channel !== "unknown" && !isCiEnvironment(env)
          ? "true"
          : "false"
        : enabledOverride === "true"
          ? "true"
          : "false",
  };
}
