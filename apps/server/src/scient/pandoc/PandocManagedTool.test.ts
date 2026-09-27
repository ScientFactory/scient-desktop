// @effect-diagnostics nodeBuiltinImport:off -- The install is exercised against a local HTTP server serving a fixture archive.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { managedPandocPaths } from "./managedPandocInstall.ts";
import {
  PandocArchiveUnpackError,
  PandocArchiveUnpacker,
  type PandocArchiveUnpackInput,
} from "./PandocArchiveUnpacker.ts";
import { PandocManagedTool, make as makeManagedTool } from "./PandocManagedTool.ts";
import {
  PandocManifestRef,
  type PandocManifest,
  type PandocPlatformArch,
} from "./pandocManifest.ts";

const EXECUTABLE = "pandoc-3.11-test/bin/pandoc";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
/** Stands in for the 40 MB archive; nothing here downloads the real one. */
const ARCHIVE = new TextEncoder().encode("pretend this is the Pandoc release archive");
const ARCHIVE_DIGEST = NodeCrypto.createHash("sha256").update(ARCHIVE).digest("hex");
const HOST_PLATFORM = HostProcessPlatform.defaultValue();
const HOST_ARCH = HostProcessArchitecture.defaultValue();
const HOST_PAIR = `${HOST_PLATFORM}-${HOST_ARCH}` as PandocPlatformArch;

interface ArtifactServer {
  readonly url: string;
  readonly requests: () => number;
  readonly release: () => void;
}

const startArtifactServer = (
  options: {
    readonly hold?: boolean;
    readonly failFirst?: boolean;
    readonly lieAboutSize?: boolean;
  } = {},
) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      let requests = 0;
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      const server = NodeHttp.createServer((_request, response) => {
        requests += 1;
        if (options.failFirst === true && requests === 1) {
          response.writeHead(500);
          response.end();
          return;
        }
        const send = () => {
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(ARCHIVE.byteLength + (options.lieAboutSize === true ? 1 : 0)),
          });
          response.end(Buffer.from(ARCHIVE));
        };
        if (options.hold === true) void held.then(send);
        else send();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      return {
        server,
        handle: {
          url: `http://127.0.0.1:${String(port)}/pandoc-3.11-test.zip`,
          requests: () => requests,
          release: () => release(),
        } satisfies ArtifactServer,
      };
    }),
    ({ server, handle }) =>
      Effect.promise(async () => {
        handle.release();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }),
  );

const manifestFor = (input: {
  readonly url: string;
  readonly sha256?: string;
}): PandocManifest => ({
  version: "3.11",
  assets: {
    "win32-x64": null,
    "win32-arm64": null,
    "darwin-x64": null,
    "darwin-arm64": null,
    "linux-x64": null,
    "linux-arm64": null,
    [HOST_PAIR]: {
      fileName: "pandoc-3.11-test.zip",
      url: input.url,
      sha256: input.sha256 ?? ARCHIVE_DIGEST,
      sizeBytes: ARCHIVE.byteLength,
      archive: "zip",
      executableRelativePath: EXECUTABLE,
    },
  },
});

/** Unpacks by writing a script that answers `--version` like the pinned release (or not). */
const unpackerLayer = (input: {
  readonly banner: string;
  readonly seen: Ref.Ref<ReadonlyArray<PandocArchiveUnpackInput>>;
  readonly fail?: boolean;
}) =>
  Layer.succeed(
    PandocArchiveUnpacker,
    PandocArchiveUnpacker.of({
      unpack: (request) =>
        Effect.gen(function* () {
          yield* Ref.update(input.seen, (previous) => [...previous, request]);
          if (input.fail === true) {
            return yield* new PandocArchiveUnpackError({
              reason: "unpack-failed",
              detail: "Expanding the Pandoc download failed: corrupt",
            });
          }
          const target = NodePath.join(request.destination, EXECUTABLE);
          NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
          NodeFS.writeFileSync(target, `#!/bin/sh\necho "${input.banner}"\n`, { mode: 0o644 });
        }),
    }),
  );

