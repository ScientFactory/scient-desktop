// @effect-diagnostics nodeBuiltinImport:off -- The install is exercised against a local HTTP server serving a real tar.gz fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import { WacliInstall, type WacliInstallError } from "./WacliInstall.ts";
import * as WacliInstallLive from "./WacliInstallLive.ts";
import { WacliManifestRef, type WacliManifest, type WacliPlatformArch } from "./wacliManifest.ts";

const HOST_PLATFORM = HostProcess.Platform.defaultValue();
const HOST_ARCH = HostProcess.Architecture.defaultValue();
const HOST_PAIR = `${HOST_PLATFORM}-${HOST_ARCH}` as WacliPlatformArch;

/** A release-shaped archive: `./wacli` at the top level, answering `version`. */
function makeArchive(printedVersion: string): Uint8Array {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-wacli-fixture-"));
  try {
    const tree = NodePath.join(dir, "tree");
    NodeFS.mkdirSync(tree);
    // Packed without the execute bit: the install must make it runnable itself.
    NodeFS.writeFileSync(NodePath.join(tree, "wacli"), `#!/bin/sh\necho "${printedVersion}"\n`, {
      mode: 0o644,
    });
    NodeFS.writeFileSync(NodePath.join(tree, "LICENSE"), "MIT\n");
    const archive = NodePath.join(dir, "wacli.tar.gz");
    NodeChildProcess.execFileSync("tar", ["-czf", archive, "-C", tree, "."]);
    return new Uint8Array(NodeFS.readFileSync(archive));
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const GOOD_ARCHIVE = makeArchive("0.26.1");

const startArtifactServer = (
  options: {
    readonly archive?: Uint8Array;
    readonly failFirst?: boolean;
    /** Send the body chunked, so only the streamed byte count can catch a size mismatch. */
    readonly omitLength?: boolean;
  } = {},
) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const archive = options.archive ?? GOOD_ARCHIVE;
      let requests = 0;
      const server = NodeHttp.createServer((_request, response) => {
        requests += 1;
        if (options.failFirst === true && requests === 1) {
          response.writeHead(500);
          response.end();
          return;
        }
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          ...(options.omitLength === true ? {} : { "content-length": String(archive.byteLength) }),
        });
        response.end(Buffer.from(archive));
      });
      const listening = Promise.withResolvers<void>();
      server.listen(0, "127.0.0.1", () => listening.resolve());
      await listening.promise;
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      return {
        server,
        url: `http://127.0.0.1:${String(port)}/wacli_test.tar.gz`,
        requests: () => requests,
      };
    }),
    ({ server }) =>
      Effect.promise(async () => {
        server.closeAllConnections();
        const closed = Promise.withResolvers<void>();
        server.close(() => closed.resolve());
        await closed.promise;
      }),
  );

const manifestFor = (input: {
  readonly url: string;
  readonly sha256?: string;
  readonly sizeBytes?: number;
}): WacliManifest => ({
  version: "0.26.1",
  license: "MIT",
  sourceUrl: "https://example.invalid/wacli-0.26.1.tar.gz",
  assets: {
    "win32-x64": null,
    "win32-arm64": null,
    "darwin-x64": null,
    "darwin-arm64": null,
    "linux-x64": null,
    "linux-arm64": null,
    [HOST_PAIR]: {
      fileName: "wacli_test.tar.gz",
      url: input.url,
      sha256: input.sha256 ?? sha256(GOOD_ARCHIVE),
      sizeBytes: input.sizeBytes ?? GOOD_ARCHIVE.byteLength,
      archive: "tar-gz",
      executableRelativePath: "wacli",
    },
  },
});

/** The live layer over a temp state directory; the same `baseDir` gives the same state. */
const liveLayer = (input: {
  readonly baseDir: string;
  readonly manifest: WacliManifest;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
}) =>
  WacliInstallLive.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(input.baseDir, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(HostProcess.Platform, input.platform ?? HOST_PLATFORM)),
    Layer.provide(Layer.succeed(HostProcess.Architecture, input.arch ?? HOST_ARCH)),
    Layer.provide(Layer.succeed(WacliManifestRef, input.manifest)),
  );

const binDirOf = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return NodePath.join(config.stateDir, "whatsapp", "bin");
});

const executableOf = Effect.gen(function* () {
  return yield* (yield* WacliInstall).executable;
});

