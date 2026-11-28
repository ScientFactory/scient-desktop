// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off -- The reviewed download boundary for the pinned wacli release, as for Pandoc: a streamed body under a host allowlist over compile-time-constant URLs, hashed by the host.
/**
 * Never run a PATH `wacli`. Size and SHA-256 are checked before unpacking and `wacli version`
 * before the record (the commit point) names a tree, so a failed install keeps the previous one.
 * One install at a time; macOS quarantine and signing state are left as they are.
 */
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import { runWacli, wacliBaseEnvironment } from "./wacliProcess.ts";
import { artifactUrlRejection } from "../latex/LatexManagedToolchain.ts";
import * as PandocArchiveUnpacker from "../pandoc/PandocArchiveUnpacker.ts";
import { WacliInstall, WacliInstallError } from "./WacliInstall.ts";
import {
  WACLI_ALLOWED_HOSTS,
  WacliManifestRef,
  resolveWacliAsset,
  type WacliAsset,
} from "./wacliManifest.ts";

const MAX_REDIRECTS = 5;
/** Ceiling over the whole install: download, unpack and the version check. */
const INSTALL_TIMEOUT = "10 minutes";
const VERSION_CHECK_TIMEOUT = "30 seconds";
const VERSION_CHECK_MAX_OUTPUT_BYTES = 64 * 1024;
/** Matches {@link installRootName}, so cleanup only touches install directories. */
const INSTALL_DIR_PREFIX = "wacli-";
const RECORD_FILE = "install.json";

/**
 * Written once, atomically, after the unpacked program passed its version check. Discovery
 * reads nothing but this file, so a tree it does not name is invisible.
 */
const WacliInstallRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  version: Schema.String.check(Schema.isNonEmpty()),
  /** The pinned archive digest the tree was unpacked from. */
  sha256: Schema.String.check(Schema.isNonEmpty()),
  installedAtEpochMs: Schema.Number,
  /** Absolute path of the unpacked tree. */
  root: Schema.String.check(Schema.isNonEmpty()),
});
const WacliInstallRecordJson = Schema.fromJsonString(WacliInstallRecord);
const decodeRecord = Schema.decodeUnknownEffect(WacliInstallRecordJson);
const encodeRecord = Schema.encodeEffect(WacliInstallRecordJson);

const DOWNLOAD_FAILED =
  "Scient could not download WhatsApp support. Check your internet connection and try again.";
const DOWNLOAD_MISMATCH =
  "The WhatsApp support download was not the file Scient expected, so it was not installed. Try again later.";
const SETUP_FAILED = "Scient could not set up WhatsApp support on this computer. Try again.";

/** `message` is what the person sees; `detail` goes only to the log. */
class InstallStepFailure extends Schema.TaggedError<InstallStepFailure>()("InstallStepFailure", {
  message: Schema.String,
  detail: Schema.String,
}) {}

const failStep = (message: string, detail: string) =>
  Effect.fail(new InstallStepFailure({ message, detail }));

/**
 * A root outside the install directory is rejected rather than run, so a tampered record cannot
 * point WhatsApp at an arbitrary executable.
 */
function isContained(root: string, binDir: string, resolve: (path: string) => string): boolean {
  const resolvedRoot = resolve(root).replaceAll("\\", "/");
  const resolvedBin = resolve(binDir).replaceAll("\\", "/").replace(/\/$/u, "");
  return resolvedRoot.startsWith(`${resolvedBin}/`);
}

/** `wacli version` prints the bare version; tolerate a `wacli ` or `v` prefix. */
function reportsVersion(stdout: string, version: string): boolean {
  const firstLine = stdout.split(/\r?\n/u)[0]?.trim() ?? "";
  return firstLine.replace(/^wacli\s+/u, "").replace(/^v/u, "") === version;
}

