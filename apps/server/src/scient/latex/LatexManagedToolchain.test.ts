// @effect-diagnostics nodeBuiltinImport:off -- The install is exercised against a local HTTP server serving a fixture archive.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  LatexArchiveUnpackError,
  LatexArchiveUnpacker,
  type LatexArchiveUnpackInput,
} from "./LatexArchiveUnpacker.ts";
import {
  LatexManagedToolchain,
  artifactUrlRejection,
  make as makeManagedToolchain,
} from "./LatexManagedToolchain.ts";
import { LatexToolchain, make as makeToolchain } from "./LatexToolchain.ts";
import { decodeManagedLatexInstallRecord, managedLatexPaths } from "./managedLatexInstall.ts";
import { TinyTexManifestRef, type TinyTexManifest } from "./tinytexManifest.ts";

const VERSION = "2026.08";
const EXECUTABLE_RELATIVE_PATH = "TinyTeX/bin/windows/latexmk.exe";
const LATEXMK_BANNER = "Latexmk, John Collins, 9 March 2026. Version 4.88\n";
/** Stands in for the 70 MB bundle; nothing here downloads the real one. */
const ARTIFACT_BODY = new TextEncoder().encode("pretend this is a LaTeX distribution");
const ARTIFACT_DIGEST = NodeCrypto.createHash("sha256").update(ARTIFACT_BODY).digest("hex");

interface ArtifactServer {
  readonly url: string;
  readonly requests: () => number;
  /** Lets a held response finish, for the single-flight case. */
  readonly release: () => void;
}

const startArtifactServer = (options: { readonly hold?: boolean } = {}) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      let requests = 0;
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const server = NodeHttp.createServer((_request, response) => {
        requests += 1;
        const send = () => {
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(ARTIFACT_BODY.byteLength),
          });
          response.end(Buffer.from(ARTIFACT_BODY));
        };
        if (options.hold === true) void held.then(send);
        else send();
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      return {
        server,
        handle: {
          url: `http://127.0.0.1:${String(port)}/TinyTeX-1-windows.exe`,
          requests: () => requests,
          release: () => release(),
        } satisfies ArtifactServer,
      };
    }),
    ({ server, handle }) =>
      Effect.promise(async () => {
        handle.release();
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }),
  );

const manifestFor = (input: {
  readonly url: string;
  readonly sha256?: string;
  readonly platform?: "win32" | "darwin";
}): TinyTexManifest => {
  const asset = {
    fileName: "TinyTeX-1-windows.exe",
    url: input.url,
    sha256: input.sha256 ?? ARTIFACT_DIGEST,
    sizeBytes: ARTIFACT_BODY.byteLength,
    archive: "seven-zip-sfx" as const,
    executableRelativePath: EXECUTABLE_RELATIVE_PATH,
  };
  return { version: VERSION, assets: { win32: asset, darwin: null, linux: null } };
};

const processOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** A fake engine that only answers for a binary that exists on disk. */
const runnerLayer = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          const present = yield* fileSystem
            .exists(input.command)
            .pipe(Effect.orElseSucceed(() => false));
          return present
            ? processOutput(LATEXMK_BANNER)
            : yield* new ProcessRunner.ProcessSpawnError({
                command: input.command,
                argumentCount: input.args.length,
                cause: new Error("spawn ENOENT"),
              });
        }),
    }),
  );
});

const unpackerLayer = (input: {
  readonly unsupported?: boolean;
  readonly seen: Ref.Ref<ReadonlyArray<LatexArchiveUnpackInput>>;
  readonly unpackedBytes: Ref.Ref<string | null>;
}) =>
  Layer.effect(
    LatexArchiveUnpacker,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return LatexArchiveUnpacker.of({
        unpack: (unpackInput) =>
          Effect.gen(function* () {
            yield* Ref.update(input.seen, (previous) => [...previous, unpackInput]);
            if (input.unsupported === true) {
              return yield* new LatexArchiveUnpackError({
                reason: "unsupported-archive",
                detail: "Scient cannot expand this bundle.",
              });
            }
            // Reading the staged archive proves the download landed where the
            // unpacker was pointed, not merely that a file was created.
            const contents = yield* fileSystem
              .readFileString(unpackInput.archivePath)
              .pipe(Effect.orDie);
            yield* Ref.set(input.unpackedBytes, contents);
            const target = path.join(unpackInput.destination, EXECUTABLE_RELATIVE_PATH);
            yield* fileSystem
              .makeDirectory(path.dirname(target), { recursive: true })
              .pipe(Effect.orDie);
            yield* fileSystem.writeFileString(target, "engine").pipe(Effect.orDie);
          }),
      });
    }),
  );

