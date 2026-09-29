import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as ByteSize from "effect/ByteSize";
import * as Cause from "effect/Cause";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { OMP_MINIMUM_VERSION, OMP_SUPPORTED_MAJOR } from "@scientfactory/provider-runtime";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import type { ModelConnectionReadiness } from "@t3tools/contracts";
import type { OmpRpcModel } from "effect-omp-rpc/schema";

import { makeOmpRpcClient, type OmpRpcClient, type OmpRpcFrameTrace } from "effect-omp-rpc/client";
import { OmpRpcProtocolError, type OmpRpcError } from "effect-omp-rpc/errors";

import { spawnAndCollect } from "../providerSnapshot.ts";
import { OMP_SESSION_DIR_ENV } from "./OmpEnvironment.ts";
import type { OmpModelRefreshError } from "./OmpModel.ts";
import {
  canonicalOmpExecutablePath,
  OmpExecutableGate,
  type OmpExecutableActivation,
} from "./OmpExecutableGate.ts";

const isProtocolError = Schema.is(OmpRpcProtocolError);

export { OMP_MINIMUM_VERSION };

/** RPC package errors stay product-neutral. User-facing text names Oh My Pi once. */
export const ompUserDetail = (detail: string): string =>
  detail.includes("Oh My Pi") ? detail : `Oh My Pi: ${detail}`;
export const OMP_RPC_ARGS = ["--mode", "rpc", "--approval-mode", "yolo"] as const;

export const ompRpcArgs = (
  sessionDir?: string,
  extraArgs: ReadonlyArray<string> = [],
): ReadonlyArray<string> => [
  ...OMP_RPC_ARGS,
  ...(sessionDir ? ["--session-dir", sessionDir] : []),
  ...extraArgs,
];
/**
 * Verified against oh-my-pi v18.2.8 `packages/coding-agent/src/cli/flag-tables.ts`.
 * `--no-session --no-tools` alone does not disable extension discovery.
 */
export const OMP_ISOLATED_ARGS = [
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
] as const;

/** How long a closed-stdin child gets to exit on its own before it is killed. */
const OMP_SHUTDOWN_GRACE = "2 seconds";
/**
 * How long stdout may stay open after the child exited. Output the child
 * wrote before exiting still drains; a descendant that inherited the pipe
 * cannot hide the exit past this.
 */
const OMP_EXITED_STDOUT_GRACE = "1 second";
/** A follower never waits longer than the leader's grace, kill, and reap steps. */
const OMP_SHUTDOWN_FOLLOWER_DEADLINE = "8 seconds";
const versionCacheKey = (
  identity: string,
  env: Readonly<Record<string, string | undefined>>,
  binaryMetadata: string,
): string =>
  JSON.stringify([
    identity,
    binaryMetadata,
    env.PATH ?? "",
    env.HOME ?? "",
    env.USERPROFILE ?? "",
    env.PI_CODING_AGENT_DIR ?? "",
    env.OMP_PROFILE ?? "",
    env.PI_PROFILE ?? "",
  ]);

export interface OmpRpcProcessOptions {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly sessionDir?: string;
  readonly extraArgs?: ReadonlyArray<string>;
  /**
   * A managed-runtime activation qualifying its own staged executable. Every
   * other process waits for an activation that holds its executable.
   */
  readonly executableActivation?: OmpExecutableActivation | undefined;
  /**
   * Observes every command written and every `ready` and `response` frame
   * read, already redacted with `redactOmpLogValue` and this process's
   * environment. Failures and defects are dropped.
   */
  readonly onFrame?: ((trace: OmpRpcFrameTrace) => Effect.Effect<void>) | undefined;
  /**
   * Secrets this process knows through a bootstrap file rather than its
   * environment (Scient's MCP bearer, custom-model keys and endpoint token).
   * Diagnostics and logged frames redact them like credential variables.
   */
  readonly secrets?: ReadonlyArray<string | null | undefined> | undefined;
}