const makeHarness = (input: {
  readonly manifest: PandocManifest;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly banner?: string;
  readonly unpackFails?: boolean;
  readonly before?: (paths: ReturnType<typeof managedPandocPaths>) => void;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-pandoc-managed-" });
    const stateDir = NodePath.join(baseDir, "userdata");
    const paths = managedPandocPaths({ stateDir, join: NodePath.join });
    input.before?.(paths);
    const seen = yield* Ref.make<ReadonlyArray<PandocArchiveUnpackInput>>([]);
    const serviceLayer = Layer.effect(PandocManagedTool, makeManagedTool).pipe(
      Layer.provide(
        unpackerLayer({
          banner: input.banner ?? "pandoc 3.11",
          seen,
          ...(input.unpackFails === true ? { fail: true } : {}),
        }),
      ),
      Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(Layer.succeed(HostProcessPlatform, input.platform ?? HOST_PLATFORM)),
      Layer.provide(Layer.succeed(HostProcessArchitecture, input.arch ?? HOST_ARCH)),
      Layer.provide(Layer.succeed(PandocManifestRef, input.manifest)),
    );
    return { serviceLayer, paths, seen, baseDir };
  });

const awaitInstall = (tool: PandocManagedTool["Service"]) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const status = yield* tool.status;
      if (status.install.state === "ready" || status.install.state === "failed") return status;
      yield* Effect.sleep(Duration.millis(5));
    }
    return yield* tool.status;
  });

const listFiles = (root: string): Array<string> =>
  NodeFS.existsSync(root)
    ? NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => NodePath.join(entry.parentPath, entry.name))
    : [];

