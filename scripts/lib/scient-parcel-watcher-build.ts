type BuildPlatform = "linux" | "mac" | "win";
type BuildArch = "arm64" | "x64" | "universal";

/**
 * Compute's project watch loads `@parcel/watcher-<os>-<arch>[-libc]` at runtime. Packaging
 * drops pnpm-nested optional packages, so stages ship the target's as roots, as fff's are.
 */
export function resolveParcelWatcherNativeDependencies(
  platform: BuildPlatform,
  arch: BuildArch,
  version: string | undefined,
): Record<string, string> {
  if (version === undefined) return {};
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];
  const names =
    platform === "mac"
      ? architectures.map((architecture) => `@parcel/watcher-darwin-${architecture}`)
      : platform === "win"
        ? architectures.map((architecture) => `@parcel/watcher-win32-${architecture}`)
        : architectures.flatMap((architecture) =>
            ["glibc", "musl"].map((libc) => `@parcel/watcher-linux-${architecture}-${libc}`),
          );
  return Object.fromEntries(names.map((name) => [name, version]));
}
