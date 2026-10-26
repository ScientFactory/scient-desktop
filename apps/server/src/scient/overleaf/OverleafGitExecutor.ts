/**
 * Run absolute Git with a fresh environment, neutral identity, bounded output/time, and owned-group
 * cleanup; inherit no hooks/config/credentials/proxies. Hand tokens only through per-command
 * askpass files removed with scratch, never args/URLs/env/logs/errors.
 */
// @effect-diagnostics nodeBuiltinImport:off -- Native child streams need an error listener before stdin writes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeGitScratch } from "./OverleafGitScratch.ts";

const DEFAULT_TIMEOUT: Duration.Input = "2 minutes";
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const STDERR_MAX_BYTES = 256 * 1024;
/** macOS's `xcrun` launcher for the developer tools' Git, never run itself. */
const MACOS_GIT_LAUNCHER = "/usr/bin/git";
const XCODE_SELECT = "/usr/bin/xcode-select";

/** `git merge-tree --write-tree -z` reports conflicts as structured records from this version on. */
export const MINIMUM_GIT_VERSION = [2, 39] as const;

/** Every commit Scient creates for Overleaf carries this identity, never the machine's. */
export const OVERLEAF_COMMIT_IDENTITY = {
  name: "Scient",
  email: "scient@users.noreply.invalid",
} as const;

export const OverleafGitFailureReason = Schema.Literals([
  "git-not-found",
  "git-too-old",
  "spawn-failed",
  "output-limit",
  "timeout",
  "non-zero-exit",
  "runtime-failed",
]);
export type OverleafGitFailureReason = typeof OverleafGitFailureReason.Type;

export class OverleafGitError extends Schema.TaggedError<OverleafGitError>()("OverleafGitError", {
  reason: OverleafGitFailureReason,
  exitCode: Schema.NullOr(Schema.Number),
  /** Git's own error text, truncated. For classification and diagnostics, never shown verbatim. */
  detail: Schema.String,
}) {
  override get message(): string {
    return `Overleaf Git ${this.reason}${this.exitCode === null ? "" : ` (exit ${this.exitCode})`}`;
  }
}
const isOverleafGitError = Schema.is(OverleafGitError);
const fail = (reason: OverleafGitFailureReason, detail = "", exitCode: number | null = null) =>
  new OverleafGitError({ reason, detail, exitCode });

export interface OverleafGitExecuteInput {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: Uint8Array;
  readonly token?: Uint8Array;
  /** A private index file, for building trees without a working tree. */
  readonly indexFile?: string;
  readonly timeout?: Duration.Input;
  readonly maxOutputBytes?: number;
  /** Exit codes other than zero that the caller reads as a result, not a failure. */
  readonly acceptExitCodes?: ReadonlyArray<number>;
}

export interface OverleafGitExecuteResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

export interface OverleafGitAvailability {
  readonly executable: string;
  readonly version: string;
}

function posixAskpassScript(): string {
  return '#!/bin/sh\ncase "$1" in *Username*) printf \'%s\' git ;; *) exec /bin/cat "$SCIENT_OVERLEAF_TOKEN_FILE" ;; esac\n';
}

function windowsAskpassPowerShellScript(): string {
  return "param([string]$Prompt)\nif ($Prompt -match 'Username') { [Console]::Out.Write('git') } else { [Console]::Out.Write([IO.File]::ReadAllText($env:SCIENT_OVERLEAF_TOKEN_FILE)) }\n";
}

function windowsAskpassLauncher(powershell: string, scriptPath: string): string {
  return `@echo off\r\n"${powershell}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" %*\r\n`;
}

