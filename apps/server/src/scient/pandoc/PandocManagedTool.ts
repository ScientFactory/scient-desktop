// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off -- The reviewed download boundary for the pinned Pandoc release, matching the TinyTeX installer: a streamed body with progress and a host allowlist over compile-time-constant URLs, hashed by the host.
/**
 * Installs the pinned Pandoc release Word export runs, on first use.
 *
 * Download the archive named in `pandocManifest.ts`, check its exact size and
 * SHA-256 before anything is unpacked, expand it into a staging directory
 * under `<stateDir>/pandoc/managed`, prove the binary starts and reports the
 * pinned version, and only then record it as current. No elevation is asked
 * for, nothing outside the managed directory is touched, and a Pandoc already
 * on this computer is never used.
 *
 * The install runs on a supervised fiber and reports a single state value that
 * clients poll. One install runs at a time: asking again while one is running
 * answers with the running install. A run that dies midway (a failed download,
 * a crash, a shutdown) leaves the previous state file untouched, and the next
 * install clears whatever staging it left behind, so installing again always
 * recovers.
 *
 * macOS: Node's download carries no quarantine attribute and `tar` adds none,
 * so Scient does not strip or assume anything about Gatekeeper; the upstream
 * binary is Developer ID signed with the hardened runtime.
 */
import * as NodeCrypto from "node:crypto";

import type { ScientPandocInstallState, ScientPandocToolStatus } from "@t3tools/contracts";
import { ScientPandocInstallFailureReason } from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as ServerConfig from "../../config.ts";
import { artifactUrlRejection } from "../latex/LatexManagedToolchain.ts";
import {
  MANAGED_PANDOC_INSTALL_DIR_PREFIX,
  decodeManagedPandocInstallRecord,
  encodeManagedPandocInstallRecord,
  managedPandocInstallRoot,
  managedPandocPaths,
  readManagedPandocInstall,
} from "./managedPandocInstall.ts";
import * as PandocArchiveUnpacker from "./PandocArchiveUnpacker.ts";
import {
  PANDOC_ALLOWED_HOSTS,
  PandocManifestRef,
  resolvePandocAsset,
  type PandocAsset,
} from "./pandocManifest.ts";
import { makePandocScratch, runPandoc, type PandocCommand } from "./pandocProcess.ts";

export class PandocManagedTool extends Context.Service<
  PandocManagedTool,
  {
    /** Scient has a pinned build for this platform and architecture. */
    readonly canInstall: boolean;
    readonly status: Effect.Effect<ScientPandocToolStatus>;
    /** Starts an install, or reports the one already running. */
    readonly install: Effect.Effect<ScientPandocToolStatus>;
    /** How to run the installed Pandoc, or `null` when it is not installed. */
    readonly command: Effect.Effect<PandocCommand | null>;
    /** Parent of every conversion's private scratch directory. */
    readonly scratchRoot: string;
  }
>()("t3/scient/pandoc/PandocManagedTool") {}

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT = "10 minutes";
/** Ceiling over the whole run, including the header exchange no phase times. */
const INSTALL_TIMEOUT = "20 minutes";
const PROGRESS_STEP_BYTES = 1024 * 1024;
const VALIDATION_LIMITS = {
  timeout: "30 seconds",
  maxHeapMb: 256,
  maxStdoutBytes: 64 * 1024,
} as const;
/** Scratch directories a crashed run left behind are swept once they are this old. */
const STALE_SCRATCH_MS = 60 * 60 * 1000;

