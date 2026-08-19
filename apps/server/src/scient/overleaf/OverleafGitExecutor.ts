// @effect-diagnostics nodeBuiltinImport:off
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeFSP from "node:fs/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { OverleafStateStore } from "./OverleafStateStore.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export class OverleafGitError extends Schema.TaggedErrorClass<OverleafGitError>()(
  "OverleafGitError",
  {
    reason: Schema.Literals([
      "git-not-found",
      "spawn-failed",
      "output-failed",
      "output-overflow",
      "timeout",
      "non-zero-exit",
      "runtime-failed",
    ]),
    exitCode: Schema.optionalKey(Schema.Number),
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `The isolated Overleaf Git operation failed (${this.reason}).`;
  }
}
const isOverleafGitError = Schema.is(OverleafGitError);

export interface OverleafGitExecuteInput {
  readonly operationId: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly token?: Uint8Array;
  readonly identity?: { readonly name: string; readonly email: string };
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly allowNonZeroExit?: boolean;
  /** Stream stdout to this owned path instead of retaining it in memory. */
  readonly stdoutFile?: string;
}

export interface OverleafGitExecuteResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stdoutBytes: Uint8Array;
  readonly stderr: string;
}

export function windowsAskpassPowerShellScript(): string {
  return "param([string]$Prompt)\nif ($Prompt -match 'Username') { [Console]::Out.Write('git') } else { [Console]::Out.Write([IO.File]::ReadAllText($env:SCIENT_OVERLEAF_TOKEN_FILE)) }\n";
}

export function windowsAskpassLauncher(powershell: string, scriptPath: string): string {
  return `@echo off\r\n"${powershell}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" %*\r\n`;
}

export function posixAskpassScript(): string {
  return '#!/bin/sh\ncase "$1" in *Username*) printf \'%s\' git ;; *) exec /bin/cat "$SCIENT_OVERLEAF_TOKEN_FILE" ;; esac\n';
}

export function buildOverleafGitEnvironment(input: {
  readonly home: string;
  readonly temp: string;
  readonly childPath: string;
  readonly hooks: string;
  readonly globalConfig: string;
  readonly globalExcludes: string;
  readonly askpass?: string;
  readonly tokenPath?: string;
  readonly identity?: { readonly name: string; readonly email: string };
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
    ["protocol.file.allow", "never"],
    ["protocol.ext.allow", "never"],
    ["http.followRedirects", "false"],
    ["core.fileMode", "false"],
    ["core.autocrlf", "false"],
    ["core.excludesFile", input.globalExcludes],
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
    ...(input.identity === undefined
      ? {}
      : {
          GIT_AUTHOR_NAME: input.identity.name,
          GIT_AUTHOR_EMAIL: input.identity.email,
          GIT_COMMITTER_NAME: input.identity.name,
          GIT_COMMITTER_EMAIL: input.identity.email,
        }),
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

const firstExisting = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  candidates: ReadonlyArray<string>,
) {
  for (const candidate of candidates)
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
  return null;
});

const collectOutput = Effect.fnUntraced(function* (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maxOutputBytes: number,
) {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  const chunks: Uint8Array[] = [];
  yield* Stream.runForEach(stream, (chunk) =>
    Effect.gen(function* () {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        return yield* new OverleafGitError({
          reason: "output-overflow",
          retryable: false,
        });
      }
      chunks.push(chunk.slice());
      text += decoder.decode(chunk, { stream: true });
    }),
  ).pipe(
    Effect.mapError((cause) =>
      isOverleafGitError(cause)
        ? cause
        : new OverleafGitError({ reason: "output-failed", retryable: true }),
    ),
  );
  text += decoder.decode();
  const binary = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    binary.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text, bytes: binary };
});

