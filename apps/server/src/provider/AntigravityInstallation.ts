// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or free-space query.
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import { ProviderDriverKind, type ProviderInstallState } from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { isManagedRuntimeUpdate } from "@scientfactory/provider-runtime";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import type * as NodeStream from "node:stream";
import * as Yauzl from "yauzl";

import { ServerConfig } from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ManagedRuntimeCatalog } from "../scient/providerLifecycle/ManagedRuntimeCatalog.ts";
import {
  bundledAntigravityAcpAsset,
  resolveAntigravityAcpCatalogAsset,
} from "../scient/providerLifecycle/antigravityAcpCatalog.ts";
import { makeAntigravityAcpRuntime } from "./acp/AntigravityAcpSupport.ts";
import {
  buildAntigravityAcpSpawnInput,
  prepareAntigravityProfile,
} from "./antigravityAuthSupport.ts";
import {
  resolveAntigravityReleaseAsset,
  type AntigravityReleaseAsset,
} from "./antigravityRelease.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const DOWNLOAD_TIMEOUT = "45 minutes";
const VALIDATION_TIMEOUT = "90 seconds";
const FREE_SPACE_MARGIN = 256 * 1024 * 1024;
const RECORD_MAX_BYTES = 8 * 1024;
const RELEASE_RECORD = ".install-complete.json";

const ReleaseId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const ActiveRelease = Schema.Struct({ releaseId: ReleaseId });
const InstalledRelease = Schema.Struct({
  releaseId: ReleaseId,
  version: Schema.String,
  registryVersion: Schema.optionalKey(Schema.String),
  executable: Schema.Struct({ name: Schema.String, bytes: Schema.Number }),
  harness: Schema.Struct({ name: Schema.String, bytes: Schema.Number }),
});
type InstalledRelease = typeof InstalledRelease.Type;
const encodeActiveRelease = Schema.encodeEffect(Schema.fromJsonString(ActiveRelease));
const encodeInstalledRelease = Schema.encodeEffect(Schema.fromJsonString(InstalledRelease));

export class AntigravityInstallationError extends Schema.TaggedErrorClass<AntigravityInstallationError>()(
  "AntigravityInstallationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}
const isInstallationError = Schema.is(AntigravityInstallationError);

export interface AntigravityExecutable {
  readonly executablePath: string;
  readonly harnessPath: string;
  readonly source: "override" | "managed" | "path";
  readonly version: string | null;
  readonly registryVersion?: string;
  readonly managedVersionDirectory: string | null;
}

interface AntigravityInstallationService {
  readonly managedDirectory: string;
  readonly latestRelease: Effect.Effect<AntigravityReleaseAsset | null>;
  /** Bounded catalog refresh for explicit install, update, or repair. */
  readonly refreshLatestRelease: Effect.Effect<AntigravityReleaseAsset | null>;
  readonly resolve: (
    binaryPath?: string,
    environment?: NodeJS.ProcessEnv,
  ) => Effect.Effect<AntigravityExecutable, AntigravityInstallationError>;
  /** Hold the lease until the spawned process has exited. */
  readonly acquire: (
    binaryPath?: string,
    environment?: NodeJS.ProcessEnv,
  ) => Effect.Effect<AntigravityExecutable, AntigravityInstallationError, Scope.Scope>;
  readonly start: Effect.Effect<ProviderInstallState, AntigravityInstallationError>;
  /** Install the exact locally-qualified release the user reviewed. */
  readonly startRelease: (
    asset: AntigravityReleaseAsset,
  ) => Effect.Effect<ProviderInstallState, AntigravityInstallationError>;
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ProviderInstallState, AntigravityInstallationError>;
  readonly state: Effect.Effect<ProviderInstallState>;
  readonly changes: Stream.Stream<ProviderInstallState>;
  readonly remove: (
    protectedBinaryPaths?: ReadonlyArray<string>,
  ) => Effect.Effect<void, AntigravityInstallationError>;
}

export class AntigravityInstallation extends Context.Service<
  AntigravityInstallation,
  AntigravityInstallationService
>()("t3/provider/AntigravityInstallation") {
  static readonly layer = Layer.effect(
    AntigravityInstallation,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const catalog = yield* ManagedRuntimeCatalog;
      const platform = yield* HostProcessPlatform;
      const arch = yield* HostProcessArchitecture;
      return yield* makeAntigravityInstallation({
        baseDir: config.baseDir,
        refreshLatestRelease: catalog.refresh.pipe(
          Effect.map(
            (current) =>
              resolveAntigravityAcpCatalogAsset(current, platform, arch) ??
              bundledAntigravityAcpAsset(platform, arch),
          ),
        ),
        latestRelease: catalog.current.pipe(
          Effect.map(
            (current) =>
              resolveAntigravityAcpCatalogAsset(current, platform, arch) ??
              bundledAntigravityAcpAsset(platform, arch),
          ),
        ),
      });
    }),
  );
}