const make = Effect.gen(function* () {
  const manifest = yield* WacliManifestRef;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const unpacker = yield* PandocArchiveUnpacker.PandocArchiveUnpacker;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const versionEnv = wacliBaseEnvironment(yield* HostProcess.Environment);
  const platform = yield* HostProcess.Platform;
  const lookup = resolveWacliAsset(platform, yield* HostProcess.Architecture, manifest);

  const binDir = path.join(config.stateDir, "whatsapp", "bin");
  const recordPath = path.join(binDir, RECORD_FILE);
  // Dot-prefixed so a half-finished install is never mistaken for an install.
  const stagingRoot = path.join(binDir, ".staging");
  const gate = yield* Semaphore.make(1);

  /**
   * The recorded executable, or `null` when there is none for the pinned release and digest, the
   * record points outside the install directory, or the executable has gone missing.
   */
  const installedExecutable = Effect.fn("WacliInstall.installedExecutable")(function* (
    asset: WacliAsset,
  ) {
    const contents = yield* fileSystem
      .readFileString(recordPath)
      .pipe(Effect.orElseSucceed(() => null));
    if (contents === null) return null;
    const record = yield* decodeRecord(contents).pipe(Effect.orElseSucceed(() => null));
    if (
      record === null ||
      record.version !== manifest.version ||
      record.sha256 !== asset.sha256 ||
      !isContained(record.root, binDir, path.resolve)
    ) {
      return null;
    }
    const executable = path.join(record.root, asset.executableRelativePath);
    const present = yield* fileSystem.exists(executable).pipe(Effect.orElseSucceed(() => false));
    return present ? executable : null;
  });

  const openArtifact = Effect.fn("WacliInstall.openArtifact")(function* (url: string) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const rejection = artifactUrlRejection(current, WACLI_ALLOWED_HOSTS);
      if (rejection !== null) return yield* failStep(DOWNLOAD_FAILED, rejection);
      const response = yield* Effect.tryPromise({
        try: (signal) => fetch(current, { redirect: "manual", signal }),
        catch: (cause) =>
          new InstallStepFailure({ message: DOWNLOAD_FAILED, detail: String(cause) }),
      });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      yield* Effect.promise(async () => {
        await response.body?.cancel().catch(() => undefined);
      });
      if (location === null) return yield* failStep(DOWNLOAD_FAILED, "redirect without location");
      current = new URL(location, current).href;
    }
    return yield* failStep(DOWNLOAD_FAILED, "too many redirects");
  });

  /** Streams the archive to `destination`, checking its size and digest on the way. */
  const download = Effect.fn("WacliInstall.download")(function* (
    asset: WacliAsset,
    destination: string,
  ) {
    const response = yield* openArtifact(asset.url);
    const body = response.body;
    const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    const declaredMismatch = Number.isSafeInteger(declared) && declared !== asset.sizeBytes;
    if (!response.ok || body === null || declaredMismatch) {
      yield* Effect.promise(async () => {
        await response.body?.cancel().catch(() => undefined);
      });
      return yield* declaredMismatch
        ? failStep(DOWNLOAD_MISMATCH, `declared ${String(declared)} bytes`)
        : failStep(DOWNLOAD_FAILED, `HTTP ${String(response.status)}`);
    }

    const hash = NodeCrypto.createHash("sha256");
    const receivedRef = yield* Ref.make(0);
    yield* Stream.fromReadableStream<Uint8Array, InstallStepFailure>({
      evaluate: () => body,
      onError: (cause) =>
        new InstallStepFailure({ message: DOWNLOAD_FAILED, detail: String(cause) }),
    }).pipe(
      Stream.tap((chunk) =>
        Effect.gen(function* () {
          const received = yield* Ref.updateAndGet(receivedRef, (total) => total + chunk.length);
          if (received > asset.sizeBytes) {
            return yield* failStep(DOWNLOAD_MISMATCH, "larger than pinned");
          }
          hash.update(chunk);
        }),
      ),
      Stream.run(fileSystem.sink(destination, { flag: "wx" })),
    );
    const received = yield* Ref.get(receivedRef);
    if (received !== asset.sizeBytes) {
      return yield* failStep(DOWNLOAD_MISMATCH, `received ${String(received)} bytes`);
    }
    const digest = hash.digest("hex");
    if (digest !== asset.sha256.toLowerCase()) {
      return yield* failStep(DOWNLOAD_MISMATCH, `sha256 ${digest}`);
    }
  });

  /** Unpacks into `payloadPath` and proves the program starts and is the pinned release. */
  const unpackAndVerify = Effect.fn("WacliInstall.unpackAndVerify")(function* (
    asset: WacliAsset,
    archivePath: string,
    payloadPath: string,
  ) {
    yield* fileSystem.makeDirectory(payloadPath, { recursive: true });
    yield* unpacker
      .unpack({ archivePath, destination: payloadPath, archive: asset.archive })
      .pipe(Effect.catch((cause) => failStep(SETUP_FAILED, cause.detail)));
    const executable = path.join(payloadPath, asset.executableRelativePath);
    const present = yield* fileSystem.exists(executable).pipe(Effect.orElseSucceed(() => false));
    if (!present) return yield* failStep(SETUP_FAILED, "archive has no executable");
    if (platform !== "win32") yield* fileSystem.chmod(executable, 0o755);
    // The same minimal environment as every other wacli run: no provider keys or Scient tokens.
    const result = yield* runWacli({
      executable,
      args: ["version"],
      env: versionEnv,
      command: "version",
      timeout: VERSION_CHECK_TIMEOUT,
      maxStdoutBytes: VERSION_CHECK_MAX_OUTPUT_BYTES,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.catch((cause) => failStep(SETUP_FAILED, `did not start: ${cause.message}`)),
    );
    if (result.exitCode !== 0 || !reportsVersion(result.stdout, manifest.version)) {
      return yield* failStep(
        SETUP_FAILED,
        `version check: code ${String(result.exitCode)}, stdout ${result.stdout.slice(0, 80).trim()}`,
      );
    }
  });

  /** Moves the verified tree into place and commits it by writing the record. */
  const activate = Effect.fn("WacliInstall.activate")(function* (
    asset: WacliAsset,
    payloadPath: string,
  ) {
    const root = path.join(
      binDir,
      `${INSTALL_DIR_PREFIX}${manifest.version}-${NodeCrypto.randomUUID().slice(0, 8)}`,
    );
    yield* fileSystem.rename(payloadPath, root);
    const contents = yield* encodeRecord({
      schemaVersion: 1,
      version: manifest.version,
      sha256: asset.sha256,
      installedAtEpochMs: yield* Clock.currentTimeMillis,
      root,
    }).pipe(Effect.orDie);
    yield* writeFileStringAtomically({ filePath: recordPath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    return root;
  });

  /**
   * Best-effort removal of install directories the record no longer names. A removal that fails
   * (Windows, while an older `wacli.exe` still runs) is left for the next install.
   */
  const removeSuperseded = (keep: string) =>
    fileSystem.readDirectory(binDir).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          entries.filter((entry) => entry.startsWith(INSTALL_DIR_PREFIX)),
          (entry) => {
            const candidate = path.join(binDir, entry);
            return candidate === keep
              ? Effect.void
              : fileSystem.remove(candidate, { recursive: true, force: true });
          },
          { discard: true, concurrency: 1 },
        ),
      ),
      Effect.ignoreCause,
    );

  const install = Effect.fn("WacliInstall.install")(
    function* (asset: WacliAsset) {
      // Only this process's gated install uses staging, so anything left there is a crash's.
      yield* fileSystem
        .remove(stagingRoot, { recursive: true, force: true })
        .pipe(Effect.ignoreCause);
      yield* fileSystem.makeDirectory(stagingRoot, { recursive: true });
      const staging = yield* fileSystem.makeTempDirectory({
        directory: stagingRoot,
        prefix: "install-",
      });
      const root = yield* Effect.gen(function* () {
        const archivePath = path.join(staging, asset.fileName);
        const payloadPath = path.join(staging, "payload");
        yield* download(asset, archivePath);
        yield* unpackAndVerify(asset, archivePath, payloadPath);
        return yield* activate(asset, payloadPath);
      }).pipe(
        Effect.ensuring(
          fileSystem.remove(staging, { recursive: true, force: true }).pipe(Effect.ignoreCause),
        ),
      );
      yield* removeSuperseded(root);
      return path.join(root, asset.executableRelativePath);
    },
    (effect) =>
      effect.pipe(
        Effect.catchTags({
          PlatformError: (cause) => failStep(SETUP_FAILED, cause.message),
        }),
        Effect.timeoutOption(INSTALL_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              failStep(
                "Installing WhatsApp support took too long and was stopped. Try again.",
                "timed out",
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.tapError((failure) =>
          Effect.logWarning("scient whatsapp: wacli install failed", { detail: failure.detail }),
        ),
        Effect.mapError(
          (failure) =>
            new WacliInstallError({ reason: "install-failed", message: failure.message }),
        ),
      ),
  );

  const executable: WacliInstall["Service"]["executable"] = lookup.supported
    ? Effect.gen(function* () {
        const ready = yield* installedExecutable(lookup.asset);
        if (ready !== null) return ready;
        return yield* gate.withPermits(1)(
          Effect.gen(function* () {
            // A caller that waited on the gate finds the install the previous holder made.
            const installed = yield* installedExecutable(lookup.asset);
            return installed ?? (yield* install(lookup.asset));
          }),
        );
      })
    : Effect.fail(
        new WacliInstallError({ reason: "unsupported-platform", message: lookup.message }),
      );

  return WacliInstall.of({ supported: lookup.supported, executable });
});

export const layer = Layer.effect(WacliInstall, make).pipe(
  Layer.provide(PandocArchiveUnpacker.layer),
);
