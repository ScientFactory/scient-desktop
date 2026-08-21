// @effect-diagnostics nodeBuiltinImport:off -- native receipt fixture hashing.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { SyncTexRuntime, layer, syncTexRuntimePlatformKey } from "./SyncTexRuntime.ts";

const runtimeLayer = (command: string, cwd: string) => {
  const configured = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return ServerConfig.make({ ...config, syncTexNavigatorPath: command });
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(cwd, { prefix: "synctex-runtime" })));
  return layer.pipe(
    Layer.provide(configured),
    Layer.provideMerge(Layer.succeed(HostProcessPlatform, "darwin")),
    Layer.provideMerge(Layer.succeed(HostProcessArchitecture, "arm64")),
    Layer.provideMerge(NodeServices.layer),
  );
};
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

describe("SyncTexRuntime", () => {
  it("maps every released desktop and server target", () => {
    expect(syncTexRuntimePlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(syncTexRuntimePlatformKey("darwin", "x64")).toBe("darwin-x64");
    expect(syncTexRuntimePlatformKey("linux", "x64")).toBe("linux-x64");
    expect(syncTexRuntimePlatformKey("win32", "x64")).toBe("win32-x64");
  });

  it("keeps unqualified platforms explicit", () => {
    expect(syncTexRuntimePlatformKey("freebsd", "x64")).toBeNull();
    expect(syncTexRuntimePlatformKey("linux", "ia32")).toBeNull();
    expect(syncTexRuntimePlatformKey("linux", "arm64")).toBeNull();
    expect(syncTexRuntimePlatformKey("win32", "arm64")).toBeNull();
  });

  it.effect("accepts an exact verified helper and rejects modified bytes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synctex-runtime-test-" });
      const executable = path.join(root, "synctex");
      const bytes = new TextEncoder().encode("verified helper");
      yield* fileSystem.writeFile(executable, bytes);
      yield* fileSystem.chmod(executable, 0o555);
      const receipt = yield* encodeUnknownJson({
        schemaVersion: 1,
        component: "synctex",
        cliVersion: "1.7",
        parserVersion: "1.31",
        platformKey: "darwin-arm64",
        files: [
          {
            file: "synctex",
            size: bytes.byteLength,
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      });
      yield* fileSystem.writeFileString(path.join(root, "provenance.json"), `${receipt}\n`);

      const resolved = yield* SyncTexRuntime.pipe(
        Effect.flatMap((runtime) => runtime.resolve),
        Effect.provide(runtimeLayer(executable, root)),
      );
      expect(resolved).toEqual({ command: executable, source: "bundled" });
      expect((yield* fileSystem.stat(executable)).mode & 0o777).toBe(0o555);

      yield* fileSystem.chmod(executable, 0o755);
      yield* fileSystem.writeFileString(executable, "modified");
      const error = yield* SyncTexRuntime.pipe(
        Effect.flatMap((runtime) => runtime.resolve),
        Effect.provide(runtimeLayer(executable, root)),
        Effect.flip,
      );
      expect(error.reason).toBe("damaged");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("restores execute bits only after verifying a copied POSIX helper", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "synctex-runtime-mode-" });
      const executable = path.join(root, "synctex");
      const bytes = new TextEncoder().encode("verified copied helper");
      yield* fileSystem.writeFile(executable, bytes);
      yield* fileSystem.chmod(executable, 0o644);
      const receipt = yield* encodeUnknownJson({
        schemaVersion: 1,
        component: "synctex",
        cliVersion: "1.7",
        parserVersion: "1.31",
        platformKey: "darwin-arm64",
        files: [
          {
            file: "synctex",
            size: bytes.byteLength,
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      });
      yield* fileSystem.writeFileString(path.join(root, "provenance.json"), `${receipt}\n`);

      yield* SyncTexRuntime.pipe(
        Effect.flatMap((runtime) => runtime.resolve),
        Effect.provide(runtimeLayer(executable, root)),
      );
      expect((yield* fileSystem.stat(executable)).mode & 0o777).toBe(0o755);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
