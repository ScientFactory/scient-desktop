/**
 * Running the Scient-managed `wacli`: a minimal environment pinned to Scient's store, bounded
 * one-shot commands, and long-running commands whose `--events` lines are handed over as they
 * arrive. Interruption kills the process. See docs/internals/scient-whatsapp.md.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { parseWacliEvent, type WacliEvent } from "./wacliEvents.ts";

// Enough to run, resolve names, reach WhatsApp (proxies, certificates) and find temp space;
// nothing of Scient's own (tokens, keys) and no WACLI_* the user set for their own wacli.
const PASSED_THROUGH = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

export function wacliEnvironment(input: {
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly storeDir: string;
  readonly deviceLabel: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSED_THROUGH) {
    const value = input.hostEnvironment[key];
    if (value !== undefined) env[key] = value;
  }
  env.WACLI_STORE_DIR = input.storeDir;
  env.WACLI_DEVICE_LABEL = input.deviceLabel;
  env.WACLI_DEVICE_PLATFORM = "DESKTOP";
  return env;
}

export class WacliProcessError extends Schema.TaggedError<WacliProcessError>()(
  "WacliProcessError",
  {
    reason: Schema.Literals(["failed", "timed-out", "output-limit"]),
    /** The wacli subcommand, e.g. `chats list`; never its arguments. */
    command: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "timed-out":
        return `wacli ${this.command} did not finish in time.`;
      case "output-limit":
        return `wacli ${this.command} printed more output than Scient reads.`;
      case "failed":
        return `wacli ${this.command} could not be run.`;
    }
  }
}

export interface WacliCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  /** For errors and logs: the subcommand, never user-supplied arguments. */
  readonly command: string;
}

const STDERR_TAIL_CHARS = 64 * 1024;

const spawnWacli = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: WacliCommand,
) =>
  spawner
    .spawn(
      ChildProcess.make(input.executable, [...input.args], {
        env: input.env,
        extendEnv: false,
        shell: false,
        detached: false,
        windowsHide: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        forceKillAfter: "3 seconds",
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) => new WacliProcessError({ reason: "failed", command: input.command, cause }),
      ),
    );

export interface WacliOutput {
  readonly exitCode: number;
  readonly stdout: string;
  /** The last 64 KiB of stderr. */
  readonly stderr: string;
}

/** One bounded command: stdout past `maxStdoutBytes` or a run past `timeout` kills it. */
export const runWacli = Effect.fn("WhatsApp.runWacli")(function* (
  input: WacliCommand & { readonly timeout: Duration.Input; readonly maxStdoutBytes: number },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failed = (cause: unknown) =>
    new WacliProcessError({ reason: "failed", command: input.command, cause });
  const run = Effect.gen(function* () {
    const child = yield* spawnWacli(spawner, input);
    const decoder = new TextDecoder();
    let stdoutText = "";
    let stdoutBytes = 0;
    const stdout = child.stdout.pipe(
      Stream.mapError(failed),
      Stream.runForEach((chunk) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > input.maxStdoutBytes) {
          return Effect.fail(
            new WacliProcessError({ reason: "output-limit", command: input.command }),
          );
        }
        stdoutText += decoder.decode(chunk, { stream: true });
        return Effect.void;
      }),
    );
    const stderr = child.stderr.pipe(
      Stream.decodeText(),
      Stream.mapError(failed),
      Stream.runFold(
        () => "",
        (tail, text) => (tail + text).slice(-STDERR_TAIL_CHARS),
      ),
    );
    const [, stderrText, exitCode] = yield* Effect.all(
      [stdout, stderr, child.exitCode.pipe(Effect.mapError(failed))],
      { concurrency: "unbounded" },
    );
    return {
      exitCode: Number(exitCode),
      stdout: stdoutText + decoder.decode(),
      stderr: stderrText,
    } satisfies WacliOutput;
  }).pipe(Effect.scoped);
  return yield* run.pipe(
    Effect.timeoutOrElse({
      duration: input.timeout,
      orElse: () =>
        Effect.fail(new WacliProcessError({ reason: "timed-out", command: input.command })),
    }),
  );
});

/**
 * A long-running command (`auth`, `sync --follow`): each `--events` line goes to `onEvent` in
 * order, and the exit code returns after the last one. Its span covers the whole run.
 */
export const runWacliWithEvents = Effect.fn("WhatsApp.runWacliWithEvents")(function* <R>(
  input: WacliCommand & { readonly onEvent: (event: WacliEvent) => Effect.Effect<void, never, R> },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failed = (cause: unknown) =>
    new WacliProcessError({ reason: "failed", command: input.command, cause });
  return yield* Effect.gen(function* () {
    const child = yield* spawnWacli(spawner, input);
    const events = child.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapError(failed),
      Stream.runForEach((line) => {
        const event = parseWacliEvent(line);
        return event === undefined ? Effect.void : input.onEvent(event);
      }),
    );
    // stdout carries nothing Scient reads, but an unread pipe would stall wacli once full.
    const drain = child.stdout.pipe(Stream.mapError(failed), Stream.runDrain);
    const [, , exitCode] = yield* Effect.all(
      [events, drain, child.exitCode.pipe(Effect.mapError(failed))],
      { concurrency: "unbounded" },
    );
    return Number(exitCode);
  }).pipe(Effect.scoped);
});