export interface AntigravityInstallationOptions {
  readonly baseDir: string;
  readonly releaseAsset?: AntigravityReleaseAsset | null;
  readonly latestRelease?: Effect.Effect<AntigravityReleaseAsset | null>;
  readonly refreshLatestRelease?: Effect.Effect<AntigravityReleaseAsset | null>;
  readonly validate?: (
    executable: AntigravityExecutable,
    expectedVersion: string,
  ) => Effect.Effect<void, AntigravityInstallationError, Scope.Scope>;
}

const installationError = (operation: string, detail: string, cause?: unknown) =>
  new AntigravityInstallationError({
    operation,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const wrapFailure = (operation: string, detail: string) => (cause: unknown) =>
  isInstallationError(cause) ? cause : installationError(operation, detail, cause);

function executableNames(platform: NodeJS.Platform) {
  return platform === "win32"
    ? { executable: "agy_acp_server.exe", harness: "localharness_external.exe" }
    : { executable: "agy_acp_server.par", harness: "localharness_external" };
}

function isRunning(state: ProviderInstallState) {
  return (
    state.phase === "downloading" || state.phase === "extracting" || state.phase === "verifying"
  );
}

/** Open only a verified local archive. Entries stay lazy and extraction stays bounded. */
const openArchive = Effect.fn("AntigravityInstallation.openArchive")(function* (
  archivePath: string,
) {
  const opened = yield* Effect.acquireRelease(
    Effect.callback<
      {
        readonly zip: Yauzl.ZipFile;
        readonly error: () => AntigravityInstallationError | undefined;
        readonly close: Effect.Effect<void>;
      },
      AntigravityInstallationError
    >((resume) => {
      Yauzl.open(
        archivePath,
        { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
        (error, zip) => {
          if (error || !zip) {
            resume(
              Effect.fail(
                installationError("extract", "Could not open the verified archive.", error),
              ),
            );
            return;
          }
          let closed = false;
          let archiveError: AntigravityInstallationError | undefined;
          zip.on("close", () => {
            closed = true;
          });
          zip.on("error", (cause: unknown) => {
            archiveError = installationError("extract", "The archive could not be read.", cause);
          });
          resume(
            Effect.succeed({
              zip,
              error: () => archiveError,
              close: Effect.callback<void>((finish) => {
                if (closed) {
                  finish(Effect.void);
                  return;
                }
                const onClose = () => {
                  zip.removeListener("error", onError);
                  finish(Effect.void);
                };
                const onError = (cause: unknown) => {
                  zip.removeListener("close", onClose);
                  finish(
                    Effect.die(installationError("extract", "Could not close the archive.", cause)),
                  );
                };
                zip.once("close", onClose);
                zip.once("error", onError);
                zip.close();
              }),
            }),
          );
        },
      );
    }),
    (opened) => opened.close,
  );

  const next = Effect.callback<Yauzl.Entry | null, AntigravityInstallationError>((resume) => {
    const existingError = opened.error();
    if (existingError) {
      resume(Effect.fail(existingError));
      return;
    }
    const cleanup = () => {
      opened.zip.removeListener("entry", onEntry);
      opened.zip.removeListener("end", onEnd);
      opened.zip.removeListener("error", onError);
    };
    const onEntry = (entry: Yauzl.Entry) => {
      cleanup();
      resume(Effect.succeed(entry));
    };
    const onEnd = () => {
      cleanup();
      resume(Effect.succeed(null));
    };
    const onError = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(installationError("extract", "The archive could not be read.", cause)));
    };
    opened.zip.once("entry", onEntry);
    opened.zip.once("end", onEnd);
    opened.zip.once("error", onError);
    opened.zip.readEntry();
    return Effect.sync(cleanup);
  });

  const streamEntry = (entry: Yauzl.Entry) =>
    Effect.acquireRelease(
      Effect.callback<NodeStream.Readable, AntigravityInstallationError>((resume) => {
        opened.zip.openReadStream(entry, (cause, readable) => {
          resume(
            cause || !readable
              ? Effect.fail(
                  installationError("extract", "Could not read an archive member.", cause),
                )
              : Effect.succeed(readable),
          );
        });
      }),
      (readable) =>
        Effect.sync(() => {
          readable.destroy();
        }),
    );
  return { entryCount: opened.zip.entryCount, next, streamEntry };
});

export const makeAntigravityInstallation = Effect.fn("AntigravityInstallation.make")(function* (
  options: AntigravityInstallationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const environment = yield* HostProcessEnvironment;
  const releaseAsset =
    options.releaseAsset === undefined
      ? resolveAntigravityReleaseAsset(platform, arch)
      : options.releaseAsset;
  const latestRelease = options.latestRelease ?? Effect.succeed(releaseAsset);
  const refreshLatestRelease = options.refreshLatestRelease ?? latestRelease;
  const names = executableNames(platform);
  const managedDirectory = path.join(
    options.baseDir,
    "tools",
    "antigravity-acp",
    `${platform}-${arch}`,
  );
  const versionsDirectory = path.join(managedDirectory, "versions");
  const activePath = path.join(managedDirectory, "active.json");
  const gate = yield* Semaphore.make(1);
  const leases = new Map<string, number>();
  let running:
    | {
        readonly operationId: string;
        readonly releaseId: string;
        readonly fiber: Fiber.Fiber<void>;
      }
    | undefined;
  const state = yield* SubscriptionRef.make<ProviderInstallState>({
    driver: DRIVER,
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: releaseAsset?.archiveBytes ?? null,
    version: releaseAsset?.version ?? null,
    installedVersion: null,
    canRemove: false,
    message: null,
  });

  const readRecord = Effect.fn("AntigravityInstallation.readRecord")(function* <A>(
    filePath: string,
    schema: Schema.Codec<A>,
  ) {
    const info = yield* fs.stat(filePath);
    if (info.type !== "File" || Number(info.size) > RECORD_MAX_BYTES) {
      return yield* installationError(
        "resolve",
        "The managed runtime record is invalid. Reinstall Antigravity.",
      );
    }
    const contents = yield* fs.readFileString(filePath);
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(contents);
  });

  const executableFile = Effect.fn("AntigravityInstallation.executableFile")(function* (
    filePath: string,
    bytes?: number,
  ) {
    const info = yield* fs.stat(filePath).pipe(Effect.option);
    return (
      Option.isSome(info) &&
      info.value.type === "File" &&
      (bytes === undefined || Number(info.value.size) === bytes) &&
      (platform === "win32" || (info.value.mode & 0o111) !== 0)
    );
  });

  const completedRelease = Effect.fn("AntigravityInstallation.completedRelease")(function* (
    releaseId: string,
  ) {
    const directory = path.join(versionsDirectory, releaseId);
    const record = yield* readRecord(path.join(directory, RELEASE_RECORD), InstalledRelease);
    if (
      record.releaseId !== releaseId ||
      record.executable.name !== names.executable ||
      record.harness.name !== names.harness ||
      !Number.isSafeInteger(record.executable.bytes) ||
      record.executable.bytes <= 0 ||
      !Number.isSafeInteger(record.harness.bytes) ||
      record.harness.bytes <= 0 ||
      !record.version.trim() ||
      !(yield* executableFile(path.join(directory, names.executable), record.executable.bytes)) ||
      !(yield* executableFile(path.join(directory, names.harness), record.harness.bytes))
    ) {
      return yield* installationError(
        "resolve",
        "The managed Antigravity runtime is incomplete. Reinstall it.",
      );
    }
    return {
      executablePath: path.join(directory, names.executable),
      harnessPath: path.join(directory, names.harness),
      source: "managed",
      version: record.version,
      ...(record.registryVersion ? { registryVersion: record.registryVersion } : {}),
      managedVersionDirectory: directory,
    } satisfies AntigravityExecutable;
  });

  const fromExternal = Effect.fn("AntigravityInstallation.fromExternal")(function* (
    candidate: string,
    source: "override" | "path",
  ) {
    if (!(yield* executableFile(candidate))) return null;
    const executablePath = yield* fs.realPath(candidate);
    const directory = path.dirname(executablePath);
    const harnessPath = path.join(directory, names.harness);
    if (!(yield* executableFile(harnessPath))) return null;
    const realVersions = yield* fs.realPath(versionsDirectory).pipe(Effect.option);
    if (
      Option.isSome(realVersions) &&
      path.dirname(directory) === realVersions.value &&
      /^[a-f0-9]{64}$/u.test(path.basename(directory))
    ) {
      const installed = yield* completedRelease(path.basename(directory));
      return { ...installed, executablePath, harnessPath, source } satisfies AntigravityExecutable;
    }
    return {
      executablePath,
      harnessPath,
      source,
      version: null,
      managedVersionDirectory: null,
    } satisfies AntigravityExecutable;
  });

  const pathCandidates = (binary: string, processEnvironment = environment) => {
    const pathValue =
      platform === "win32"
        ? Object.entries(processEnvironment).findLast(([key]) => key.toUpperCase() === "PATH")?.[1]
        : processEnvironment.PATH;
    return (pathValue ?? "")
      .split(platform === "win32" ? ";" : ":")
      .map((directory) => directory.trim().replace(/^"|"$/gu, ""))
      .filter((directory) => directory.length > 0)
      .map((directory) => path.resolve(directory, binary));
  };

  const resolve: AntigravityInstallationService["resolve"] = Effect.fn(
    "AntigravityInstallation.resolve",
  )(
    function* (binaryPath?: string, processEnvironment?: NodeJS.ProcessEnv) {
      const override = binaryPath?.trim();
      if (override) {
        const candidates =
          path.isAbsolute(override) || override.includes("/") || override.includes("\\")
            ? [path.resolve(override)]
            : pathCandidates(override, processEnvironment);
        for (const candidate of candidates) {
          const selected = yield* fromExternal(candidate, "override");
          if (selected) return selected;
        }
        return yield* installationError(
          "resolve",
          "The custom Antigravity executable or its localharness_external sibling is missing or not executable.",
        );
      }
      if (yield* fs.exists(activePath)) {
        const active = yield* readRecord(activePath, ActiveRelease);
        return yield* completedRelease(active.releaseId);
      }
      for (const candidate of pathCandidates(names.executable, processEnvironment)) {
        const selected = yield* fromExternal(candidate, "path");
        if (selected) return selected;
      }
      return yield* installationError(
        "resolve",
        releaseAsset
          ? "Antigravity is not installed. Install it in this environment or set a custom executable path."
          : `Google does not publish an Antigravity runtime for ${platform}-${arch}. Use a supported environment or a custom executable.`,
      );
    },
    Effect.mapError(
      wrapFailure(
        "resolve",
        "Could not read the Antigravity installation. Reinstall it or set a custom executable path.",
      ),
    ),
  );

  const acquire = (binaryPath?: string, processEnvironment?: NodeJS.ProcessEnv) =>
    Effect.acquireRelease(
      gate.withPermit(
        Effect.gen(function* () {
          const executable = yield* resolve(binaryPath, processEnvironment);
          const directory = executable.managedVersionDirectory;
          if (directory) leases.set(directory, (leases.get(directory) ?? 0) + 1);
          return executable;
        }),
      ),
      (executable) =>
        gate.withPermit(
          Effect.sync(() => {
            const directory = executable.managedVersionDirectory;
            if (!directory) return;
            const remaining = (leases.get(directory) ?? 1) - 1;
            if (remaining > 0) leases.set(directory, remaining);
            else leases.delete(directory);
          }),
        ),
    );

  const validate =
    options.validate ??
    Effect.fn("AntigravityInstallation.validate")(
      function* (executable: AntigravityExecutable, expectedVersion: string) {
        const profileDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-antigravity-validate-",
        });
        const profile = yield* prepareAntigravityProfile({
          profileDirectory,
          platform,
          baseEnv: environment,
        });
        const runtime = yield* makeAntigravityAcpRuntime({
          spawn: buildAntigravityAcpSpawnInput({
            installation: executable,
            profile,
            cwd: profileDirectory,
            baseEnv: environment,
          }),
          cwd: profileDirectory,
          childProcessSpawner: spawner,
          clientInfo: { name: "t3-code", version: "0.0.0" },
        });
        const initialized = yield* runtime.initialize();
        if (
          initialized.agentInfo?.name !== "antigravity-acp" ||
          initialized.agentInfo.version !== expectedVersion ||
          initialized.protocolVersion !== 1 ||
          initialized.agentCapabilities?.loadSession !== true ||
          !initialized.agentCapabilities.sessionCapabilities?.resume ||
          !initialized.agentCapabilities.auth?.logout ||
          !initialized.authMethods?.some((method) => method.id === "oauth-personal")
        ) {
          return yield* installationError(
            "verify",
            "The downloaded runtime did not identify as the expected Google Antigravity release.",
          );
        }
      },
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError(
        wrapFailure(
          "verify",
          "The downloaded Antigravity runtime could not start in this environment.",
        ),
      ),
    );

  const install = Effect.fn("AntigravityInstallation.install")(
    function* (asset: AntigravityReleaseAsset) {
      const report = (phase: ProviderInstallState["phase"], message: string | null) =>
        SubscriptionRef.update(state, (current) => ({ ...current, phase, message }));
      yield* fs.makeDirectory(versionsDirectory, { recursive: true });
      yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove: true }));
      const destination = path.join(versionsDirectory, asset.sha256);
      const activate = Effect.fn("AntigravityInstallation.activate")(
        function* () {
          const pointerDirectory = yield* fs.makeTempDirectoryScoped({
            directory: managedDirectory,
            prefix: "active.json.",
          });
          const pointerPath = path.join(pointerDirectory, "contents.tmp");
          yield* fs.writeFileString(
            pointerPath,
            yield* encodeActiveRelease({ releaseId: asset.sha256 }),
            { flag: "wx", mode: 0o600 },
          );
          yield* fs.rename(pointerPath, activePath);
          // The pointer commits the install. Later temp cleanup cannot undo it.
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                phase: "succeeded",
                installedVersion: asset.version,
                message: null,
              }) satisfies ProviderInstallState,
          );
        },
        Effect.scoped,
        Effect.mapError(
          wrapFailure(
            "activate",
            "Could not activate Antigravity. The previous runtime is unchanged. Check for locked files and try again.",
          ),
        ),
        Effect.uninterruptible,
      );

      const replaceExisting = yield* fs.exists(destination);
      if (replaceExisting) {
        const verified = yield* Effect.gen(function* () {
          const existing = yield* completedRelease(asset.sha256);
          if (existing.version !== asset.version) {
            return yield* installationError("verify", "The managed release has the wrong version.");
          }
          yield* report("verifying", "Checking the installed runtime.");
          yield* validate(existing, asset.version).pipe(
            Effect.scoped,
            Effect.timeout(VALIDATION_TIMEOUT),
          );
          return existing;
        }).pipe(Effect.result);
        if (verified._tag === "Success") {
          // A registry revision may point to the same immutable archive. Record
          // that qualification without downloading or replacing the binaries.
          if (asset.registryVersion && verified.success.registryVersion !== asset.registryVersion) {
            yield* writeFileStringAtomically({
              filePath: path.join(destination, ".install-complete.json"),
              contents: yield* encodeInstalledRelease({
                releaseId: asset.sha256,
                version: asset.version,
                registryVersion: asset.registryVersion,
                executable: asset.executable,
                harness: asset.harness,
              }),
              mode: 0o600,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            );
          }
          yield* activate();
          return;
        }
        // Repair never removes the previous copy before a complete replacement
        // has passed the same pinned archive and executable checks as an install.
        yield* report("downloading", "Downloading a verified replacement for the damaged runtime.");
      }

      const available = yield* Effect.tryPromise(() =>
        NodeFSP.statfs(versionsDirectory, { bigint: true }),
      ).pipe(Effect.option);
      const required =
        asset.archiveBytes + asset.executable.bytes + asset.harness.bytes + FREE_SPACE_MARGIN;
      if (
        Option.isSome(available) &&
        available.value.bavail * available.value.bsize < BigInt(required)
      ) {
        return yield* installationError(
          "download",
          `Antigravity needs at least ${Math.ceil(required / 1024 / 1024)} MiB of free space to install.`,
        );
      }
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: versionsDirectory,
        prefix: ".install-",
      });
      const archivePath = path.join(staging, "download.zip");
      const pairDirectory = path.join(staging, "runtime");
      yield* fs.makeDirectory(pairDirectory);
      const hash = NodeCrypto.createHash("sha256");
      let downloadedBytes = 0;
      let lastProgressAt = yield* Clock.currentTimeMillis;
      yield* Effect.gen(function* () {
        const response = yield* http
          .execute(HttpClientRequest.get(asset.url))
          .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
        // dl.google.com gzips the zip when the client accepts it, so
        // `content-length` is the encoded size. The decoded stream is still
        // checked against the pinned byte count and hash below.
        const contentLength = response.headers["content-length"];
        const contentEncoding = response.headers["content-encoding"]?.trim().toLowerCase();
        const identityBody = contentEncoding === undefined || contentEncoding === "identity";
        if (
          identityBody &&
          contentLength !== undefined &&
          Number(contentLength) !== asset.archiveBytes
        ) {
          return yield* installationError(
            "download",
            "The Antigravity download size did not match the pinned release.",
          );
        }
        yield* response.stream.pipe(
          Stream.tap((chunk) =>
            Effect.gen(function* () {
              downloadedBytes += chunk.byteLength;
              if (downloadedBytes > asset.archiveBytes) {
                return yield* installationError(
                  "download",
                  "The Antigravity download exceeded the pinned release size.",
                );
              }
              hash.update(chunk);
              const now = yield* Clock.currentTimeMillis;
              if (now - lastProgressAt >= 250 || downloadedBytes === asset.archiveBytes) {
                lastProgressAt = now;
                yield* SubscriptionRef.update(state, (current) => ({
                  ...current,
                  downloadedBytes,
                }));
              }
            }),
          ),
          Stream.run(fs.sink(archivePath, { flag: "wx", mode: 0o600 })),
        );
      }).pipe(Effect.timeout(DOWNLOAD_TIMEOUT));
      if (downloadedBytes !== asset.archiveBytes || hash.digest("hex") !== asset.sha256) {
        return yield* installationError(
          "download",
          "The Antigravity download failed its size or SHA-256 check. Nothing was installed.",
        );
      }

      yield* report("extracting", "Extracting the verified runtime.");
      yield* Effect.gen(function* () {
        const archive = yield* openArchive(archivePath);
        if (archive.entryCount !== 2) {
          return yield* installationError(
            "extract",
            "The archive must contain exactly the Antigravity executable and its harness.",
          );
        }
        const seen = new Set<string>();
        for (;;) {
          const entry = yield* archive.next;
          if (!entry) break;
          const expected = [asset.executable, asset.harness].find(
            (file) => file.name === entry.fileName,
          );
          const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (
            !expected ||
            seen.has(entry.fileName) ||
            entry.fileName.includes("/") ||
            entry.fileName.includes("\\") ||
            (unixType !== 0 && unixType !== 0o100000) ||
            (entry.externalFileAttributes & 0x10) !== 0 ||
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            ![0, 8].includes(entry.compressionMethod) ||
            entry.uncompressedSize !== expected.bytes
          ) {
            return yield* installationError(
              "extract",
              "The archive contains an unexpected, unsafe, or incorrectly sized member.",
            );
          }
          seen.add(entry.fileName);
          yield* Effect.gen(function* () {
            const readable = yield* archive.streamEntry(entry);
            let extractedBytes = 0;
            yield* EffectNodeStream.fromReadable<Uint8Array, AntigravityInstallationError>({
              evaluate: () => readable,
              onError: wrapFailure("extract", "Could not extract the Antigravity runtime."),
            }).pipe(
              Stream.tap((chunk) =>
                Effect.gen(function* () {
                  extractedBytes += chunk.byteLength;
                  if (extractedBytes > expected.bytes) {
                    return yield* installationError(
                      "extract",
                      "An archive member exceeded its pinned size.",
                    );
                  }
                }),
              ),
              Stream.run(
                fs.sink(path.join(pairDirectory, entry.fileName), { flag: "wx", mode: 0o700 }),
              ),
            );
            if (extractedBytes !== expected.bytes) {
              return yield* installationError("extract", "An archive member was truncated.");
            }
          }).pipe(Effect.scoped);
        }
        if (!seen.has(asset.executable.name) || !seen.has(asset.harness.name)) {
          return yield* installationError(
            "extract",
            "The archive is missing the Antigravity executable or its harness.",
          );
        }
      }).pipe(Effect.scoped);
      yield* fs.remove(archivePath);
      if (platform !== "win32") {
        yield* fs.chmod(path.join(pairDirectory, asset.executable.name), 0o755);
        yield* fs.chmod(path.join(pairDirectory, asset.harness.name), 0o755);
      }
      yield* report("verifying", "Checking the downloaded runtime.");
      yield* validate(
        {
          executablePath: path.join(pairDirectory, asset.executable.name),
          harnessPath: path.join(pairDirectory, asset.harness.name),
          source: "managed",
          version: asset.version,
          managedVersionDirectory: pairDirectory,
        },
        asset.version,
      ).pipe(Effect.scoped, Effect.timeout(VALIDATION_TIMEOUT));
      const record: InstalledRelease = {
        releaseId: asset.sha256,
        version: asset.version,
        ...(asset.registryVersion ? { registryVersion: asset.registryVersion } : {}),
        executable: asset.executable,
        harness: asset.harness,
      };
      yield* fs.writeFileString(
        path.join(pairDirectory, RELEASE_RECORD),
        yield* encodeInstalledRelease(record),
        { flag: "wx", mode: 0o600 },
      );
      if (replaceExisting) {
        yield* gate.withPermit(
          Effect.gen(function* () {
            if ((leases.get(destination) ?? 0) > 0) {
              return yield* installationError(
                "repair",
                "Stop Antigravity sessions and sign-in flows before repairing this runtime.",
              );
            }
            // Kept outside scoped staging so a failed filesystem rollback cannot
            // delete the only remaining copy. The normal path removes this backup.
            const backupRoot = yield* fs.makeTempDirectory({
              directory: versionsDirectory,
              prefix: ".repair-",
            });
            const backup = path.join(backupRoot, "runtime");
            yield* fs
              .rename(destination, backup)
              .pipe(
                Effect.tapError(() =>
                  fs.remove(backupRoot, { recursive: true, force: true }).pipe(Effect.ignore),
                ),
              );
            const published = yield* fs.rename(pairDirectory, destination).pipe(Effect.result);
            if (published._tag === "Failure") {
              const restored = yield* fs.rename(backup, destination).pipe(Effect.result);
              if (restored._tag === "Failure") {
                return yield* installationError(
                  "repair",
                  `Could not restore the previous runtime. Its backup is retained at ${backup}.`,
                  restored.failure,
                );
              }
              yield* fs.remove(backupRoot, { recursive: true, force: true }).pipe(Effect.ignore);
              return yield* installationError(
                "repair",
                "Could not replace the runtime. The previous copy was restored.",
                published.failure,
              );
            }
            yield* fs.remove(backupRoot, { recursive: true, force: true }).pipe(Effect.ignore);
          }).pipe(Effect.uninterruptible),
        );
      } else
        yield* fs.rename(pairDirectory, destination).pipe(
          Effect.catch((cause) =>
            completedRelease(asset.sha256).pipe(
              Effect.flatMap((existing) =>
                existing.version === asset.version
                  ? validate(existing, asset.version).pipe(
                      Effect.scoped,
                      Effect.timeout(VALIDATION_TIMEOUT),
                    )
                  : Effect.fail(
                      installationError(
                        "activate",
                        "Another installation published a different Antigravity release.",
                      ),
                    ),
              ),
              Effect.mapError(() =>
                installationError(
                  "activate",
                  "Could not publish the Antigravity runtime. The previous release is unchanged. Try again.",
                  cause,
                ),
              ),
            ),
          ),
        );
      yield* activate();
    },
    Effect.scoped,
    Effect.mapError(
      wrapFailure(
        "install",
        "Could not install Antigravity. Check free disk space and directory access, then try again.",
      ),
    ),
  );

  const startRelease = (asset: AntigravityReleaseAsset) =>
    gate
      .withPermit(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          if (isRunning(current)) {
            if (current.version === asset.version && running?.releaseId === asset.sha256)
              return current;
            return yield* installationError(
              "start",
              "Another Antigravity release is already being installed. Wait for it to finish.",
            );
          }
          const activeRecord = yield* readRecord(activePath, ActiveRelease).pipe(
            Effect.flatMap((active) =>
              readRecord(
                path.join(versionsDirectory, active.releaseId, RELEASE_RECORD),
                InstalledRelease,
              ),
            ),
            Effect.option,
          );
          if (
            Option.isSome(activeRecord) &&
            asset.registryVersion &&
            activeRecord.value.registryVersion &&
            isManagedRuntimeUpdate({
              provider: "antigravityAcp",
              current: asset.registryVersion,
              candidate: activeRecord.value.registryVersion,
            })
          ) {
            return yield* installationError(
              "start",
              "A newer Antigravity runtime is already installed. Refresh the provider catalog before repairing it.",
            );
          }
          const operationId = yield* crypto.randomUUIDv4;
          const next: ProviderInstallState = {
            driver: DRIVER,
            operationId,
            phase: "downloading",
            downloadedBytes: 0,
            totalBytes: asset.archiveBytes,
            version: asset.version,
            installedVersion: current.installedVersion,
            canRemove: current.canRemove,
            message: "Downloading Google's official Antigravity runtime.",
          };
          yield* SubscriptionRef.set(state, next);
          const work = install(asset).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? SubscriptionRef.update(state, (value) => {
                    if (value.operationId !== operationId || value.phase === "succeeded")
                      return value;
                    const error = Cause.findErrorOption(exit.cause);
                    const cancelled = Cause.hasInterruptsOnly(exit.cause);
                    return {
                      ...value,
                      phase: cancelled ? "cancelled" : "failed",
                      message: cancelled
                        ? "Installation cancelled. The previous runtime is unchanged."
                        : Option.isSome(error)
                          ? error.value.detail
                          : "Could not finish the Antigravity installation. Check disk space and directory access.",
                    } satisfies ProviderInstallState;
                  })
                : Effect.void,
            ),
            Effect.ignoreCause,
            Effect.ensuring(
              Effect.sync(() => {
                if (running?.operationId === operationId) running = undefined;
              }),
            ),
          );
          const fiber = yield* Effect.forkIn(Effect.interruptible(work), serviceScope);
          running = { operationId, releaseId: asset.sha256, fiber };
          return next;
        }).pipe(Effect.uninterruptible),
      )
      .pipe(Effect.mapError(wrapFailure("start", "Could not start the Antigravity installation.")));

  const start = refreshLatestRelease.pipe(
    Effect.flatMap((asset) =>
      asset
        ? startRelease(asset)
        : Effect.fail(
            installationError(
              "start",
              `Google does not publish an Antigravity runtime for ${platform}-${arch}. Use a supported remote environment or a custom executable.`,
            ),
          ),
    ),
  );

  const cancel = Effect.fn("AntigravityInstallation.cancel")(function* (operationId: string) {
    return yield* gate.withPermit(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        if (current.operationId !== operationId) {
          return yield* installationError(
            "cancel",
            "This installation is no longer current. Refresh its status before cancelling.",
          );
        }
        if (running?.operationId === operationId && isRunning(current)) {
          yield* Fiber.interrupt(running.fiber);
        }
        return yield* SubscriptionRef.get(state);
      }),
    );
  });

  const remove = Effect.fn("AntigravityInstallation.remove")(
    function* (protectedBinaryPaths: ReadonlyArray<string> = []) {
      yield* gate.withPermit(
        Effect.gen(function* () {
          if (isRunning(yield* SubscriptionRef.get(state)) || leases.size > 0) {
            return yield* installationError(
              "remove",
              "Stop Antigravity sessions and sign-in flows before removing its managed runtime.",
            );
          }
          const realManaged = yield* fs.realPath(managedDirectory).pipe(Effect.option);
          if (Option.isSome(realManaged)) {
            for (const binaryPath of protectedBinaryPaths) {
              if (!binaryPath.trim()) continue;
              const selected = yield* resolve(binaryPath).pipe(Effect.option);
              if (Option.isSome(selected) && selected.value.managedVersionDirectory) {
                return yield* installationError(
                  "remove",
                  "A provider instance has a custom path inside this managed runtime. Clear that path before removing it.",
                );
              }
              const resolved = yield* fs.realPath(binaryPath).pipe(Effect.option);
              const candidate = Option.getOrElse(resolved, () => path.resolve(binaryPath));
              if (candidate.startsWith(`${realManaged.value}${path.sep}`)) {
                return yield* installationError(
                  "remove",
                  "A provider instance has a custom path inside this managed runtime. Clear that path before removing it.",
                );
              }
            }
          }
          yield* fs.remove(managedDirectory, { recursive: true, force: true });
          yield* SubscriptionRef.update(
            state,
            (current) =>
              ({
                ...current,
                operationId: null,
                phase: "idle",
                downloadedBytes: 0,
                installedVersion: null,
                canRemove: false,
                message: null,
              }) satisfies ProviderInstallState,
          );
        }).pipe(Effect.uninterruptible),
      );
    },
    Effect.mapError(
      wrapFailure(
        "remove",
        "Could not remove the managed Antigravity runtime. Check for open processes and try again.",
      ),
    ),
  );

  yield* Effect.gen(function* () {
    const canRemove = yield* fs.exists(managedDirectory);
    yield* SubscriptionRef.update(state, (current) => ({ ...current, canRemove }));
    if (!(yield* fs.exists(activePath))) return;
    const active = yield* readRecord(activePath, ActiveRelease);
    const installed = yield* completedRelease(active.releaseId);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      installedVersion: installed.version,
    }));
  }).pipe(
    Effect.catch(() =>
      SubscriptionRef.update(
        state,
        (current) =>
          ({
            ...current,
            phase: "failed",
            message: "The managed Antigravity runtime is incomplete. Repair it or remove it.",
          }) satisfies ProviderInstallState,
      ),
    ),
  );

  return AntigravityInstallation.of({
    managedDirectory,
    latestRelease,
    refreshLatestRelease,
    resolve,
    acquire,
    start,
    startRelease,
    cancel,
    state: SubscriptionRef.get(state),
    changes: SubscriptionRef.changes(state),
    remove,
  });
});