/** `git version 2.54.0 (Apple Git-157)` → `[2, 54]`. */
export function parseGitVersion(output: string): readonly [number, number] | null {
  const match = /^git version (\d+)\.(\d+)/u.exec(output.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export function isSupportedGitVersion(version: readonly [number, number]): boolean {
  const [major, minor] = version;
  const [minMajor, minMinor] = MINIMUM_GIT_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * The only environment Git gets. Configuration is passed as `GIT_CONFIG_*`
 * pairs so that no file on the machine can add a credential helper, a hook,
 * a filter, a signing program, or another transport.
 */
export function buildOverleafGitEnvironment(input: {
  readonly home: string;
  readonly temp: string;
  readonly childPath: string;
  readonly hooks: string;
  readonly globalConfig: string;
  readonly globalExcludes: string;
  readonly askpass?: string;
  readonly tokenPath?: string;
  readonly indexFile?: string;
  /** Tests only: allow a local bare repository to stand in for Overleaf. */
  readonly allowLocalProtocols?: boolean;
  readonly windows?: {
    readonly systemRoot: string;
    readonly systemDrive: string;
    readonly comspec: string;
    readonly pathext: string;
    readonly appData: string;
    readonly localAppData: string;
  };
}): Record<string, string> {
  const config = [
    ["credential.helper", ""],
    ["core.hooksPath", input.hooks],
    ["commit.gpgSign", "false"],
    ["tag.gpgSign", "false"],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["protocol.file.allow", input.allowLocalProtocols ? "always" : "never"],
    ["protocol.ext.allow", "never"],
    ["http.followRedirects", "false"],
    ["core.fileMode", "false"],
    ["core.autocrlf", "false"],
    ["core.longpaths", "true"],
    ["core.excludesFile", input.globalExcludes],
    ["core.attributesFile", input.globalExcludes],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
    ["fetch.recurseSubmodules", "false"],
    ["merge.renames", "true"],
    ["merge.directoryRenames", "false"],
    ["merge.conflictStyle", "merge"],
    ["diff.renames", "true"],
    ["advice.detachedHead", "false"],
  ] as const;
  return {
    HOME: input.home,
    XDG_CONFIG_HOME: `${input.home}/.config`,
    PATH: input.childPath,
    TMPDIR: input.temp,
    TEMP: input.temp,
    TMP: input.temp,
    LC_ALL: "C",
    LANG: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS_REQUIRE: "force",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: input.globalConfig,
    GIT_EDITOR: input.windows ? "cmd /c exit 0" : "true",
    GIT_SEQUENCE_EDITOR: input.windows ? "cmd /c exit 0" : "true",
    GIT_AUTHOR_NAME: OVERLEAF_COMMIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: OVERLEAF_COMMIT_IDENTITY.email,
    GIT_COMMITTER_NAME: OVERLEAF_COMMIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: OVERLEAF_COMMIT_IDENTITY.email,
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
    ...(input.askpass === undefined || input.tokenPath === undefined
      ? {}
      : { GIT_ASKPASS: input.askpass, SCIENT_OVERLEAF_TOKEN_FILE: input.tokenPath }),
    ...(input.indexFile === undefined ? {} : { GIT_INDEX_FILE: input.indexFile }),
    ...(input.windows === undefined
      ? {}
      : {
          SystemRoot: input.windows.systemRoot,
          SystemDrive: input.windows.systemDrive,
          COMSPEC: input.windows.comspec,
          PATHEXT: input.windows.pathext,
          APPDATA: input.windows.appData,
          LOCALAPPDATA: input.windows.localAppData,
        }),
  };
}

function concatChunks(chunks: ReadonlyArray<Uint8Array>, total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function pathParts(value: string | undefined, delimiter: string): ReadonlyArray<string> {
  return (value ?? "")
    .split(delimiter)
    .map((part) => part.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
}

interface SpawnInput {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin: Uint8Array;
  readonly maxOutputBytes: number;
  readonly acceptExitCodes: ReadonlyArray<number>;
  readonly timeout: Duration.Input;
  readonly windows: boolean;
}

/**
 * Cancellation kills the owned process group (Windows: taskkill /T /F).
 * Server death can leave Git running; journaled send attempts stay unknown.
 */
const spawnGit = Effect.fnUntraced(function* (input: SpawnInput) {
  let stopAndWait: (() => Promise<void>) | undefined;
  const run = Effect.tryPromise({
    try: (signal) =>
      new Promise<OverleafGitExecuteResult>((resolve, reject) => {
        // The child's stdin is owned here so that EPIPE from a Git that exits
        // before reading its input is always observed.
        const child = NodeChildProcess.spawn(input.executable, [...input.args], {
          cwd: input.cwd,
          env: input.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: !input.windows,
          windowsHide: true,
        });
        const stdoutChunks: Uint8Array[] = [];
        const stderrChunks: Uint8Array[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stopError: OverleafGitError | null = null;
        let spawnError: Error | null = null;
        let closed = false;
        let killed = false;
        let resolveClosed: () => void = () => {};
        const closedPromise = new Promise<void>((resolveClosedPromise) => {
          resolveClosed = resolveClosedPromise;
        });
        const kill = () => {
          if (killed) return;
          killed = true;
          if (child.pid !== undefined && !input.windows) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          } else if (child.pid !== undefined) {
            NodeChildProcess.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              timeout: 5_000,
            });
            child.kill("SIGKILL");
          }
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
        };
        stopAndWait = async () => {
          if (!closed) kill();
          await closedPromise;
        };
        const aborted = () => kill();
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();

        child.stdin.on("error", () => {});
        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > input.maxOutputBytes) {
            if (stopError === null) {
              stopError = fail(
                "output-limit",
                `Git produced more than ${String(input.maxOutputBytes)} bytes.`,
              );
              kill();
            }
          } else {
            stdoutChunks.push(Uint8Array.from(chunk));
          }
        });
        child.stdout.on("error", () => {});
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderrBytes < STDERR_MAX_BYTES) {
            const kept = chunk.subarray(0, STDERR_MAX_BYTES - stderrBytes);
            stderrChunks.push(Uint8Array.from(kept));
            stderrBytes += kept.byteLength;
          }
        });
        child.stderr.on("error", () => {});
        child.on("error", (error: Error) => {
          spawnError = error;
        });
        child.on("close", (code) => {
          if (closed) return;
          closed = true;
          resolveClosed();
          signal.removeEventListener("abort", aborted);
          const stderr = new TextDecoder().decode(concatChunks(stderrChunks, stderrBytes));
          if (stopError !== null) return reject(stopError);
          if (spawnError !== null) return reject(fail("spawn-failed", spawnError.message));
          if (code === null) return reject(fail("runtime-failed", stderr.trim()));
          if (code !== 0 && !input.acceptExitCodes.includes(code)) {
            return reject(fail("non-zero-exit", stderr.trim(), code));
          }
          resolve({ exitCode: code, stdout: concatChunks(stdoutChunks, stdoutBytes), stderr });
        });
        child.stdin.end(input.stdin);
      }),
    catch: (cause) =>
      isOverleafGitError(cause)
        ? cause
        : fail("spawn-failed", cause instanceof Error ? cause.message : String(cause)),
  });
  const timeout = Duration.fromInputUnsafe(input.timeout);
  return yield* Effect.acquireUseRelease(
    Effect.void,
    () =>
      run.pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap((result) =>
          Effect.fromOption(result, () =>
            fail("timeout", `Git did not finish within ${Duration.format(timeout)}.`),
          ),
        ),
      ),
    () => Effect.promise(() => stopAndWait?.() ?? Promise.resolve()),
  );
});

