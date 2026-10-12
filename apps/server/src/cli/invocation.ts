import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ServerInstallation } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";

type CliRunner = "npx" | "pnpm dlx" | "bunx";

/**
 * How the CLI was launched, judged by where its entry script lives. Each
 * package runner executes out of a distinctive cache/temp layout:
 *
 *   npx      ~/.npm/_npx/<hash>/node_modules/...
 *   pnpm dlx ~/.cache/pnpm/dlx/..., $PNPM_HOME/.pnpm/dlx/...,
 *            or %LOCALAPPDATA%/pnpm-cache/dlx/... on Windows
 *   bunx     ~/.bun/install/cache/... or $TMPDIR/bunx-<uid>-<spec>/...
 *
 * Global installs and repo checkouts match none of these and return null.
 * Detection is best-effort and only describes installation ownership.
 */
function detectCliRunner(entryPath: string): CliRunner | null {
  const path = entryPath.replaceAll("\\", "/");
  if (path.includes("/_npx/")) {
    return "npx";
  }
  if (
    path.includes("/pnpm/dlx/") ||
    path.includes("/.pnpm/dlx/") ||
    path.includes("/pnpm-cache/dlx/")
  ) {
    return "pnpm dlx";
  }
  if (path.includes("/.bun/install/cache/") || path.includes("/bunx-")) {
    return "bunx";
  }
  return null;
}

const InstallManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  bin: Schema.optionalKey(Schema.Struct({ t3: Schema.String })),
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodeInstallManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(InstallManifest));

/** Prove the running package and its global bin belong together before suggesting an update. */
export const resolveServerInstallation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = yield* HostProcess.Arguments;
  const executable = yield* HostProcess.IsExecutable;
  const executablePath = yield* HostProcess.ExecutablePath;
  const platform = yield* HostProcess.Platform;
  const entry = yield* fs.realPath(executable ? executablePath : (args[1] ?? ""));
  const match =
    /^(.*)\/lib\/node_modules\/t3\/(?:dist\/bin\.mjs|bin\/t3\.js|node_modules\/@t3code\/t3-[^/]+\/t3)$/.exec(
      entry,
    );
  if (!match) {
    const runner = detectCliRunner(entry);
    return runner === null
      ? null
      : ({ kind: runner === "pnpm dlx" ? "pnpm-dlx" : runner } satisfies ServerInstallation);
  }
  // A global prefix can contain runner-like names; prove its ownership first.
  // Windows shims and other package managers need their own ownership proof.
  if (platform === "win32") return null;
  const prefix = match[1] || "/";
  if (
    prefix.includes("/node_modules/") ||
    /\/(?:Cellar|Caskroom)\//i.test(prefix) ||
    /\/mise\/installs\/(?!node\/)[^/]+\//.test(prefix)
  )
    return null;

  const packageRoot = path.join(prefix, "lib/node_modules/t3");
  const manifest = yield* fs
    .readFileString(path.join(packageRoot, "package.json"))
    .pipe(Effect.flatMap(decodeInstallManifest));
  if (manifest.name !== "t3" || !manifest.bin) return null;
  const bin = yield* fs.realPath(path.join(packageRoot, manifest.bin.t3));
  const globalBin = yield* fs.realPath(path.join(prefix, "bin/t3"));
  if (globalBin !== bin) return null;
  if (executable) {
    const nativeManifest = yield* fs
      .readFileString(path.join(path.dirname(entry), "package.json"))
      .pipe(Effect.flatMap(decodeInstallManifest));
    if (
      manifest.bin.t3 !== "./bin/t3.js" ||
      manifest.optionalDependencies?.[nativeManifest.name] !== nativeManifest.version ||
      nativeManifest.version !== manifest.version
    )
      return null;
  } else if (bin !== entry) {
    return null;
  }
  return { kind: "npm-global", prefix } satisfies ServerInstallation;
}).pipe(Effect.orElseSucceed(() => null));

/** Quotes `value` for a POSIX shell when it needs it. */
const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * Resolve this installation, never a package download or an unrelated PATH
 * command. Packaged launchers keep AppImage mount handling; script installs
 * retain the running runtime and entry, including private Node installations.
 */
export const resolveCliCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    // Operational snippets use PowerShell on Windows; quoting a path alone
    // produces a string there, not an invocation.
    const quote =
      platform === "win32" ? (value: string) => `'${value.replaceAll("'", "''")}'` : shellWord;
    const invocationPrefix = platform === "win32" ? "& " : "";
    const shim = env.T3CODE_CLI_PATH?.trim();
    if (shim && path.isAbsolute(shim)) {
      const valid = yield* fs.stat(shim).pipe(
        Effect.map(
          (info) => info.type === "File" && (platform === "win32" || (info.mode & 0o111) !== 0),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (valid) return `${invocationPrefix}${[shim, ...args].map(quote).join(" ")}`;
    }

    const cwd = yield* HostProcess.WorkingDirectory;
    const executable = path.resolve(cwd, yield* HostProcess.ExecutablePath);
    if (yield* HostProcess.IsExecutable) {
      return `${invocationPrefix}${[executable, ...args].map(quote).join(" ")}`;
    }
    const entry = (yield* HostProcess.Arguments)[1];
    if (!entry) {
      return yield* Effect.die(new Error("The running CLI has no entry script."));
    }
    const command = `${invocationPrefix}${[executable, path.resolve(cwd, entry), ...args].map(quote).join(" ")}`;
    // Electron launches its GUI unless Node mode is restored after sudo strips
    // the environment. Do not replay watch/debug execArgv from the server.
    if (env.ELECTRON_RUN_AS_NODE !== "1") return command;
    return platform === "win32"
      ? `$env:ELECTRON_RUN_AS_NODE='1'; ${command}`
      : `env ELECTRON_RUN_AS_NODE=1 ${command}`;
  });

/** An absolute invocation stays reachable after sudo resets PATH and HOME. */
export const resolveRootCliCommand = (args: ReadonlyArray<string>) =>
  Effect.map(resolveCliCommand(args), (command) => `sudo ${command}`);