const writeOutput = Effect.fnUntraced(function* (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  filePath: string,
  maxOutputBytes: number,
) {
  const handle = yield* Effect.tryPromise({
    try: () => NodeFSP.open(filePath, "wx"),
    catch: () => new OverleafGitError({ reason: "output-failed", retryable: true }),
  });
  let bytes = 0;
  yield* Stream.runForEach(stream, (chunk) =>
    Effect.gen(function* () {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        return yield* new OverleafGitError({ reason: "output-overflow", retryable: false });
      }
      yield* Effect.tryPromise({
        try: () => handle.writeFile(chunk),
        catch: () => new OverleafGitError({ reason: "output-failed", retryable: true }),
      });
    }),
  ).pipe(
    Effect.ensuring(
      Effect.tryPromise({
        try: async () => {
          await handle.sync();
          await handle.close();
        },
        catch: () => new OverleafGitError({ reason: "output-failed", retryable: true }),
      }).pipe(Effect.ignore),
    ),
    Effect.mapError((cause) =>
      isOverleafGitError(cause)
        ? cause
        : new OverleafGitError({ reason: "output-failed", retryable: true }),
    ),
  );
  return { text: "", bytes: new Uint8Array(0) };
});

function pathParts(value: string | undefined, delimiter: string): ReadonlyArray<string> {
  return (value ?? "")
    .split(delimiter)
    .map((part) => part.trim().replace(/^"|"$/gu, ""))
    .filter(Boolean);
}

export class OverleafGitExecutor extends Context.Service<
  OverleafGitExecutor,
  {
    readonly gitExecutable: string;
    readonly execute: (
      input: OverleafGitExecuteInput,
    ) => Effect.Effect<OverleafGitExecuteResult, OverleafGitError>;
  }
>()("t3/scient/overleaf/OverleafGitExecutor") {}