export interface OmpProcessExit {
  readonly code: number | null;
  readonly forced: boolean;
  readonly stderrTail: string;
}

export interface OmpRpcProcess extends OmpRpcClient {
  readonly version: string;
  readonly shutdown: Effect.Effect<OmpProcessExit, OmpRpcError>;
  /**
   * This process's redaction, for every string a caller derives from its
   * events or errors. Covers the secrets in `OmpRpcProcessOptions.secrets`.
   */
  readonly redaction: OmpRedaction;
  /** Optional server-side projection for shared custom-model readiness. */
  readonly assessModelConnections?: (
    models: ReadonlyArray<OmpRpcModel>,
  ) => ReadonlyArray<ModelConnectionReadiness>;
  /**
   * Custom-model bridge only: the name of the Scient model connection an Oh
   * My Pi provider id stands for, so the model list shows it instead of the id.
   */
  readonly modelProviderLabel?: (provider: string) => string | undefined;
  /**
   * Custom-model bridge only: re-read Scient's model connections and wait
   * until Oh My Pi acknowledges it has registered them.
   */
  readonly refreshModels?: () => Effect.Effect<void, OmpRpcError | OmpModelRefreshError>;
}

const parseOmpVersion = (output: string): string | undefined =>
  output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u)?.[0];

const childEnv = (
  env: Readonly<Record<string, string | undefined>> | undefined,
  sessionDir: string | undefined,
): Record<string, string> => {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) next[key] = value;
  }
  if (sessionDir) next[OMP_SESSION_DIR_ENV] = sessionDir;
  else delete next[OMP_SESSION_DIR_ENV];
  return next;
};

const OMP_STDERR_TAIL_CHARS = 4096;
/** Longest unterminated stderr line held back for redaction. */
const OMP_STDERR_PENDING_CHARS = 8192;

/** Redact credentials, bearer tokens, and the home path from diagnostic text. */
const redactOmpText = (
  text: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
): string => {
  let next = text;
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!value || value.length < 4) continue;
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|COOKIE|CREDENTIAL|API)/iu.test(key)) {
      next = next.split(value).join("[REDACTED]");
    }
  }
  for (const key of ["HOME", "USERPROFILE"] as const) {
    const value = env?.[key];
    if (value && value.length > 1) next = next.split(value).join("~");
  }
  return next
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&\s]+/giu, "$1[REDACTED]");
};

/** Field names whose values are credentials wherever they appear. */
const OMP_SECRET_FIELD =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passphrase|authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|credentials?|x[_-]api[_-]key)$/iu;
const OMP_LOG_MAX_DEPTH = 32;

/**
 * A copy of an Oh My Pi frame or notification that is safe to persist:
 * credential fields are replaced, text is redacted like diagnostics (bearer
 * tokens, key-shaped strings, and the values of credential variables in
 * `env`), image data is replaced by its length, and the value a user typed
 * into an extension UI prompt (which may be an API key) is not kept.
 */
/**
 * The environment redaction works from: the child environment plus each known
 * secret under a credential-shaped name, so its value is redacted wherever it
 * appears.
 */
const OMP_REDACTED_TOKEN_PREFIX = "SCIENT_REDACTED_TOKEN_";

export const ompRedactionEnvironment = (
  env: Readonly<Record<string, string | undefined>> | undefined,
  secrets: ReadonlyArray<string | null | undefined> | undefined,
): Readonly<Record<string, string | undefined>> => {
  const next: Record<string, string | undefined> = { ...env };
  for (const [index, secret] of (secrets ?? []).entries()) {
    if (!secret) continue;
    next[`${OMP_REDACTED_TOKEN_PREFIX}${index}`] = secret;
    // An authorization header also redacts its bare credential.
    const bare = /^(?:Bearer|Basic)\s+(.+)$/iu.exec(secret)?.[1];
    if (bare) next[`${OMP_REDACTED_TOKEN_PREFIX}${index}_BARE`] = bare;
  }
  return next;
};

