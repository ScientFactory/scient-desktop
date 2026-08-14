// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off -- The reviewed download boundary for the pinned distribution, matching `@scientfactory/provider-runtime`: a streamed body with progress and a host allowlist over compile-time-constant URLs, hashed by the host.
/**
 * Installs the LaTeX distribution Scient pins, for people who have none.
 *
 * A fresh machine has no TeX. Telling a researcher to go install TeX Live and
 * come back is where this feature would lose them, so Scient offers to place
 * one itself: download the pinned TinyTeX bundle, check it against the digest
 * in `tinytexManifest.ts`, expand it into app-owned state, and only then swap
 * it into place. Nothing outside `<latexDir>/managed` is touched, no elevation
 * is asked for, and an existing system TeX keeps precedence — the probe only
 * falls back to this install when PATH has nothing.
 *
 * The install runs on a supervised fiber and reports itself through a single
 * state value that clients poll, because the work outlives the request that
 * started it. One install runs at a time; asking again while one is in flight
 * answers with the install already running rather than starting a second.
 */
import * as NodeCrypto from "node:crypto";

import type { ScientLatexManagedInstallState } from "@t3tools/contracts";
import { ScientLatexManagedInstallFailureReason } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as ServerConfig from "../../config.ts";
import * as LatexArchiveUnpacker from "./LatexArchiveUnpacker.ts";
import { LatexToolchain } from "./LatexToolchain.ts";
import {
  encodeManagedLatexInstallRecord,
  managedLatexInstallRoot,
  managedLatexPaths,
} from "./managedLatexInstall.ts";
import {
  TINYTEX_ALLOWED_HOSTS,
  TinyTexManifestRef,
  resolveTinyTexAsset,
  type TinyTexAsset,
} from "./tinytexManifest.ts";

export class LatexManagedToolchain extends Context.Service<
  LatexManagedToolchain,
  {
    /** Scient has a pinned distribution for this platform. */
    readonly canInstall: boolean;
    /** Starts an install, or reports the one already running. */
    readonly install: Effect.Effect<ScientLatexManagedInstallState>;
    readonly status: Effect.Effect<ScientLatexManagedInstallState>;
  }
>()("t3/scient/latex/LatexManagedToolchain") {}

const MAX_REDIRECTS = 5;
/** Well above the largest bundle the manifest can name, and far below a disk. */
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = "10 minutes";
/**
 * The ceiling over the whole run, phases and the gaps between them alike. The
 * body stream has `DOWNLOAD_TIMEOUT` and the expansion has its own, but the
 * redirect and header exchange before either — a `fetch` against a server that
 * accepts the connection and then says nothing — has none, and a run that
 * never ends is worse than a failed one: the state it leaves behind says an
 * install is in flight, and the single-flight gate then refuses every later
 * attempt for the life of the process. The ceiling sits above the sum of the
 * per-phase budgets, so it only ever cuts a run the phases could not.
 */
const INSTALL_TIMEOUT = "25 minutes";
/** Progress is republished per megabyte; a poll every 1.5s cannot see finer. */
const PROGRESS_STEP_BYTES = 1024 * 1024;

const ACTIVE_PHASES: ReadonlySet<ScientLatexManagedInstallState["state"]> = new Set([
  "downloading",
  "verifying",
  "unpacking",
]);

export function isActiveManagedInstallPhase(
  phase: ScientLatexManagedInstallState["state"],
): boolean {
  return ACTIVE_PHASES.has(phase);
}