export const make = Effect.fn("OverleafGitExecutor.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = yield* OverleafStateStore;
  const windows = platform === "win32";
  const delimiter = windows ? ";" : ":";
  const extensions = windows ? pathParts(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD", ";") : [""];
  const candidates = pathParts(process.env.PATH, delimiter).flatMap((directory) =>
    extensions.map((extension) => path.join(directory, `git${extension.toLowerCase()}`)),
  );
  if (windows) {
    const systemDrive = process.env.SystemDrive ?? "C:";
    candidates.push(
      path.join(systemDrive, "Program Files", "Git", "cmd", "git.exe"),
      path.join(systemDrive, "Program Files", "Git", "bin", "git.exe"),
    );
  } else {
    candidates.push("/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git");
  }
  const gitExecutable = yield* firstExisting(fs, candidates).pipe(
    Effect.flatMap((candidate) =>
      candidate === null
        ? Effect.fail(new OverleafGitError({ reason: "git-not-found", retryable: false }))
        : Effect.succeed(path.resolve(candidate)),
    ),
  );

  const gitDirectory = path.dirname(gitExecutable);
  const gitRoot =
    windows && ["cmd", "bin"].includes(path.basename(gitDirectory).toLowerCase())
      ? path.dirname(gitDirectory)
      : gitDirectory;

  const execute: OverleafGitExecutor["Service"]["execute"] = Effect.fnUntraced(function* (input) {
    const commandId = yield* state.newId.pipe(
      Effect.mapError(() => new OverleafGitError({ reason: "runtime-failed", retryable: true })),
    );
    const commandDirectory = path.join(state.runtimeRoot, input.operationId, commandId);
    const home = path.join(commandDirectory, "home");
    const temp = path.join(commandDirectory, "tmp");
    const hooks = path.join(commandDirectory, "hooks-disabled");
    const globalConfig = path.join(commandDirectory, "gitconfig");
    const tokenPath = path.join(commandDirectory, "token");
    const powershell = windows
      ? path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        )
      : null;
    const askpass = windows
      ? path.join(commandDirectory, "askpass.cmd")
      : path.join(commandDirectory, "askpass.sh");

    const cleanup = fs.remove(commandDirectory, { recursive: true, force: true }).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: async () => {
            try {
              await NodeFSP.rmdir(path.dirname(commandDirectory));
            } catch (cause) {
              if (
                !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
                  (cause as NodeJS.ErrnoException).code ?? "",
                )
              )
                throw cause;
            }
          },
          catch: () => new OverleafGitError({ reason: "runtime-failed", retryable: true }),
        }).pipe(Effect.ignore),
      ),
      Effect.ignore,
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fs.makeDirectory(commandDirectory, { recursive: true });
        yield* Effect.addFinalizer(() => cleanup);
        yield* fs.makeDirectory(home, { recursive: true });
        yield* fs.makeDirectory(temp, { recursive: true });
        yield* fs.makeDirectory(hooks, { recursive: true });
        yield* fs.writeFileString(globalConfig, "");
        if (input.token !== undefined) {
          yield* fs.writeFile(tokenPath, input.token);
          yield* fs.chmod(tokenPath, 0o600);
          if (windows) {
            const scriptPath = path.join(commandDirectory, "askpass.ps1");
            yield* fs.writeFileString(scriptPath, windowsAskpassPowerShellScript());
            yield* fs.writeFileString(askpass, windowsAskpassLauncher(powershell!, scriptPath));
          } else {
            yield* fs.writeFileString(askpass, posixAskpassScript());
            yield* fs.chmod(askpass, 0o700);
          }
        }
        const windowsSystemRoot = process.env.SystemRoot ?? "C:\\Windows";
        const childPath = windows
          ? [
              gitDirectory,
              path.join(gitRoot, "mingw64", "bin"),
              path.join(gitRoot, "mingw64", "libexec", "git-core"),
              path.join(gitRoot, "libexec", "git-core"),
              path.join(windowsSystemRoot, "System32"),
            ].join(";")
          : [gitDirectory, "/usr/bin", "/bin"].join(":");
        const globalExcludes = path.join(commandDirectory, "global-excludes");
        yield* fs.writeFileString(globalExcludes, "");
        const windowsSystemDrive = process.env.SystemDrive ?? "C:";
        const env = buildOverleafGitEnvironment({
          home,
          temp,
          childPath,
          hooks,
          globalConfig,
          globalExcludes,
          ...(input.token === undefined ? {} : { askpass, tokenPath }),
          ...(input.identity === undefined ? {} : { identity: input.identity }),
          ...(windows
            ? {
                windows: {
                  systemRoot: windowsSystemRoot,
                  systemDrive: windowsSystemDrive,
                  comspec:
                    process.env.COMSPEC ?? path.join(windowsSystemRoot, "System32", "cmd.exe"),
                  pathext: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
                  appData: path.join(home, "AppData", "Roaming"),
                  localAppData: path.join(home, "AppData", "Local"),
                },
              }
            : {}),
        });

        const child = yield* spawner
          .spawn(
            ChildProcess.make(gitExecutable, input.args, {
              cwd: input.cwd,
              env,
              extendEnv: false,
              shell: false,
              detached: !windows,
              killSignal: "SIGTERM",
              forceKillAfter: "5 seconds",
            }),
          )
          .pipe(
            Effect.mapError(
              () => new OverleafGitError({ reason: "spawn-failed", retryable: true }),
            ),
          );
        yield* Effect.addFinalizer(() =>
          child
            .kill({ killSignal: "SIGTERM", forceKillAfter: "5 seconds" })
            .pipe(Effect.andThen(child.exitCode), Effect.ignore),
        );
        const result = Effect.all(
          [
            input.stdoutFile === undefined
              ? collectOutput(child.stdout, input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)
              : writeOutput(
                  child.stdout,
                  input.stdoutFile,
                  input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
                ),
            collectOutput(child.stderr, input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
            child.exitCode.pipe(
              Effect.map(Number),
              Effect.mapError(
                () => new OverleafGitError({ reason: "output-failed", retryable: true }),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const timed = yield* result.pipe(
          Effect.timeoutOption(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        );
        if (Option.isNone(timed)) {
          return yield* new OverleafGitError({ reason: "timeout", retryable: true });
        }
        const [stdout, stderr, exitCode] = timed.value;
        if (exitCode !== 0 && !input.allowNonZeroExit) {
          return yield* new OverleafGitError({
            reason: "non-zero-exit",
            exitCode,
            retryable: true,
          });
        }
        return {
          stdout: stdout.text,
          stdoutBytes: stdout.bytes,
          stderr: stderr.text,
          exitCode,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isOverleafGitError(cause)
            ? cause
            : new OverleafGitError({ reason: "runtime-failed", retryable: true }),
        ),
      ),
    );
  });

  return OverleafGitExecutor.of({ gitExecutable, execute });
});

export const layer = Layer.effect(OverleafGitExecutor, make());