export const redactOmpLogValue = (
  value: unknown,
  env: Readonly<Record<string, string | undefined>> | undefined,
): unknown => {
  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") return redactOmpText(current, env);
    if (typeof current !== "object" || current === null) return current;
    if (depth >= OMP_LOG_MAX_DEPTH) return "[depth limit]";
    if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));
    const record = current as Record<string, unknown>;
    const image =
      record.type === "image" ||
      (typeof record.mimeType === "string" && record.mimeType.startsWith("image/"));
    const typedAnswer = record.type === "extension_ui_response";
    const next: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(record)) {
      if (field !== null && field !== undefined && OMP_SECRET_FIELD.test(key)) {
        next[key] = "[REDACTED]";
      } else if (image && key === "data" && typeof field === "string") {
        next[key] = { omittedBase64Characters: field.length };
      } else if (typedAnswer && key === "value" && typeof field === "string") {
        next[key] = { omittedCharacters: field.length };
      } else {
        next[key] = visit(field, depth + 1);
      }
    }
    return next;
  };
  return visit(value, 0);
};

export const redactOmpDiagnostic = (
  tail: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
): string => redactOmpText(tail, env).slice(-OMP_STDERR_TAIL_CHARS);

/**
 * Shortest secret replaced in ordinary content. A local endpoint's placeholder
 * key ("ollama", "none") would otherwise erase that word from every message;
 * diagnostic text still redacts it.
 */
const OMP_EXACT_SECRET_MIN_CHARS = 12;
/** Environment variables whose whole value is a credential. */
const OMP_EXACT_SECRET_NAME = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/iu;

/**
 * Everything one Oh My Pi process knows that must not leave it: the
 * credentials in its environment and the secrets it was given through a
 * bootstrap file (Scient's MCP bearer, custom-model keys, the models endpoint
 * token). The set is fixed for the life of the process: a changed key retires
 * the process and a new one starts with the new set.
 */
export interface OmpRedaction {
  /**
   * Text that can carry a provider's error (turn errors, retry and extension
   * warnings, stderr, failed commands): redacted like diagnostics.
   */
  readonly text: (text: string) => string;
  /** A frame or notification made safe to persist, as `redactOmpLogValue`. */
  readonly log: (value: unknown) => unknown;
  /**
   * Any value with each exact secret replaced in its strings and nothing else
   * changed, for ordinary content such as assistant text and tool output.
   * Returns `value` itself when it holds no secret.
   */
  readonly exact: <A>(value: A) => A;
}

export const makeOmpRedaction = (
  env: Readonly<Record<string, string | undefined>> | undefined,
  secrets: ReadonlyArray<string | null | undefined> | undefined,
): OmpRedaction => {
  const redactionEnv = ompRedactionEnvironment(env, secrets);
  const exactSet = new Set<string>();
  for (const [key, value] of Object.entries(redactionEnv)) {
    if (value === undefined || value.length < OMP_EXACT_SECRET_MIN_CHARS) continue;
    if (key.startsWith(OMP_REDACTED_TOKEN_PREFIX) || OMP_EXACT_SECRET_NAME.test(key)) {
      exactSet.add(value);
    }
  }
  // Longest first, so an authorization header goes before its bare token.
  const exactValues = [...exactSet].toSorted((left, right) => right.length - left.length);
  const replace = (text: string): string => {
    let next = text;
    for (const secret of exactValues) {
      if (next.includes(secret)) next = next.split(secret).join("[REDACTED]");
    }
    return next;
  };
  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") return replace(current);
    if (typeof current !== "object" || current === null) return current;
    if (depth >= OMP_LOG_MAX_DEPTH) {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(current);
      } catch {
        serialized = undefined;
      }
      return serialized === undefined || replace(serialized) !== serialized
        ? "[depth limit]"
        : current;
    }
    if (Array.isArray(current)) {
      const next = current.map((item) => visit(item, depth + 1));
      return next.some((item, index) => item !== current[index]) ? next : current;
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(current)) {
      const visited = visit(field, depth + 1);
      if (visited !== field) changed = true;
      next[key] = visited;
    }
    return changed ? next : current;
  };
  return {
    text: (text) => redactOmpText(text, redactionEnv),
    log: (value) => redactOmpLogValue(value, redactionEnv),
    exact: <A>(value: A): A => (exactValues.length === 0 ? value : (visit(value, 0) as A)),
  };
};

