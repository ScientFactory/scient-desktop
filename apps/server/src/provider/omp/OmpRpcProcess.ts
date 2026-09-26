import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as ByteSize from "effect/ByteSize";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
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
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import type { ModelConnectionReadiness } from "@t3tools/contracts";
import type { OmpRpcModel } from "effect-omp-rpc/schema";

import { makeOmpRpcClient, type OmpRpcClient } from "effect-omp-rpc/client";
import { OmpRpcProtocolError, type OmpRpcError } from "effect-omp-rpc/errors";

import { spawnAndCollect } from "../providerSnapshot.ts";
import { ompBinaryFingerprint } from "./OmpSessionCursor.ts";

const isProtocolError = Schema.is(OmpRpcProtocolError);

export const OMP_MINIMUM_VERSION = "18.2.8";
const OMP_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
/** Agent directory override from oh-my-pi v18.2.8 `packages/utils/src/dirs.ts`. */
export const OMP_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
/** Named profile from the same v18.2.8 resolver. `OMP_PROFILE` wins over `PI_PROFILE`. */
export const OMP_PROFILE_ENV = "OMP_PROFILE";

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

const VERSION_CACHE_MS = 5 * 60 * 1000;
const MAX_VERSION_CACHE_ENTRIES = 128;
const versionCache = new Map<string, { readonly version: string; readonly expiresAt: number }>();
const cacheVersion = (key: string, version: string, now: number): void => {
  for (const [cachedKey, cached] of versionCache) {
    if (cached.expiresAt <= now) versionCache.delete(cachedKey);
  }
  if (!versionCache.has(key) && versionCache.size >= MAX_VERSION_CACHE_ENTRIES) {
    const oldest = versionCache.keys().next().value;
    if (oldest !== undefined) versionCache.delete(oldest);
  }
  versionCache.set(key, { version, expiresAt: now + VERSION_CACHE_MS });
};
const versionCacheKey = (
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  binaryPathFingerprint: string,
  binaryMetadata: string,
): string =>
  JSON.stringify([
    command,
    binaryPathFingerprint,
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
}

export interface OmpProcessExit {
  readonly code: number | null;
  readonly forced: boolean;
  readonly stderrTail: string;
}

export interface OmpRpcProcess extends OmpRpcClient {
  readonly version: string;
  /** Identity of the executable selected by the effective process environment. */
  readonly binaryPathFingerprint: string;
  readonly shutdown: Effect.Effect<OmpProcessExit, OmpRpcError>;
  /** Optional server-side projection for shared custom-model readiness. */
  readonly assessModelConnections?: (
    models: ReadonlyArray<OmpRpcModel>,
  ) => ReadonlyArray<ModelConnectionReadiness>;
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

export const redactOmpDiagnostic = (
  tail: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
): string => {
  let next = tail;
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
  next = next
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&\s]+/giu, "$1[REDACTED]");
  return next.slice(-4096);
};

export const makeOmpRpcProcess = Effect.fn("makeOmpRpcProcess")(function* (
  options: OmpRpcProcessOptions,
): Effect.fn.Return<
  OmpRpcProcess,
  OmpRpcError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const fs = yield* FileSystem.FileSystem;
  const env = childEnv(options.env, options.sessionDir);
  const resolvedBinary = yield* resolveCommandPath(options.command, {
    env,
    bypassCache: true,
  }).pipe(Effect.orElseSucceed(() => options.command));
  const canonicalBinary = yield* fs
    .realPath(resolvedBinary)
    .pipe(Effect.orElseSucceed(() => resolvedBinary));
  const binaryPathFingerprint = ompBinaryFingerprint(canonicalBinary);
  const binaryMetadata = yield* fs.stat(canonicalBinary).pipe(
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
  const now = yield* Clock.currentTimeMillis;
  const cacheKey = versionCacheKey(options.command, env, binaryPathFingerprint, binaryMetadata);
  const cached = versionCache.get(cacheKey);
  const version = yield* Effect.gen(function* () {
    if (cached && cached.expiresAt > now) return cached.version;
    const command = yield* resolveSpawnCommand(options.command, ["--version"], {
      env,
      extendEnv: false,
    });
    const result = yield* spawnAndCollect(
      options.command,
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
      compareSemverVersions(parsed, OMP_MINIMUM_VERSION) < 0
    ) {
      return yield* new OmpRpcProtocolError({
        detail: `Scient requires Oh My Pi ${OMP_MINIMUM_VERSION} or newer. Check the configured executable.`,
      });
    }
    cacheVersion(cacheKey, parsed, now);
    return parsed;
  }).pipe(
    Effect.timeout("4 seconds"),
    Effect.mapError((cause) =>
      isProtocolError(cause)
        ? cause
        : new OmpRpcProtocolError({ detail: "Oh My Pi version verification failed.", cause }),
    ),
  );
  const command = yield* resolveSpawnCommand(
    options.command,
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
  const stderrTail = yield* Ref.make("");
  const stderrDecoder = new TextDecoder("utf-8", { fatal: false });
  yield* child.stderr.pipe(
    Stream.map((bytes) => stderrDecoder.decode(bytes, { stream: true })),
    Stream.runForEach((chunk) =>
      Ref.update(stderrTail, (current) => `${current}${chunk}`.slice(-4096)),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );
  const mapError = (cause: unknown) =>
    new OmpRpcProtocolError({ detail: "Oh My Pi process transport failed.", cause });
  const exitInfo = yield* Deferred.make<OmpProcessExit, OmpRpcError>();
  const shutdownStarted = yield* Ref.make(false);
  const shutdown = Effect.gen(function* () {
    const leader = yield* Ref.modify(shutdownStarted, (started) => [!started, true] as const);
    if (!leader) return yield* Deferred.await(exitInfo);
    const info = yield* Effect.gen(function* () {
      yield* Queue.end(stdinBytes).pipe(Effect.ignore);
      const grace = yield* child.exitCode.pipe(Effect.timeout("2 seconds"), Effect.option);
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
        stderrTail: redactOmpDiagnostic(yield* Ref.get(stderrTail), options.env),
      };
    }).pipe(
      Effect.tap((info) => Deferred.succeed(exitInfo, info)),
      Effect.tapError((error) => Deferred.fail(exitInfo, error)),
    );
    return info;
  });
  const client = yield* makeOmpRpcClient(
    {
      stdout: child.stdout.pipe(Stream.mapError(mapError)),
      write: (bytes) =>
        Queue.offer(stdinBytes, bytes).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) => new OmpRpcProtocolError({ detail: "Oh My Pi stdin is closed.", cause }),
          ),
        ),
      close: shutdown.pipe(Effect.asVoid),
    },
    {},
  );
  return { ...client, version, binaryPathFingerprint, shutdown };
});