// The install proves the unpacked binary starts by running it; the stand-in is a
// POSIX shell script, which Windows cannot execute.
describe.skipIf(HOST_PLATFORM === "win32")("PandocManagedTool", () => {
  it.live("installs the pinned release into app-owned state and runs only that", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const harness = yield* makeHarness({ manifest: manifestFor({ url: server.handle.url }) });
      yield* Effect.gen(function* () {
        const tool = yield* PandocManagedTool;
        expect(tool.canInstall).toBe(true);
        // Nothing installed: no Pandoc is taken from this computer's PATH.
        expect(yield* tool.command).toBeNull();
        const before = yield* tool.status;
        expect(before.installed).toBe(false);
        expect(before.downloadBytes).toBe(ARCHIVE.byteLength);

        const begun = yield* tool.install;
        expect(begun.install.state).toBe("downloading");
        const finished = yield* awaitInstall(tool);
        expect(finished.install.state).toBe("ready");
        expect(finished.installed).toBe(true);

        const command = yield* tool.command;
        expect(command?.leadingArgs).toEqual([]);
        expect(
          command?.command.startsWith(`${harness.paths.managedRoot}${NodePath.sep}pandoc-3.11-`),
        ).toBe(true);
        expect(command?.command.endsWith(EXECUTABLE)).toBe(true);
        expect(NodeFS.statSync(command!.command).mode & 0o111).not.toBe(0);
        // Every file the install left is under the server's own Pandoc directory.
        for (const file of listFiles(harness.baseDir)) {
          if (file.startsWith(NodePath.join(harness.baseDir, "userdata", "pandoc"))) continue;
          expect(file.includes(`${NodePath.sep}pandoc`)).toBe(false);
        }
        expect(NodeFS.readdirSync(harness.paths.stagingRoot)).toEqual([]);
        expect(NodeFS.readdirSync(harness.paths.scratchRoot)).toEqual([]);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("rejects a download whose digest is not the pinned one, before unpacking", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const harness = yield* makeHarness({
        manifest: manifestFor({ url: server.handle.url, sha256: "b".repeat(64) }),
      });
      yield* Effect.gen(function* () {
        const tool = yield* PandocManagedTool;
        yield* tool.install;
        const finished = yield* awaitInstall(tool);
        expect(finished.install.state).toBe("failed");
        expect(finished.install.failureReason).toBe("checksum-mismatch");
        expect(finished.installed).toBe(false);
        expect(yield* Ref.get(harness.seen)).toEqual([]);
        expect(NodeFS.existsSync(harness.paths.statePath)).toBe(false);
        expect(NodeFS.readdirSync(harness.paths.stagingRoot)).toEqual([]);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("rejects a download that is not the pinned size", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer({ lieAboutSize: true });
      const harness = yield* makeHarness({ manifest: manifestFor({ url: server.handle.url }) });
      yield* Effect.gen(function* () {
        const tool = yield* PandocManagedTool;
        yield* tool.install;
        const finished = yield* awaitInstall(tool);
        expect(finished.install.failureReason).toBe("download-failed");
        expect(NodeFS.existsSync(harness.paths.statePath)).toBe(false);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("refuses to record a binary that is not the pinned release", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const harness = yield* makeHarness({
        manifest: manifestFor({ url: server.handle.url }),
        banner: "pandoc 3.10",
      });
      yield* Effect.gen(function* () {
        const tool = yield* PandocManagedTool;
        yield* tool.install;
        const finished = yield* awaitInstall(tool);
        expect(finished.install.failureReason).toBe("unpack-failed");
        expect(yield* tool.command).toBeNull();
        expect(NodeFS.existsSync(harness.paths.statePath)).toBe(false);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("recovers from an interrupted install by installing again", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer({ failFirst: true });
      const harness = yield* makeHarness({
        manifest: manifestFor({ url: server.handle.url }),
        // What a crash mid-install leaves: a half-written staging directory.
        before: (paths) => {
          NodeFS.mkdirSync(NodePath.join(paths.stagingRoot, "install-crashed", "payload"), {
            recursive: true,
          });
          NodeFS.writeFileSync(
            NodePath.join(paths.stagingRoot, "install-crashed", "pandoc-3.11-test.zip"),
            "partial",
          );
        },
      });
      yield* Effect.gen(function* () {
        const tool = yield* PandocManagedTool;
        yield* tool.install;
        const failed = yield* awaitInstall(tool);
        expect(failed.install.state).toBe("failed");
        expect(failed.install.failureReason).toBe("download-failed");
        expect(failed.installed).toBe(false);

        yield* tool.install;
        const finished = yield* awaitInstall(tool);
        expect(finished.install.state).toBe("ready");
        expect(finished.installed).toBe(true);
        expect(NodeFS.readdirSync(harness.paths.stagingRoot)).toEqual([]);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("answers a second request with the install already running", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer({ hold: true });
      const harness = yield* makeHarness({ manifest: manifestFor({ url: server.handle.url }) });
      yield* Effect.gen(function* () {
        const tool = yield* PandocManagedTool;
        const first = yield* tool.install;
        const second = yield* tool.install;
        expect(first.install.state).toBe("downloading");
        expect(second.install.updatedAtEpochMs).toBe(first.install.updatedAtEpochMs);
        server.handle.release();
        expect((yield* awaitInstall(tool)).install.state).toBe("ready");
        expect(server.handle.requests()).toBe(1);
        expect(yield* Ref.get(harness.seen)).toHaveLength(1);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("reports a platform without a pinned build as unavailable and never downloads", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const harness = yield* makeHarness({
        manifest: manifestFor({ url: server.handle.url }),
        platform: "win32",
        arch: "arm64",
      });
      yield* Effect.gen(function* () {
        const tool = yield* PandocManagedTool;
        expect(tool.canInstall).toBe(false);
        const status = yield* tool.status;
        expect(status.unavailableReason).toContain("win32-arm64");
        expect(status.downloadBytes).toBeNull();
        const refused = yield* tool.install;
        expect(refused.install.state).toBe("failed");
        expect(refused.install.failureReason).toBe("unsupported-platform");
        expect(server.handle.requests()).toBe(0);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("ignores a state file that points outside the managed directory", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const harness = yield* makeHarness({
        manifest: manifestFor({ url: server.handle.url }),
        before: (paths) => {
          const outside = NodePath.join(paths.pandocDir, "..", "elsewhere");
          NodeFS.mkdirSync(NodePath.join(outside, NodePath.dirname(EXECUTABLE)), {
            recursive: true,
          });
          NodeFS.writeFileSync(NodePath.join(outside, EXECUTABLE), "#!/bin/sh\n");
          NodeFS.mkdirSync(paths.managedRoot, { recursive: true });
          NodeFS.writeFileSync(
            paths.statePath,
            encodeJson({
              schemaVersion: 1,
              version: "3.11",
              sha256: ARCHIVE_DIGEST,
              installedAtEpochMs: 0,
              root: outside,
            }),
          );
        },
      });
      yield* Effect.gen(function* () {
        const tool = yield* PandocManagedTool;
        expect(yield* tool.command).toBeNull();
        expect((yield* tool.status).installed).toBe(false);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("sweeps scratch directories a crashed conversion left behind", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const harness = yield* makeHarness({
        manifest: manifestFor({ url: server.handle.url }),
        before: (paths) => {
          const stale = NodePath.join(paths.scratchRoot, "run-stale");
          NodeFS.mkdirSync(NodePath.join(stale, "work"), { recursive: true });
          const old = NodeFS.statSync(stale).mtimeMs / 1000 - 3 * 60 * 60;
          NodeFS.utimesSync(stale, old, old);
          NodeFS.mkdirSync(NodePath.join(paths.scratchRoot, "run-recent"), { recursive: true });
        },
      });
      yield* Effect.gen(function* () {
        yield* PandocManagedTool;
        expect(NodeFS.readdirSync(harness.paths.scratchRoot)).toEqual(["run-recent"]);
      }).pipe(Effect.provide(harness.serviceLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