const makeHarness = (input: {
  readonly manifest: TinyTexManifest;
  readonly platform?: NodeJS.Platform;
  readonly unsupportedArchive?: boolean;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-latex-managed-" });
    const latexDir = path.join(baseDir, "userdata", "latex");
    const paths = managedLatexPaths({ latexDir, join: path.join });
    const seen = yield* Ref.make<ReadonlyArray<LatexArchiveUnpackInput>>([]);
    const unpackedBytes = yield* Ref.make<string | null>(null);

    const serviceLayer = Layer.effect(LatexManagedToolchain, makeManagedToolchain).pipe(
      Layer.provide(
        unpackerLayer({
          seen,
          unpackedBytes,
          ...(input.unsupportedArchive === true ? { unsupported: true } : {}),
        }),
      ),
      Layer.provideMerge(
        Layer.effect(LatexToolchain, makeToolchain).pipe(Layer.provide(yield* runnerLayer)),
      ),
      Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(Layer.succeed(HostProcessPlatform, input.platform ?? "win32")),
      Layer.provide(Layer.succeed(TinyTexManifestRef, input.manifest)),
    );

    return { serviceLayer, paths, seen, unpackedBytes, latexDir };
  });

const awaitInstall = (managed: LatexManagedToolchain["Service"]) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const state = yield* managed.status;
      if (state.state === "ready" || state.state === "failed") return state;
      yield* Effect.sleep(Duration.millis(5));
    }
    return yield* managed.status;
  });

const stagingEntries = (stagingRoot: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readDirectory(stagingRoot).pipe(Effect.orElseSucceed(() => []));
  });

/** The install discovery would use: the state file is the only thing that says. */
const currentInstallRoot = (statePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = yield* fileSystem.readFileString(statePath).pipe(Effect.orDie);
    const record = yield* decodeManagedLatexInstallRecord(contents).pipe(Effect.orDie);
    return record.root;
  });

const forwardSlashes = (value: string) => value.replaceAll("\\", "/");

describe("artifactUrlRejection", () => {
  it("accepts the pinned release host and refuses anything else", () => {
    expect(
      artifactUrlRejection("https://github.com/rstudio/tinytex-releases/releases/download/x/y.exe"),
    ).toBeNull();
    expect(artifactUrlRejection("http://github.com/rstudio/x.exe")).toBe(
      "Downloads must use HTTPS.",
    );
    expect(artifactUrlRejection("https://example.com/x.exe")).toBe(
      "Downloads from example.com are not allowed.",
    );
    expect(artifactUrlRejection("https://user:pass@github.com/x.exe")).toBe(
      "A download address may not carry credentials.",
    );
    // The loopback exception exists only so this suite can drive the real path.
    expect(artifactUrlRejection("http://127.0.0.1:1234/x.exe")).toBeNull();
  });
});