export interface OverleafGitExecutorOptions {
  /** Private directory for per-command scratch space; created on demand. */
  readonly runtimeRoot: string;
  /** Tests only. */
  readonly allowLocalProtocols?: boolean;
}

export class OverleafGitExecutor extends Context.Service<
  OverleafGitExecutor,
  {
    /** Locates Git and checks its version once. Fails when Git is missing or too old. */
    readonly availability: Effect.Effect<OverleafGitAvailability, OverleafGitError>;
    readonly execute: (
      input: OverleafGitExecuteInput,
    ) => Effect.Effect<OverleafGitExecuteResult, OverleafGitError>;
  }
>()("t3/scient/overleaf/OverleafGitExecutor") {}

export const make = Effect.fn("OverleafGitExecutor.make")(function* (
  options: OverleafGitExecutorOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  const windows = platform === "win32";
  const systemRoot = hostEnvironment.SystemRoot ?? hostEnvironment.SYSTEMROOT ?? "C:\\Windows";
  const systemDrive = hostEnvironment.SystemDrive ?? "C:";
  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));

  /** The real Git of the selected developer tools on macOS, or null. Never the
   * `/usr/bin/git` launcher: it runs `xcrun` per call and, with each command's
   * fresh `HOME`, rewrites a shared database or opens an installer dialog. */
  const developerGit = Effect.gen(function* () {
    const selected = yield* Effect.promise(
      () =>
        new Promise<string | null>((resolve) =>
          NodeChildProcess.execFile(
            XCODE_SELECT,
            ["-p"],
            { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000, windowsHide: true },
            (error, stdout) => resolve(error === null ? stdout.trim() : null),
          ),
        ),
    );
    for (const developer of [
      ...(selected !== null && path.isAbsolute(selected) ? [selected] : []),
      "/Library/Developer/CommandLineTools",
      "/Applications/Xcode.app/Contents/Developer",
    ]) {
      const candidate = path.join(developer, "usr", "bin", "git");
      if (candidate !== MACOS_GIT_LAUNCHER && (yield* exists(candidate))) return candidate;
    }
    return null;
  });

  const candidates = Effect.gen(function* () {
    const directories = pathParts(
      hostEnvironment.PATH ?? hostEnvironment.Path,
      windows ? ";" : ":",
    );
    const found = directories.map((directory) => path.join(directory, windows ? "git.exe" : "git"));
    if (windows) {
      found.push(
        path.join(systemDrive, "Program Files", "Git", "cmd", "git.exe"),
        path.join(systemDrive, "Program Files", "Git", "bin", "git.exe"),
      );
    } else {
      found.push(MACOS_GIT_LAUNCHER, "/usr/local/bin/git");
      if (platform === "darwin") found.push("/opt/homebrew/bin/git");
    }
    const resolved: string[] = [];
    for (const candidate of found) {
      if (!path.isAbsolute(candidate) || !(yield* exists(candidate))) continue;
      const executable =
        platform === "darwin" && path.resolve(candidate) === MACOS_GIT_LAUNCHER
          ? yield* developerGit
          : path.resolve(candidate);
      if (executable === null || resolved.includes(executable)) continue;
      const stat = yield* fs.stat(executable).pipe(Effect.option);
      if (stat._tag === "Some" && stat.value.type === "File") resolved.push(executable);
    }
    return resolved;
  });

  const scratchReady = yield* Effect.tryPromise(() =>
    makeGitScratch(options.runtimeRoot, windows),
  ).pipe(
    Effect.mapError((cause) =>
      fail(
        "runtime-failed",
        cause instanceof Error ? cause.message : "Could not prepare private Git scratch space.",
      ),
    ),
    Effect.result,
  );

  const runIn = Effect.fnUntraced(function* (executable: string, input: OverleafGitExecuteInput) {
    const scratchRoot = yield* Effect.fromResult(scratchReady);
    const gitDirectory = path.dirname(executable);
    const gitRoot =
      windows && ["cmd", "bin"].includes(path.basename(gitDirectory).toLowerCase())
        ? path.dirname(gitDirectory)
        : gitDirectory;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const scratch = yield* Effect.acquireRelease(
          Effect.tryPromise(() => scratchRoot.create()),
          (directory) =>
            Effect.promise(() => scratchRoot.remove(directory)).pipe(Effect.ignoreCause()),
        );
        const home = path.join(scratch, "home");
        const temp = path.join(scratch, "tmp");
        const hooks = path.join(scratch, "hooks-disabled");
        const globalConfig = path.join(scratch, "gitconfig");
        const globalExcludes = path.join(scratch, "empty");
        const tokenPath = path.join(scratch, "token");
        const askpass = path.join(scratch, windows ? "askpass.cmd" : "askpass.sh");
        yield* Effect.forEach(
          [home, temp, hooks],
          (directory) => fs.makeDirectory(directory, { recursive: true }),
          { discard: true },
        );
        yield* fs.writeFileString(globalConfig, "");
        yield* fs.writeFileString(globalExcludes, "");
        if (input.token !== undefined) {
          yield* fs.writeFile(tokenPath, input.token, { flag: "wx", mode: 0o600 });
          if (windows) {
            const scriptPath = path.join(scratch, "askpass.ps1");
            const powershell = path.join(
              systemRoot,
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            );
            yield* fs.writeFileString(scriptPath, windowsAskpassPowerShellScript());
            yield* fs.writeFileString(askpass, windowsAskpassLauncher(powershell, scriptPath));
          } else {
            yield* fs.writeFileString(askpass, posixAskpassScript(), { mode: 0o700 });
          }
        }
        const childPath = windows
          ? [
              gitDirectory,
              path.join(gitRoot, "mingw64", "bin"),
              path.join(gitRoot, "mingw64", "libexec", "git-core"),
              path.join(gitRoot, "libexec", "git-core"),
              path.join(systemRoot, "System32"),
            ].join(";")
          : [gitDirectory, "/usr/bin", "/bin"].join(":");
        const env = buildOverleafGitEnvironment({
          home,
          temp,
          childPath,
          hooks,
          globalConfig,
          globalExcludes,
          ...(input.token === undefined ? {} : { askpass, tokenPath }),
          ...(input.indexFile === undefined ? {} : { indexFile: input.indexFile }),
          ...(options.allowLocalProtocols ? { allowLocalProtocols: true } : {}),
          ...(windows
            ? {
                windows: {
                  systemRoot,
                  systemDrive,
                  comspec: hostEnvironment.COMSPEC ?? path.join(systemRoot, "System32", "cmd.exe"),
                  pathext: hostEnvironment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
                  appData: path.join(home, "AppData", "Roaming"),
                  localAppData: path.join(home, "AppData", "Local"),
                },
              }
            : {}),
        });
        return yield* spawnGit({
          executable,
          args: input.args,
          cwd: input.cwd,
          env,
          stdin: input.stdin ?? new Uint8Array(0),
          maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
          acceptExitCodes: input.acceptExitCodes ?? [],
          timeout: input.timeout ?? DEFAULT_TIMEOUT,
          windows,
        });
      }),
    ).pipe(
      Effect.mapError((cause) =>
        isOverleafGitError(cause)
          ? cause
          : fail("runtime-failed", cause instanceof Error ? cause.message : String(cause)),
      ),
    );
  });

  // Only a success is remembered: installing Git later must not need a restart.
  let known: OverleafGitAvailability | null = null;
  const availability = Effect.suspend(() =>
    known !== null
      ? Effect.succeed(known)
      : probe.pipe(Effect.tap((found) => Effect.sync(() => (known = found)))),
  );
  const probe: Effect.Effect<OverleafGitAvailability, OverleafGitError> = Effect.gen(function* () {
    yield* Effect.fromResult(scratchReady);
    let tooOld: OverleafGitError | undefined;
    for (const executable of yield* candidates) {
      const result = yield* runIn(executable, {
        cwd: options.runtimeRoot,
        args: ["--version"],
        timeout: "20 seconds",
      }).pipe(Effect.option);
      if (result._tag === "None") continue;
      const version = new TextDecoder().decode(result.value.stdout).trim();
      const parsed = parseGitVersion(version);
      if (parsed === null) continue;
      if (!isSupportedGitVersion(parsed)) {
        tooOld = fail(
          "git-too-old",
          `Overleaf sync needs Git ${MINIMUM_GIT_VERSION.join(".")} or newer.`,
        );
        continue;
      }
      return { executable, version } satisfies OverleafGitAvailability;
    }
    return yield* tooOld ?? fail("git-not-found", "No working Git executable was found.");
  });

  const execute: OverleafGitExecutor["Service"]["execute"] = Effect.fn(
    "OverleafGitExecutor.execute",
  )(function* (input) {
    const { executable } = yield* availability;
    return yield* runIn(executable, input);
  });

  return OverleafGitExecutor.of({ availability, execute });
});

/** @public */
export const layer = (options: OverleafGitExecutorOptions) =>
  Layer.effect(OverleafGitExecutor, make(options));

/** A fresh opaque name for refs and scratch files that must not collide. */
export const newOverleafId = (): string => NodeCrypto.randomUUID();
