/**
 * Bun shell children inherit the real OS environment even after process.env deletion; env/args
 * cannot carry secrets. Read/delete a private 0600 bootstrap before turns. Cache the initializer
 * result per process/path because extension reloads and in-process subagents run after deletion.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { ompProcessAlive } from "./OmpSessionLock.ts";
import type { OmpTarget } from "./OmpTarget.ts";

export class OmpExtensionFileError extends Schema.TaggedError<OmpExtensionFileError>()(
  "OmpExtensionFileError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Keep only the initializer result, not parsed bootstrap secrets. Repeated extension calls must
 * return that same result or rethrow the first error after the one read/delete.
 */
export const ompExtensionBootstrapPrelude = (target: OmpTarget, bootstrapPath: string): string => `
import { readFileSync as scientReadFileSync, unlinkSync as scientUnlinkSync } from "node:fs";

const SCIENT_BOOTSTRAP_PATH = ${JSON.stringify(bootstrapPath)};

const scientOnce = (initialize) => {
  const key = Symbol.for("scient.omp.extension:" + SCIENT_BOOTSTRAP_PATH);
  if (!Object.hasOwn(globalThis, key)) {
    let bootstrap;
    try {
      bootstrap = JSON.parse(scientReadFileSync(SCIENT_BOOTSTRAP_PATH, "utf8"));
    } catch {
      bootstrap = undefined;
    } finally {
      try {
        scientUnlinkSync(SCIENT_BOOTSTRAP_PATH);
      } catch {}
    }
    let slot;
    try {
      if (typeof bootstrap !== "object" || bootstrap === null) {
        throw new Error(${JSON.stringify(`Scient's ${target.name} bootstrap is unavailable.`)});
      }
      slot = { value: initialize(bootstrap) };
    } catch (error) {
      slot = { error };
    }
    Object.defineProperty(globalThis, key, { value: slot });
  }
  const slot = globalThis[key];
  if ("error" in slot) throw slot.error;
  return slot.value;
};
`;

export interface OmpExtensionFiles {
  readonly extensionPath: string;
  readonly bootstrapPath: string;
  /**
   * Deletes the bootstrap if OMP left it unread, so the credential never
   * outlives start-up, and logs that the extension did not load. Run it once
   * OMP reports ready: every explicit extension loads first.
   */
  readonly discardUnconsumed: Effect.Effect<void>;
}

/**
 * Writes one extension and its bootstrap, both 0600 and exclusive, into an
 * existing private directory. Both files are removed when the scope closes.
 */
export const writeOmpExtensionFiles = Effect.fn("OmpExtensionBootstrap.writeFiles")(
  function* (input: {
    readonly target: OmpTarget;
    readonly directory: string;
    /** Unique within `directory`. */
    readonly name: string;
    readonly source: (bootstrapPath: string) => string;
    readonly bootstrap: Readonly<Record<string, unknown>>;
  }): Effect.fn.Return<
    OmpExtensionFiles,
    OmpExtensionFileError,
    FileSystem.FileSystem | Path.Path | Scope.Scope
  > {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bootstrapPath = path.join(input.directory, `${input.name}.bootstrap.json`);
    const extensionPath = path.join(input.directory, `${input.name}.mjs`);
    const contents = yield* Effect.try({
      try: () => ({
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        bootstrap: JSON.stringify(input.bootstrap),
        source: input.source(bootstrapPath),
      }),
      catch: (cause) =>
        new OmpExtensionFileError({
          detail: `Could not generate Scient's ${input.target.name} extension.`,
          cause,
        }),
    });
    const write = (filePath: string, text: string, detail: string) =>
      Effect.acquireRelease(
        fs
          .writeFileString(filePath, text, { mode: 0o600, flag: "wx" })
          .pipe(Effect.mapError((cause) => new OmpExtensionFileError({ detail, cause }))),
        () => fs.remove(filePath, { force: true }).pipe(Effect.ignore),
      );
    yield* write(
      bootstrapPath,
      contents.bootstrap,
      `Could not write Scient's ${input.target.name} extension bootstrap.`,
    );
    yield* write(
      extensionPath,
      contents.source,
      `Could not write Scient's ${input.target.name} extension.`,
    );
    const discardUnconsumed = fs.exists(bootstrapPath).pipe(
      Effect.orElseSucceed(() => true),
      Effect.flatMap((present) =>
        present
          ? fs
              .remove(bootstrapPath, { force: true })
              .pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.logWarning(
                    `${input.target.name} did not load a Scient extension; its bootstrap was deleted unread.`,
                    { extension: input.name },
                  ),
                ),
              )
          : Effect.void,
      ),
    );
    return { extensionPath, bootstrapPath, discardUnconsumed };
  },
);

/**
 * Prefix of the custom-model bridge's per-process extension directory under
 * `<stateDir>/<stateNamespace>/extensions`. It names the server's pid, so a sweep can tell
 * a live server's directory from a crashed one's.
 */
export const ompExtensionProcessPrefix = (pid: number): string => `process-${pid}-`;

const OMP_SESSION_EXTENSION_FILE = /^scient-extension-.+\.(?:mjs|bootstrap\.json)$/u;

/**
 * Reclaim only files older than this server's start, and preserve directories/sessions owned by
 * another live PID or lock. Otherwise a sweep could delete new or concurrently active
 * extension/bootstrap credentials.
 */
export const sweepStaleOmpExtensionFiles = Effect.fn("OmpExtensionBootstrap.sweepStale")(
  function* (input: {
    readonly target: OmpTarget;
    readonly stateDir: string;
    readonly startedAt: number;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const list = (directory: string) =>
      fs.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const changedBeforeStart = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) =>
          Option.match(info.mtime, {
            onNone: () => false,
            onSome: (mtime) => mtime.getTime() < input.startedAt,
          }),
        ),
        Effect.orElseSucceed(() => false),
      );
    /** Another server that is still running: not this one, and alive. */
    const otherLiveServer = (pidText: string | undefined) => {
      const pid = Number(pidText);
      return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && ompProcessAlive(pid);
    };
    const removeIfStale = Effect.fn("OmpExtensionBootstrap.removeIfStale")(function* (
      file: string,
    ) {
      if (!(yield* changedBeforeStart(file))) return;
      yield* fs.remove(file, { recursive: true, force: true }).pipe(Effect.ignore);
    });

    const extensions = path.join(input.stateDir, input.target.stateNamespace, "extensions");
    for (const name of yield* list(extensions)) {
      if (!name.startsWith("process-")) continue;
      if (otherLiveServer(/^process-(\d+)-/u.exec(name)?.[1])) continue;
      yield* removeIfStale(path.join(extensions, name));
    }

    const sessions = path.join(input.stateDir, `${input.target.stateNamespace}-sessions`);
    for (const key of yield* list(sessions)) {
      const session = path.join(sessions, key);
      const lock = yield* fs
        .readFileString(path.join(session, ".session.lock"))
        .pipe(Effect.orElseSucceed(() => ""));
      if (otherLiveServer(lock.split(":")[0])) continue;
      for (const name of yield* list(session)) {
        if (OMP_SESSION_EXTENSION_FILE.test(name)) yield* removeIfStale(path.join(session, name));
      }
    }
  },
);