const installError = (exit: Exit.Exit<string, WacliInstallError>): WacliInstallError => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failed install, got ${exit.value}`);
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (failure?._tag !== "Fail") throw new Error("expected a typed install failure");
  return failure.error;
};

/** A rejected install leaves nothing installed, nothing staged, and says nothing about paths. */
const expectNothingInstalled = (binDir: string, error: WacliInstallError) => {
  expect(error.reason).toBe("install-failed");
  expect(error.message).not.toMatch(/[/\\]/u);
  expect(NodeFS.existsSync(NodePath.join(binDir, "install.json"))).toBe(false);
  expect(NodeFS.readdirSync(binDir).filter((entry) => entry !== ".staging")).toEqual([]);
  expect(NodeFS.readdirSync(NodePath.join(binDir, ".staging"))).toEqual([]);
};

const tempBaseDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-wacli-install-" });
});

// The fixture executable is a POSIX shell script, which Windows cannot run.
describe.skipIf(HOST_PLATFORM === "win32")("WacliInstallLive", () => {
  it.live("installs the pinned release once, then reuses it without downloading", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const baseDir = yield* tempBaseDir;
      const manifest = manifestFor({ url: server.url });
      const first = yield* Effect.gen(function* () {
        const install = yield* WacliInstall;
        const binDir = yield* binDirOf;
        expect(install.supported).toBe(true);
        const executable = yield* install.executable;
        expect(executable.startsWith(`${binDir}${NodePath.sep}wacli-0.26.1-`)).toBe(true);
        expect(NodePath.basename(executable)).toBe("wacli");
        expect(NodeChildProcess.execFileSync(executable, ["version"], { encoding: "utf8" })).toBe(
          "0.26.1\n",
        );
        expect(NodeFS.existsSync(NodePath.join(binDir, "install.json"))).toBe(true);
        expect(NodeFS.readdirSync(NodePath.join(binDir, ".staging"))).toEqual([]);
        expect(yield* install.executable).toBe(executable);
        return executable;
      }).pipe(Effect.provide(liveLayer({ baseDir, manifest })));
      // A restarted server finds the same install on disk.
      const afterRestart = yield* executableOf.pipe(
        Effect.provide(liveLayer({ baseDir, manifest })),
      );
      expect(afterRestart).toBe(first);
      expect(server.requests()).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("runs one install for concurrent callers", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const baseDir = yield* tempBaseDir;
      const [left, right] = yield* Effect.all([executableOf, executableOf], {
        concurrency: 2,
      }).pipe(Effect.provide(liveLayer({ baseDir, manifest: manifestFor({ url: server.url }) })));
      expect(left).toBe(right);
      expect(server.requests()).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("rejects a download whose digest is not the pinned one", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const baseDir = yield* tempBaseDir;
      yield* Effect.gen(function* () {
        const install = yield* WacliInstall;
        const error = installError(yield* Effect.exit(install.executable));
        expectNothingInstalled(yield* binDirOf, error);
      }).pipe(
        Effect.provide(
          liveLayer({
            baseDir,
            manifest: manifestFor({ url: server.url, sha256: "b".repeat(64) }),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("rejects a download that is not the pinned size, declared or streamed", () =>
    Effect.gen(function* () {
      for (const omitLength of [false, true]) {
        const server = yield* startArtifactServer({ omitLength });
        const baseDir = yield* tempBaseDir;
        // The digest is right for the served bytes, so only the size check can refuse them.
        const manifest = manifestFor({
          url: server.url,
          sizeBytes: GOOD_ARCHIVE.byteLength + 1,
        });
        yield* Effect.gen(function* () {
          const install = yield* WacliInstall;
          const error = installError(yield* Effect.exit(install.executable));
          expectNothingInstalled(yield* binDirOf, error);
        }).pipe(Effect.provide(liveLayer({ baseDir, manifest })));
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("refuses an unpacked program that is not the pinned version", () =>
    Effect.gen(function* () {
      const archive = makeArchive("0.25.0");
      const server = yield* startArtifactServer({ archive });
      const baseDir = yield* tempBaseDir;
      const manifest = manifestFor({
        url: server.url,
        sha256: sha256(archive),
        sizeBytes: archive.byteLength,
      });
      yield* Effect.gen(function* () {
        const install = yield* WacliInstall;
        const error = installError(yield* Effect.exit(install.executable));
        expectNothingInstalled(yield* binDirOf, error);
      }).pipe(Effect.provide(liveLayer({ baseDir, manifest })));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("can be retried after a failed install", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer({ failFirst: true });
      const baseDir = yield* tempBaseDir;
      yield* Effect.gen(function* () {
        const install = yield* WacliInstall;
        const error = installError(yield* Effect.exit(install.executable));
        expect(error.reason).toBe("install-failed");
        const executable = yield* install.executable;
        expect(NodeFS.existsSync(executable)).toBe(true);
      }).pipe(Effect.provide(liveLayer({ baseDir, manifest: manifestFor({ url: server.url }) })));
      expect(server.requests()).toBe(2);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("reinstalls when the recorded executable is missing", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const baseDir = yield* tempBaseDir;
      yield* Effect.gen(function* () {
        const install = yield* WacliInstall;
        const damaged = yield* install.executable;
        NodeFS.rmSync(damaged);
        const repaired = yield* install.executable;
        expect(repaired).not.toBe(damaged);
        expect(NodeChildProcess.execFileSync(repaired, ["version"], { encoding: "utf8" })).toBe(
          "0.26.1\n",
        );
        // The damaged tree is cleared once the record names the new one.
        expect(NodeFS.existsSync(NodePath.dirname(damaged))).toBe(false);
      }).pipe(Effect.provide(liveLayer({ baseDir, manifest: manifestFor({ url: server.url }) })));
      expect(server.requests()).toBe(2);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("reports an unsupported platform without downloading anything", () =>
    Effect.gen(function* () {
      const server = yield* startArtifactServer();
      const baseDir = yield* tempBaseDir;
      yield* Effect.gen(function* () {
        const install = yield* WacliInstall;
        expect(install.supported).toBe(false);
        const error = installError(yield* Effect.exit(install.executable));
        expect(error.reason).toBe("unsupported-platform");
        expect(error.message).toBe("WhatsApp linking is not available on Windows Arm64 yet.");
      }).pipe(
        Effect.provide(
          liveLayer({
            baseDir,
            manifest: manifestFor({ url: server.url }),
            platform: "win32",
            arch: "arm64",
          }),
        ),
      );
      expect(server.requests()).toBe(0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
