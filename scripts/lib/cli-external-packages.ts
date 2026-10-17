/**
 * Three consumers derive from this list, and they must never disagree:
 *
 * - apps/server/vite.config.ts decides what stays external to the bundle.
 * - scripts/build-desktop-artifact.ts selects the runtime dependency roots for
 *   the Windows server sidecar.
 * - scripts/package-scient-server.ts selects the remote tarball runtime roots.
 *
 * as Node resolves it from the emitted bundle. Keeping all consumers on one
 */
/**
 * An external package is loaded from the real filesystem, so its own `require`
 * also resolves from the real filesystem; a dependency that was bundled away
 * exists only inside the emitted bundle and is unreachable there.
 */
export const CLI_RUNTIME_EXTERNAL_PREFIXES = [
  // Cursor ships computed Webpack imports and platform helper packages. Its
  // installed JS dependency tree stays on disk with the SDK. Those dependency
  // names remain bundleable at other providers' locked import resolutions.
  "@cursor/sdk",
  // Playwright reads package.json and browsers.json beside its runtime modules.
  "playwright-core",
  "node-pty",
  // PDF.js loads this native canvas implementation through createRequire at
  // runtime, which the bundler cannot see. Keep the wrapper and its
  // platform-specific packages available on the real filesystem.
  "@napi-rs/canvas",
  // The server loads undici through createRequire to keep fetch on HTTP/1.1 under Node 26
  // (apps/server/src/outboundHttp.ts), which the bundler cannot see.
  "undici",
  "ffi-rs",
  "@yuuang/",
  "@ff-labs/",
  "@napi-rs/keyring",
  "@clerk/electron-passkeys",
  "@msgpackr-extract/",
  "msgpackr-extract",
  "node-gyp-build",
  "node-addon-api",
  // Required by node-gyp-build-optional-packages. Not native, but in the
  // closure: without it, WSL gets MODULE_NOT_FOUND while Windows is fine.
  "detect-libc",
  "bufferutil",
  "utf-8-validate",
] as const;

/**
 * External only so the bundler never has to resolve them.
 *
 * These are reached through a runtime-conditional dynamic import that Node
 * never takes, and they resolve `bun:*` specifiers that do not exist when
 * bundling for Node. Because Node never loads them, their dependency closure
 * does not need to be external — only the entry point must stay unbundled.
 */
export const CLI_BUILD_ONLY_EXTERNAL_PREFIXES = [
  "@effect/platform-bun",
  "@effect/sql-sqlite-bun",
] as const;

export const CLI_EXTERNAL_PACKAGE_PREFIXES = [
  ...CLI_RUNTIME_EXTERNAL_PREFIXES,
  ...CLI_BUILD_ONLY_EXTERNAL_PREFIXES,
] as const;

export function isRuntimeExternalCliDependency(id: string): boolean {
  return CLI_RUNTIME_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * This has to be wired to the bundler's `neverBundle`, not just to
 * `alwaysBundle`. `alwaysBundle` only forces packages IN — returning false from
 * it means "no opinion", and the default then applies: a declared dependency
 * stays external, but a transitive one gets bundled.
 */
export function isExternalCliDependency(id: string): boolean {
  return (
    isRuntimeExternalCliDependency(id) ||
    CLI_BUILD_ONLY_EXTERNAL_PREFIXES.some((prefix) => id.startsWith(prefix))
  );
}

export function shouldBundleCliDependency(id: string): boolean {
  if (id.startsWith("node:")) return false;
  return !isExternalCliDependency(id);
}

export function selectCliRuntimeExternalDependencies(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => isRuntimeExternalCliDependency(name)),
  );
}

/**
 * `regionCount` is reported so the caller can tell "nothing was inlined" apart
 * from "the marker format changed and this scan no longer sees anything".
 */
export function findInlinedExternalPackages(source: string): {
  readonly regionCount: number;
  readonly inlined: ReadonlyArray<string>;
  readonly inlinedPackages: ReadonlyArray<string>;
} {
  // Rolldown marks each inlined module with a `//#region <path>` comment.
  const regionPattern = /\/\/#region\s+(\S+)/g;
  const packagePattern = /node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g;

  let regionCount = 0;
  const inlined = new Set<string>();
  const inlinedPackages = new Set<string>();
  for (const region of source.matchAll(regionPattern)) {
    regionCount += 1;
    const regionPath = region[1] ?? "";
    for (const candidate of regionPath.matchAll(packagePattern)) {
      const name = candidate[1];
      if (name === undefined || name === ".pnpm") continue;
      inlinedPackages.add(name);
      if (isExternalCliDependency(name)) inlined.add(name);
    }
  }

  return {
    regionCount,
    inlined: [...inlined].sort(),
    inlinedPackages: [...inlinedPackages].sort(),
  };
}
