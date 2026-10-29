/** Keep bundler externals and staged runtime dependency roots aligned. */
// Filesystem-loaded externals need dependencies outside the bundle.
const CLI_RUNTIME_EXTERNAL_PREFIXES = [
  // Cursor ships computed Webpack imports and platform helper packages.
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
  // SCIENT-FORK:START — Scient Accounts: the 1Password SDK loads WASM and native libraries from disk.
  "@1password/",
  // SCIENT-FORK:END
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
 * Node never takes these conditional imports, but their bun:* specifiers cannot resolve during bundling.
 * Externalize only the entry point; their unused dependency closure need not stay on disk.
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

/** Use neverBundle: false from alwaysBundle means no opinion and leaves transitive packages bundled. */
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

/** regionCount distinguishes a clean bundle from a changed marker format the scan cannot see. */
export function findInlinedExternalPackages(source: string): {
  readonly regionCount: number;
  readonly inlined: ReadonlyArray<string>;
  readonly inlinedPackages: ReadonlyArray<string>;
} {
  // Rolldown marks each inlined module with a `//#region <path>` line; newer
  // releases (vite-plus 1.4) emit a bare `// <path>` line instead.
  const regionPattern = /^\/\/(?:#region)?[ \t]+(\S+)[ \t]*$/gm;
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