class ManagedLatexInstallFailure extends Schema.TaggedErrorClass<ManagedLatexInstallFailure>()(
  "ManagedLatexInstallFailure",
  {
    reason: ScientLatexManagedInstallFailureReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const failInstall = (reason: ManagedLatexInstallFailure["reason"], detail: string) =>
  Effect.fail(new ManagedLatexInstallFailure({ reason, detail }));

/**
 * Why this URL may not be fetched, or `null` when it may be. Artifact URLs are
 * compile-time constants from the manifest, so this is a guard against a bad
 * pin rather than against user input. A loopback origin is allowed so the
 * whole install path can be exercised against a local server; the pinned
 * manifest is HTTPS, and its own test holds it to that.
 */
export function artifactUrlRejection(
  rawUrl: string,
  allowedHosts: ReadonlyArray<string> = TINYTEX_ALLOWED_HOSTS,
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `The download address is not a URL: ${rawUrl}`;
  }
  if (url.username !== "" || url.password !== "") {
    return "A download address may not carry credentials.";
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return "Downloads must use HTTPS.";
  }
  if (!loopback && !allowedHosts.some((allowed) => allowed.toLowerCase() === host)) {
    return `Downloads from ${url.hostname} are not allowed.`;
  }
  return null;
}

const idleState = (updatedAtEpochMs: number): ScientLatexManagedInstallState => ({
  state: "idle",
  version: null,
  bytesReceived: null,
  totalBytes: null,
  failureReason: null,
  updatedAtEpochMs,
});

export const make = Effect.gen(function* () {
  const manifest = yield* TinyTexManifestRef;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const unpacker = yield* LatexArchiveUnpacker.LatexArchiveUnpacker;
  const toolchain = yield* LatexToolchain;
  const platform = yield* HostProcessPlatform;
  const asset = resolveTinyTexAsset(platform, manifest);
  const paths = managedLatexPaths({ latexDir: config.latexDir, join: path.join });
  // The install runs on a fiber whose callers hold no context, so the atomic
  // write helper's own services are captured here.
  const fileContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  // The install outlives the request that asked for it, so its fiber is
  // supervised by the service the way build fibers are.
  const installScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(installScope, Exit.void));
  const startedAt = yield* Clock.currentTimeMillis;
  const stateRef = yield* Ref.make(idleState(startedAt));
  // One install at a time, and the decision to start one is made behind this
  // gate so two simultaneous requests cannot both see an idle state.
  const startGate = yield* Semaphore.make(1);

  const publish = (
    update: (
      current: ScientLatexManagedInstallState,
    ) => Omit<ScientLatexManagedInstallState, "updatedAtEpochMs">,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return yield* Ref.updateAndGet(stateRef, (current) => ({
        ...update(current),
        updatedAtEpochMs: now,
      }));
    });

  const phase = (next: ScientLatexManagedInstallState["state"]) =>
    publish((current) => ({ ...current, state: next, failureReason: null }));

  /** Follows the release redirect, checking every hop against the host list. */
  const openArtifact = (url: string) =>
    Effect.gen(function* () {
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const rejection = artifactUrlRejection(current);
        if (rejection !== null) return yield* failInstall("download-failed", rejection);
        const response = yield* Effect.tryPromise({
          try: (signal) => fetch(current, { redirect: "manual", signal }),
          catch: (cause) =>
            new ManagedLatexInstallFailure({
              reason: "download-failed",
              detail: `Scient could not reach the LaTeX download: ${String(cause)}`,
            }),
        });
        if (response.status < 300 || response.status >= 400) return response;
        const location = response.headers.get("location");
        yield* Effect.promise(async () => {
          await response.body?.cancel().catch(() => undefined);
        });
        if (location === null) {
          return yield* failInstall("download-failed", "The LaTeX download redirected nowhere.");
        }
        current = new URL(location, current).href;
      }
      return yield* failInstall("download-failed", "The LaTeX download redirected too many times.");
    });

  const download = (input: { readonly asset: TinyTexAsset; readonly destination: string }) =>
    Effect.gen(function* () {
      const response = yield* openArtifact(input.asset.url);
      const body = response.body;
      if (!response.ok || body === null) {
        yield* Effect.promise(async () => {
          await response.body?.cancel().catch(() => undefined);
        });
        return yield* failInstall(
          "download-failed",
          `The LaTeX download answered with HTTP ${String(response.status)}.`,
        );
      }
      const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isSafeInteger(declared) && declared !== input.asset.sizeBytes) {
        return yield* failInstall(
          "download-failed",
          "The LaTeX download is not the size Scient pinned.",
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

      yield* Stream.fromReadableStream<Uint8Array, ManagedLatexInstallFailure>({
        evaluate: () => body,
        onError: (cause) =>
          new ManagedLatexInstallFailure({
            reason: "download-failed",
            detail: `The LaTeX download was interrupted: ${String(cause)}`,
          }),
      }).pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            const received = yield* Ref.updateAndGet(
              receivedRef,
              (total) => total + chunk.byteLength,
            );
            if (received > MAX_DOWNLOAD_BYTES || received > input.asset.sizeBytes) {
              return yield* failInstall(
                "download-failed",
                "The LaTeX download is larger than Scient pinned.",
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
            `Scient could not save the LaTeX download: ${cause.message}`,
          ),
        ),
        Effect.timeoutOption(DOWNLOAD_TIMEOUT),
        Effect.flatMap((finished) =>
          Option.isSome(finished)
            ? Effect.void
            : failInstall("download-failed", "The LaTeX download took too long and was stopped."),
        ),
      );

      const received = yield* Ref.get(receivedRef);
      if (received !== input.asset.sizeBytes) {
        return yield* failInstall(
          "download-failed",
          "The LaTeX download ended early and is incomplete.",
        );
      }
    });

  const verify = (input: { readonly asset: TinyTexAsset; readonly archivePath: string }) =>
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
            `Scient could not read the LaTeX download: ${cause.message}`,
          ),
        ),
      );
      if (digest !== input.asset.sha256.toLowerCase()) {
        return yield* failInstall(
          "checksum-mismatch",
          "The LaTeX download does not match the digest Scient pinned.",
        );
      }
    });

  const unpack = (input: {
    readonly asset: TinyTexAsset;
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
        .pipe(
          Effect.catch((cause) =>
            failInstall(
              cause.reason === "unsupported-archive" ? "unsupported-archive" : "unpack-failed",
              cause.detail,
            ),
          ),
        );
      const executable = path.join(input.payloadPath, input.asset.executableRelativePath);
      const present = yield* fileSystem.exists(executable).pipe(Effect.orElseSucceed(() => false));
      if (!present) {
        return yield* failInstall(
          "unpack-failed",
          "The LaTeX download did not contain the engine Scient expected.",
        );
      }
    });

  /**
   * Moves the finished tree beside any earlier one and records it as current.
   *
   * The earlier install is never touched. Removing it to reuse its path is how
   * a working installation gets destroyed: an engine running out of that tree
   * holds its files open, the removal gets halfway, the rename onto the
   * wreckage fails, and what was a working TeX is now neither. So each install
   * lands in a directory of its own and the state file — one atomic write, the
   * only thing discovery reads — is the single moment the switch happens.
   * Superseded trees are the deferred GC's problem, not this path's.
   */
  const promote = (input: { readonly payloadPath: string; readonly version: string }) =>
    Effect.gen(function* () {
      const installRoot = managedLatexInstallRoot({
        managedRoot: paths.managedRoot,
        version: input.version,
        unique: NodeCrypto.randomUUID().slice(0, 8),
        join: path.join,
      });
      yield* fileSystem.makeDirectory(paths.managedRoot, { recursive: true });
      yield* fileSystem.rename(input.payloadPath, installRoot);
      const installedAtEpochMs = yield* Clock.currentTimeMillis;
      const contents = yield* encodeManagedLatexInstallRecord({
        schemaVersion: 1,
        version: input.version,
        installedAtEpochMs,
        root: installRoot,
      }).pipe(Effect.orDie);
      yield* writeFileStringAtomically({ filePath: paths.statePath, contents }).pipe(
        Effect.provideContext(fileContext),
      );
    }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        failInstall("install-failed", `Scient could not finish the install: ${cause.message}`),
      ),
    );

  const runInstall = (installable: TinyTexAsset) =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(paths.stagingRoot, { recursive: true });
      const staging = yield* fileSystem.makeTempDirectory({
        directory: paths.stagingRoot,
        prefix: "install-",
      });
      const archivePath = path.join(staging, installable.fileName);
      const payloadPath = path.join(staging, "payload");

      return yield* Effect.gen(function* () {
        yield* download({ asset: installable, destination: archivePath });
        yield* verify({ asset: installable, archivePath });
        yield* unpack({ asset: installable, archivePath, payloadPath });
        yield* promote({ payloadPath, version: manifest.version });
      }).pipe(
        // Whatever happened, the half-finished copy does not survive it.
        Effect.ensuring(
          fileSystem.remove(staging, { recursive: true, force: true }).pipe(Effect.ignoreCause()),
        ),
      );
    }).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        failInstall("install-failed", `Scient could not prepare the install: ${cause.message}`),
      ),
      Effect.flatMap(() =>
        Effect.gen(function* () {
          // The probe caches its answer, so the newly installed engine only
          // becomes visible once that cache is dropped. Do it before the state
          // says ready: a client that reacts to `ready` polls the toolchain
          // next, and must not be told the engine is still missing.
          yield* toolchain.probe(true).pipe(Effect.ignoreCause());
          yield* publish((current) => ({
            ...current,
            state: "ready",
            version: manifest.version,
            bytesReceived: null,
            totalBytes: null,
            failureReason: null,
          }));
        }),
      ),
      Effect.timeoutOption(INSTALL_TIMEOUT),
      Effect.flatMap((finished) =>
        Option.isSome(finished)
          ? Effect.void
          : failInstall(
              "install-failed",
              "The LaTeX installation took too long and was stopped. Try again.",
            ),
      ),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("scient latex managed install failed", {
            reason: cause.reason,
            detail: cause.detail,
          });
          yield* publish((current) => ({
            ...current,
            state: "failed",
            bytesReceived: null,
            totalBytes: null,
            failureReason: cause.reason,
          }));
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("scient latex managed install crashed", { cause });
          yield* publish((current) => ({
            ...current,
            state: "failed",
            bytesReceived: null,
            totalBytes: null,
            failureReason: "install-failed",
          }));
        }),
      ),
    );

  const install = startGate.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(stateRef);
      if (isActiveManagedInstallPhase(current.state)) return current;
      if (asset === null) {
        return yield* publish((existing) => ({
          ...existing,
          state: "failed",
          version: null,
          bytesReceived: null,
          totalBytes: null,
          failureReason: "unsupported-platform",
        }));
      }
      // Claim the run before forking so a second request that arrives while
      // this one is still starting sees an install already in flight.
      const claimed = yield* publish((existing) => ({
        ...existing,
        state: "downloading",
        version: manifest.version,
        bytesReceived: null,
        totalBytes: null,
        failureReason: null,
      }));
      yield* Effect.forkIn(runInstall(asset), installScope);
      return claimed;
    }),
  );

  return LatexManagedToolchain.of({
    canInstall: asset !== null,
    install,
    status: Ref.get(stateRef),
  });
});

export const layer = Layer.effect(LatexManagedToolchain, make).pipe(
  Layer.provide(LatexArchiveUnpacker.layer),
);