/**
 * A bounded stderr tail that is redacted before it is truncated. Complete
 * lines are redacted as they arrive and only then appended to the tail, so a
 * truncation can never cut a credential in half and leave a fragment the
 * redaction no longer recognizes. The unterminated last line waits in
 * `pending` for the chunk that completes it.
 */
export interface OmpStderrTail {
  readonly redacted: string;
  readonly pending: string;
  /** Dropping a whitespace-free run that was too long to hold, until it ends. */
  readonly skipping: boolean;
}

export const emptyOmpStderrTail: OmpStderrTail = { redacted: "", pending: "", skipping: false };

export const appendOmpStderr = (
  state: OmpStderrTail,
  chunk: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
): OmpStderrTail => {
  let text = state.pending + chunk;
  let redacted = state.redacted;
  if (state.skipping) {
    const end = text.search(/\s/u);
    if (end === -1) return state;
    text = text.slice(end);
  }
  let split = text.lastIndexOf("\n") + 1;
  if (text.length - split > OMP_STDERR_PENDING_CHARS) {
    // A very long unterminated line: flush it up to its last whitespace. A
    // whitespace-free run that long is dropped rather than cut into pieces.
    const lastSpace = text.search(/\s\S*$/u);
    if (lastSpace >= split) split = lastSpace + 1;
    else {
      redacted = `${redacted}${redactOmpText(text.slice(0, split), env)}[stderr output omitted]`;
      return {
        redacted: redacted.slice(-OMP_STDERR_TAIL_CHARS),
        pending: "",
        skipping: true,
      };
    }
  }
  if (split > 0) redacted = `${redacted}${redactOmpText(text.slice(0, split), env)}`;
  return {
    redacted: redacted.slice(-OMP_STDERR_TAIL_CHARS),
    pending: text.slice(split),
    skipping: false,
  };
};

/** The final tail, including a last line that never ended. */
export const ompStderrTail = (
  state: OmpStderrTail,
  env: Readonly<Record<string, string | undefined>> | undefined,
): string =>
  `${state.redacted}${state.skipping ? "" : redactOmpText(state.pending, env)}`.slice(
    -OMP_STDERR_TAIL_CHARS,
  );