class PandocInstallFailure extends Schema.TaggedError<PandocInstallFailure>()(
  "PandocInstallFailure",
  {
    reason: ScientPandocInstallFailureReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const failInstall = (reason: PandocInstallFailure["reason"], detail: string) =>
  Effect.fail(new PandocInstallFailure({ reason, detail }));

const ACTIVE_PHASES: ReadonlySet<ScientPandocInstallState["state"]> = new Set([
  "downloading",
  "verifying",
  "unpacking",
]);

export const make = Effect.gen(function* () {
  const manifest = yield* PandocManifestRef;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const unpacker = yield* PandocArchiveUnpacker.PandocArchiveUnpacker;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const hostEnvironment = yield* HostProcessEnvironment;
  const lookup = resolvePandocAsset(platform, architecture, manifest);
  const asset = lookup.supported ? lookup.asset : null;
  const paths = managedPandocPaths({ stateDir: config.stateDir, join: path.join });
  // The install fiber's callers hold no context, so its services are captured here.
  const installContext = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | ServerConfig.ServerConfig
    | ChildProcessSpawner.ChildProcessSpawner
  >();

  const installScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(installScope, Exit.void));
  const startedAt = yield* Clock.currentTimeMillis;
  const stateRef = yield* Ref.make<ScientPandocInstallState>({
    state: "idle",
    bytesReceived: null,
    totalBytes: null,
    failureReason: null,
    updatedAtEpochMs: startedAt,
  });
  const startGate = yield* Semaphore.make(1);

  // Scratch directories are removed by their conversion's scope; one only
  // survives a process that died mid-conversion. Sweep those, leaving recent
  // ones alone in case another server shares this state directory.
  yield* Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(paths.scratchRoot);
    yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          const candidate = path.join(paths.scratchRoot, entry);
          const info = yield* fileSystem.stat(candidate);
          const modified = Option.match(info.mtime, {
            onNone: () => 0,
            onSome: (date) => date.getTime(),
          });
          if (startedAt - modified < STALE_SCRATCH_MS) return;
          yield* fileSystem.remove(candidate, { recursive: true, force: true });
        }).pipe(Effect.ignoreCause()),
      { discard: true },
    );
  }).pipe(Effect.ignoreCause());

  const publish = (
    update: (
      current: ScientPandocInstallState,
    ) => Omit<ScientPandocInstallState, "updatedAtEpochMs">,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* Ref.updateAndGet(stateRef, (current) => ({
        ...update(current),
        updatedAtEpochMs: now,
      }));
    });

  const phase = (next: ScientPandocInstallState["state"]) =>
    publish((current) => ({ ...current, state: next, failureReason: null }));

  const toolStatus = (install: ScientPandocInstallState) =>
    readManagedPandocInstall().pipe(
      Effect.provideContext(installContext),
      Effect.map((installed): ScientPandocToolStatus => ({
        version: manifest.version,
        installed: installed !== null,
        canInstall: asset !== null,
        unavailableReason: lookup.supported ? null : lookup.message,
        downloadBytes: asset?.sizeBytes ?? null,
        install,
      })),
    );

  const openArtifact = (url: string) =>
    Effect.gen(function* () {
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const rejection = artifactUrlRejection(current, PANDOC_ALLOWED_HOSTS);
        if (rejection !== null) return yield* failInstall("download-failed", rejection);
        const response = yield* Effect.tryPromise({
          try: (signal) => fetch(current, { redirect: "manual", signal }),
          catch: (cause) =>
            new PandocInstallFailure({
              reason: "download-failed",
              detail: `Scient could not reach the Pandoc download: ${String(cause)}`,
            }),
        });
        if (response.status < 300 || response.status >= 400) return response;
        const location = response.headers.get("location");
        yield* Effect.promise(async () => {
          await response.body?.cancel().catch(() => undefined);
        });
        if (location === null) {
          return yield* failInstall("download-failed", "The Pandoc download redirected nowhere.");
        }
        current = new URL(location, current).href;
      }
      return yield* failInstall(
        "download-failed",
        "The Pandoc download redirected too many times.",
      );
    });

  const download = (input: { readonly asset: PandocAsset; readonly destination: string }) =>
    Effect.gen(function* () {
      const response = yield* openArtifact(input.asset.url);
      const body = response.body;
      if (!response.ok || body === null) {
        yield* Effect.promise(async () => {
          await response.body?.cancel().catch(() => undefined);
        });
        return yield* failInstall(
          "download-failed",
          `The Pandoc download answered with HTTP ${String(response.status)}.`,
        );
      }
      const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isSafeInteger(declared) && declared !== input.asset.sizeBytes) {
        yield* Effect.promise(async () => {
          await body.cancel().catch(() => undefined);
        });
        return yield* failInstall(
          "download-failed",
          "The Pandoc download is not the size Scient pinned.",
        );
      }

      const receivedRef = yield* Ref.make(0);
      const publishedRef = yield* Ref.make(0);
      yield* publish((current) => ({
        ...current,
        state: "downloading",
        bytesReceived: 0,
        totalBytes: input.asset.sizeBytes,
        failureReason: null,
      }));

      yield* Stream.fromReadableStream<Uint8Array, PandocInstallFailure>({
        evaluate: () => body,
        onError: (cause) =>
          new PandocInstallFailure({
            reason: "download-failed",
            detail: `The Pandoc download was interrupted: ${String(cause)}`,
          }),
      }).pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            const received = yield* Ref.updateAndGet(
              receivedRef,
              (total) => total + chunk.byteLength,
            );
            if (received > input.asset.sizeBytes) {
              return yield* failInstall(
                "download-failed",
                "The Pandoc download is larger than Scient pinned.",
              );
            }
            const published = yield* Ref.get(publishedRef);
            if (received - published < PROGRESS_STEP_BYTES && received !== input.asset.sizeBytes) {
              return;
            }
            yield* Ref.set(publishedRef, received);
            yield* publish((current) => ({ ...current, bytesReceived: received }));
          }),
        ),
        Stream.run(fileSystem.sink(input.destination, { flag: "wx" })),
        Effect.catchTag("PlatformError", (cause) =>
          failInstall(
            "download-failed",
            `Scient could not save the Pandoc download: ${cause.message}`,
          ),
        ),
        Effect.timeoutOption(DOWNLOAD_TIMEOUT),
        Effect.flatMap((finished) =>
          Option.isSome(finished)
            ? Effect.void
            : failInstall("download-failed", "The Pandoc download took too long and was stopped."),
        ),
      );

      if ((yield* Ref.get(receivedRef)) !== input.asset.sizeBytes) {
        return yield* failInstall(
          "download-failed",
          "The Pandoc download ended early and is incomplete.",
        );
      }
    });

  const verify = (input: { readonly asset: PandocAsset; readonly archivePath: string }) =>
    Effect.gen(function* () {
      yield* phase("verifying");
      const digest = yield* fileSystem.stream(input.archivePath).pipe(
        Stream.runFold(
          () => NodeCrypto.createHash("sha256"),
          (hash, chunk) => hash.update(chunk),
        ),
        Effect.map((hash) => hash.digest("hex")),
        Effect.catchTag("PlatformError", (cause) =>
          failInstall(
            "install-failed",
            `Scient could not read the Pandoc download: ${cause.message}`,
          ),
        ),
      );
      if (digest !== input.asset.sha256.toLowerCase()) {
        return yield* failInstall(
          "checksum-mismatch",
          "The Pandoc download does not match the digest Scient pinned.",
        );
      }
    });

  const unpackAndValidate = (input: {
    readonly asset: PandocAsset;
    readonly archivePath: string;
    readonly payloadPath: string;
  }) =>
    Effect.gen(function* () {
      yield* phase("unpacking");
      yield* fileSystem
        .makeDirectory(input.payloadPath, { recursive: true })
        .pipe(
          Effect.catchTag("PlatformError", (cause) =>
            failInstall("install-failed", `Scient could not prepare the install: ${cause.message}`),
          ),
        );
      yield* unpacker
        .unpack({
          archivePath: input.archivePath,
          destination: input.payloadPath,
          archive: input.asset.archive,
        })
        .pipe(Effect.catch((cause) => failInstall("unpack-failed", cause.detail)));
      const executable = path.join(input.payloadPath, input.asset.executableRelativePath);
      const present = yield* fileSystem.exists(executable).pipe(Effect.orElseSucceed(() => false));
      if (!present) {
        return yield* failInstall(
          "unpack-failed",
          "The Pandoc download did not contain the program Scient expected.",
        );
      }
      if (platform !== "win32") {
        yield* fileSystem
          .chmod(executable, 0o755)
          .pipe(
            Effect.catchTag("PlatformError", (cause) =>
              failInstall(
                "unpack-failed",
                `Scient could not make Pandoc executable: ${cause.message}`,
              ),
            ),
          );
      }
      // Prove the binary starts, under the same isolation every conversion
      // uses, and is the pinned release, before the state file can name it.
      const output = yield* Effect.scoped(
        Effect.gen(function* () {
          const scratch = yield* makePandocScratch(paths.scratchRoot);
          return yield* runPandoc({
            pandoc: { command: executable, leadingArgs: [] },
            args: ["--version"],
            stdin: new Uint8Array(0),
            scratch,
            limits: VALIDATION_LIMITS,
            platform,
            hostEnvironment,
          });
        }),
      ).pipe(
        Effect.catch((cause) =>
          failInstall("unpack-failed", `The unpacked Pandoc did not start: ${cause.message}`),
        ),
      );
      const banner = new TextDecoder().decode(output.stdout).split(/\r?\n/u)[0]?.trim() ?? "";
      if (banner !== `pandoc ${manifest.version}`) {
        return yield* failInstall(
          "unpack-failed",
          `The unpacked program reported "${banner.slice(0, 80)}", not Pandoc ${manifest.version}.`,
        );
      }
    });

  const promote = (payloadPath: string, installable: PandocAsset) =>
    Effect.gen(function* () {
      const installRoot = managedPandocInstallRoot({
        managedRoot: paths.managedRoot,
        version: manifest.version,
        unique: NodeCrypto.randomUUID().slice(0, 8),
        join: path.join,
      });
      yield* fileSystem.rename(payloadPath, installRoot);
      const contents = yield* encodeManagedPandocInstallRecord({
        schemaVersion: 1,
        version: manifest.version,
        sha256: installable.sha256,
        installedAtEpochMs: yield* Clock.currentTimeMillis,
        root: installRoot,
      }).pipe(Effect.orDie);
      yield* writeFileStringAtomically({ filePath: paths.statePath, contents, durable: true });
      return installRoot;
    }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        failInstall("install-failed", `Scient could not finish the install: ${cause.message}`),
      ),
    );

  /**
   * Best-effort removal of install directories nothing points to any more,
   * run only after the state file names the new tree. A removal that fails (an
   * old `pandoc.exe` still running) is left for the next install.
   */
  const cleanupSupersededInstalls = (promotedRoot: string) =>
    Effect.gen(function* () {
      const contents = yield* fileSystem
        .readFileString(paths.statePath)
        .pipe(Effect.orElseSucceed(() => null));
      const committedRoot =
        contents === null
          ? promotedRoot
          : yield* decodeManagedPandocInstallRecord(contents).pipe(
              Effect.map((record) => record.root),
              Effect.orElseSucceed(() => promotedRoot),
            );
      const keep = new Set([promotedRoot, committedRoot]);
      const entries = yield* fileSystem
        .readDirectory(paths.managedRoot)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      yield* Effect.forEach(
        entries.filter((entry) => entry.startsWith(MANAGED_PANDOC_INSTALL_DIR_PREFIX)),
        (entry) => {
          const candidate = path.join(paths.managedRoot, entry);
          return keep.has(candidate)
            ? Effect.void
            : fileSystem
                .remove(candidate, { recursive: true, force: true })
                .pipe(Effect.ignoreCause());
        },
        { discard: true },
      );
    }).pipe(Effect.ignoreCause());

  const runInstall = (installable: PandocAsset) =>
    Effect.gen(function* () {
      // Whatever an interrupted earlier install left in staging is not this
      // run's; the single-flight gate means no install of this process owns it.
      yield* fileSystem
        .remove(paths.stagingRoot, { recursive: true, force: true })
        .pipe(Effect.ignoreCause());
      yield* fileSystem.makeDirectory(paths.stagingRoot, { recursive: true });
      const staging = yield* fileSystem.makeTempDirectory({
        directory: paths.stagingRoot,
        prefix: "install-",
      });
      const archivePath = path.join(staging, installable.fileName);
      const payloadPath = path.join(staging, "payload");
      yield* Effect.gen(function* () {
        yield* download({ asset: installable, destination: archivePath });
        yield* verify({ asset: installable, archivePath });
        yield* unpackAndValidate({ asset: installable, archivePath, payloadPath });
        const installRoot = yield* promote(payloadPath, installable);
        yield* cleanupSupersededInstalls(installRoot);
      }).pipe(
        Effect.ensuring(
          fileSystem.remove(staging, { recursive: true, force: true }).pipe(Effect.ignoreCause()),
        ),
      );
    }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        failInstall("install-failed", `Scient could not prepare the install: ${cause.message}`),
      ),
      Effect.timeoutOption(INSTALL_TIMEOUT),
      Effect.flatMap((finished) =>
        Option.isSome(finished)
          ? publish(() => ({
              state: "ready",
              bytesReceived: null,
              totalBytes: null,
              failureReason: null,
            }))
          : failInstall("install-failed", "Installing Pandoc took too long and was stopped."),
      ),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("scient pandoc managed install failed", {
            reason: cause.reason,
            detail: cause.detail,
          });
          yield* publish(() => ({
            state: "failed",
            bytesReceived: null,
            totalBytes: null,
            failureReason: cause.reason,
          }));
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("scient pandoc managed install crashed", { cause });
          yield* publish(() => ({
            state: "failed",
            bytesReceived: null,
            totalBytes: null,
            failureReason: "install-failed",
          }));
        }),
      ),
      Effect.provideContext(installContext),
    );

  const install = startGate.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(stateRef);
      if (ACTIVE_PHASES.has(current.state)) return yield* toolStatus(current);
      if (asset === null) {
        return yield* toolStatus(
          yield* publish(() => ({
            state: "failed",
            bytesReceived: null,
            totalBytes: null,
            failureReason: "unsupported-platform",
          })),
        );
      }
      // Claim the run before forking so a request that arrives while this one
      // is still starting sees an install already in flight.
      const claimed = yield* publish(() => ({
        state: "downloading",
        bytesReceived: null,
        totalBytes: asset.sizeBytes,
        failureReason: null,
      }));
      yield* Effect.forkIn(runInstall(asset), installScope);
      return yield* toolStatus(claimed);
    }),
  );

  const command = readManagedPandocInstall().pipe(
    Effect.provideContext(installContext),
    Effect.map((installed): PandocCommand | null =>
      installed === null ? null : { command: installed.executable, leadingArgs: [] },
    ),
  );

  return PandocManagedTool.of({
    canInstall: asset !== null,
    status: Ref.get(stateRef).pipe(Effect.flatMap(toolStatus)),
    install,
    command,
    scratchRoot: paths.scratchRoot,
  });
});

export const layer = Layer.effect(PandocManagedTool, make).pipe(
  Layer.provide(PandocArchiveUnpacker.layer),
);