describe("LatexManagedToolchain", () => {
  it.live("installs the pinned distribution and makes it the toolchain", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* startArtifactServer();
      const harness = yield* makeHarness({ manifest: manifestFor({ url: server.handle.url }) });

      yield* Effect.gen(function* () {
        const managed = yield* LatexManagedToolchain;
        const toolchain = yield* LatexToolchain;
        expect(managed.canInstall).toBe(true);

        // The engine is genuinely absent before the install.
        const before = yield* toolchain.probe(false);
        expect(before.kind).toBeNull();

        const begun = yield* managed.install;
        expect(begun.state).toBe("downloading");
        expect(begun.version).toBe(VERSION);

        const finished = yield* awaitInstall(managed);
        expect(finished.state).toBe("ready");
        expect(finished.failureReason).toBeNull();
        expect(finished.version).toBe(VERSION);

        expect(yield* Ref.get(harness.unpackedBytes)).toBe(new TextDecoder().decode(ARTIFACT_BODY));

        expect(yield* fileSystem.exists(harness.paths.statePath)).toBe(true);
        const installRoot = yield* currentInstallRoot(harness.paths.statePath);
        // One directory per install, under the managed root and nowhere else.
        const rootPrefix = `${forwardSlashes(harness.paths.managedRoot)}/tinytex-${VERSION}-`;
        expect(forwardSlashes(installRoot).startsWith(rootPrefix)).toBe(true);
        expect(forwardSlashes(installRoot).slice(rootPrefix.length)).toMatch(/^[0-9a-f]{8}$/u);
        const installedEngine = path.join(installRoot, EXECUTABLE_RELATIVE_PATH);
        expect(yield* fileSystem.exists(installedEngine)).toBe(true);
        expect(yield* stagingEntries(harness.paths.stagingRoot)).toEqual([]);

        // The install dropped the probe cache before reporting itself ready, so
        // the very next poll sees the engine without asking for a refresh.
        const after = yield* toolchain.probe(false);
        expect(after.kind).toBe("latexmk");
        expect(after.source).toBe("scient-managed");
        expect(after.executable?.replaceAll("\\", "/")).toBe(installedEngine.replaceAll("\\", "/"));
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("puts a second install beside the first instead of over it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* startArtifactServer();
      const harness = yield* makeHarness({ manifest: manifestFor({ url: server.handle.url }) });

      yield* Effect.gen(function* () {
        const managed = yield* LatexManagedToolchain;
        yield* managed.install;
        expect((yield* awaitInstall(managed)).state).toBe("ready");
        const first = yield* currentInstallRoot(harness.paths.statePath);

        yield* managed.install;
        expect((yield* awaitInstall(managed)).state).toBe("ready");
        const second = yield* currentInstallRoot(harness.paths.statePath);

        // Reusing the path would mean removing a tree an engine may be running
        // out of — a removal Windows refuses halfway, leaving no install at
        // all. The old one is left whole and the state file is what moves.
        expect(second).not.toBe(first);
        expect(yield* fileSystem.exists(path.join(first, EXECUTABLE_RELATIVE_PATH))).toBe(true);
        expect(yield* fileSystem.exists(path.join(second, EXECUTABLE_RELATIVE_PATH))).toBe(true);
        expect(yield* stagingEntries(harness.paths.stagingRoot)).toEqual([]);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("discards a download whose digest is not the pinned one", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const server = yield* startArtifactServer();
      const harness = yield* makeHarness({
        manifest: manifestFor({ url: server.handle.url, sha256: "b".repeat(64) }),
      });

      yield* Effect.gen(function* () {
        const managed = yield* LatexManagedToolchain;
        yield* managed.install;
        const finished = yield* awaitInstall(managed);

        expect(finished.state).toBe("failed");
        expect(finished.failureReason).toBe("checksum-mismatch");
        // Nothing was unpacked, and the partial download did not survive.
        expect(yield* Ref.get(harness.seen)).toEqual([]);
        expect(yield* stagingEntries(harness.paths.stagingRoot)).toEqual([]);
        expect(yield* fileSystem.exists(harness.paths.statePath)).toBe(false);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("answers a second request with the install already running", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer({ hold: true });
      const harness = yield* makeHarness({ manifest: manifestFor({ url: server.handle.url }) });

      yield* Effect.gen(function* () {
        const managed = yield* LatexManagedToolchain;
        const first = yield* managed.install;
        const second = yield* managed.install;

        expect(first.state).toBe("downloading");
        expect(second.state).toBe("downloading");
        expect(second.updatedAtEpochMs).toBe(first.updatedAtEpochMs);

        server.handle.release();
        const finished = yield* awaitInstall(managed);
        expect(finished.state).toBe("ready");
        // One install ran, so the artifact was fetched once.
        expect(server.handle.requests()).toBe(1);
        expect(yield* Ref.get(harness.seen)).toHaveLength(1);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("refuses on a platform Scient has pinned nothing for", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const harness = yield* makeHarness({
        manifest: manifestFor({ url: server.handle.url }),
        platform: "darwin",
      });

      yield* Effect.gen(function* () {
        const managed = yield* LatexManagedToolchain;
        expect(managed.canInstall).toBe(false);
        const refused = yield* managed.install;

        expect(refused.state).toBe("failed");
        expect(refused.failureReason).toBe("unsupported-platform");
        expect(server.handle.requests()).toBe(0);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("reports an archive it has no way to expand", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const harness = yield* makeHarness({
        manifest: manifestFor({ url: server.handle.url }),
        unsupportedArchive: true,
      });

      yield* Effect.gen(function* () {
        const managed = yield* LatexManagedToolchain;
        yield* managed.install;
        const finished = yield* awaitInstall(managed);

        expect(finished.state).toBe("failed");
        expect(finished.failureReason).toBe("unsupported-archive");
        expect(yield* stagingEntries(harness.paths.stagingRoot)).toEqual([]);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