export const makeOmpRpcProcess = Effect.fn("makeOmpRpcProcess")(function* (
  options: OmpRpcProcessOptions,
): Effect.fn.Return<
  OmpRpcProcess,
  OmpRpcError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
  | OmpExecutableGate
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const fs = yield* FileSystem.FileSystem;
  const env = childEnv(options.env, options.sessionDir);
  // Redaction also covers secrets that never enter the child environment.
  const redactionEnv = ompRedactionEnvironment(env, options.secrets);
  const redaction = makeOmpRedaction(env, options.secrets);
  const onFrame = options.onFrame;
  // The executable is resolved once. Its real path is the identity the gate
  // leases, and the resolved path is what is probed and spawned, so a PATH
  // change cannot swap the binary between the lease and the spawn.
  const resolvedBinary = yield* resolveCommandPath(options.command, {
    env,
    bypassCache: true,
  }).pipe(Effect.orElseSucceed(() => options.command));
  const executableIdentity = yield* canonicalOmpExecutablePath(resolvedBinary);
  // The gate is a type-level requirement: an ungated process could start
  // while a managed activation replaces its runtime.
  const gate = yield* OmpExecutableGate;
  // The lease comes first and lives as long as the process scope. A managed
  // activation of this executable makes it wait, then fail.
  yield* gate
    .acquireProcess(executableIdentity, {
      kind: options.sessionDir === undefined ? "one-shot" : "session",
      activation: options.executableActivation,
    })
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) => new OmpRpcProtocolError({ detail: ompUserDetail(cause.detail), cause }),
      ),
    );
  const binaryMetadata = yield* fs.stat(executableIdentity).pipe(
    Effect.option,
    Effect.map((info) =>
      Option.match(info, {
        onNone: () => "",
        onSome: (stat) =>
          [
            Option.match(stat.mtime, { onNone: () => "", onSome: (value) => value.toISOString() }),
            ByteSize.toBigInt(stat.size).toString(),
            Option.match(stat.ino, { onNone: () => "", onSome: (value) => String(value) }),
          ].join(":"),
      }),
    ),
  );
  const version = yield* gate
    .verifiedVersion(
      versionCacheKey(executableIdentity, env, binaryMetadata),
      Effect.gen(function* () {
        const command = yield* resolveSpawnCommand(resolvedBinary, ["--version"], {
          env,
          extendEnv: false,
        });
        const result = yield* spawnAndCollect(
          resolvedBinary,
          ChildProcess.make(command.command, command.args, {
            shell: command.shell,
            env,
            extendEnv: false,
          }),
        );
        const parsed = parseOmpVersion(result.stdout);
        if (
          result.code !== 0 ||
          parsed === undefined ||
          compareSemverVersions(parsed, OMP_MINIMUM_VERSION) < 0 ||
          Number(parsed.split(".")[0] ?? "0") !== OMP_SUPPORTED_MAJOR
        ) {
          return yield* new OmpRpcProtocolError({
            detail: `Scient supports Oh My Pi ${OMP_MINIMUM_VERSION} and later ${OMP_SUPPORTED_MAJOR}.x releases. Check the configured executable.`,
          });
        }
        return parsed;
      }),
    )
    .pipe(
      Effect.timeout("4 seconds"),
      Effect.mapError((cause) =>
        isProtocolError(cause)
          ? cause
          : new OmpRpcProtocolError({ detail: "Oh My Pi version verification failed.", cause }),
      ),
    );
  const command = yield* resolveSpawnCommand(
    resolvedBinary,
    ompRpcArgs(options.sessionDir, options.extraArgs),
    { env, extendEnv: false },
  ).pipe(
    Effect.mapError(
      (cause) => new OmpRpcProtocolError({ detail: "Oh My Pi command resolution failed.", cause }),
    ),
  );
  const stdinBytes = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const child = yield* spawner
    .spawn(
      ChildProcess.make(command.command, command.args, {
        shell: command.shell,
        env,
        extendEnv: false,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stdin: { stream: Stream.fromQueue(stdinBytes), endOnDone: true },
        // The spawner starts a detached process group on macOS and Linux, so
        // kill signals that group. Windows stop uses taskkill /T /F.
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) => new OmpRpcProtocolError({ detail: "Failed to start Oh My Pi.", cause }),
      ),
    );
  const stderrTail = yield* Ref.make(emptyOmpStderrTail);
  const stderrDecoder = new TextDecoder("utf-8", { fatal: false });
  // Each chunk is redacted as it arrives, before anything is truncated.
  yield* child.stderr.pipe(
    Stream.map((bytes) => stderrDecoder.decode(bytes, { stream: true })),
    Stream.runForEach((chunk) =>
      Ref.update(stderrTail, (current) => appendOmpStderr(current, chunk, redactionEnv)),
    ),
    Effect.andThen(
      Ref.update(stderrTail, (current) =>
        appendOmpStderr(current, stderrDecoder.decode(), redactionEnv),
      ),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );
  const mapError = (cause: unknown) =>
    new OmpRpcProtocolError({ detail: "Oh My Pi process transport failed.", cause });
  const exitInfo = yield* Deferred.make<OmpProcessExit, OmpRpcError>();
  const shutdownStarted = yield* Ref.make(false);
  const stopChild = Effect.gen(function* () {
    yield* Queue.end(stdinBytes).pipe(Effect.ignore);
    const grace = yield* child.exitCode.pipe(Effect.timeout(OMP_SHUTDOWN_GRACE), Effect.option);
    let forced = false;
    let code: number | null = null;
    if (grace._tag === "Some") {
      code = Number(grace.value);
    } else {
      forced = true;
    }
    // Effect's kill signals the process group on macOS and Linux, and uses
    // `taskkill /T /F` on Windows. A live Oh My Pi child tree has not been verified.
    yield* child.kill({ killSignal: "SIGTERM", forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
    if (grace._tag === "None") {
      const killed = yield* child.exitCode.pipe(Effect.timeout("3 seconds"), Effect.option);
      code = killed._tag === "Some" ? Number(killed.value) : null;
    }
    return {
      code,
      forced,
      stderrTail: ompStderrTail(yield* Ref.get(stderrTail), redactionEnv),
    } satisfies OmpProcessExit;
  });
  /**
   * The first caller leads the shutdown and always completes it, even if that
   * caller is interrupted, so `exitInfo` is always settled. Later callers wait
   * for the leader's result, bounded by the leader's own worst case.
   */
  const shutdown: Effect.Effect<OmpProcessExit, OmpRpcError> = Effect.uninterruptibleMask(
    (restore) =>
      Effect.gen(function* () {
        const leader = yield* Ref.modify(shutdownStarted, (started) => [!started, true] as const);
        if (!leader) {
          return yield* restore(
            Deferred.await(exitInfo).pipe(
              Effect.timeoutOrElse({
                duration: OMP_SHUTDOWN_FOLLOWER_DEADLINE,
                orElse: () =>
                  Effect.succeed<OmpProcessExit>({ code: null, forced: true, stderrTail: "" }),
              }),
            ),
          );
        }
        const exit = yield* Effect.exit(stopChild);
        yield* Deferred.done(exitInfo, exit);
        return yield* exit;
      }),
  );
  // The process never outlives the scope that owns it.
  yield* Scope.addFinalizer(scope, shutdown.pipe(Effect.ignore));
  // Crash detection must not depend on stdout EOF alone: when the child
  // exits, its stdout ends shortly after even if a descendant still holds
  // the pipe, so the client (and every session on it) sees the exit.
  const childExited = child.exitCode.pipe(
    Effect.exit,
    Effect.andThen(Effect.sleep(OMP_EXITED_STDOUT_GRACE)),
  );
  const client = yield* makeOmpRpcClient(
    {
      stdout: child.stdout.pipe(Stream.mapError(mapError), Stream.interruptWhen(childExited)),
      write: (bytes) =>
        Queue.offer(stdinBytes, bytes).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) => new OmpRpcProtocolError({ detail: "Oh My Pi stdin is closed.", cause }),
          ),
        ),
      // The client closes its transport from whichever fiber noticed a fatal
      // protocol error. Run the shutdown in the process scope instead, so that
      // fiber is neither blocked by nor able to interrupt the shutdown.
      close: shutdown.pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid),
    },
    onFrame
      ? {
          onFrame: (trace) =>
            Effect.suspend(() =>
              onFrame({
                direction: trace.direction,
                frame: redactOmpLogValue(trace.frame, redactionEnv) as OmpRpcFrameTrace["frame"],
              }),
            ).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void,
              ),
            ),
        }
      : {},
  );
  return { ...client, version, shutdown, redaction };
});
