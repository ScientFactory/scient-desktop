import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { stageScientSyncTexRuntimeForDesktopBuild } from "./scient-synctex-build.ts";

const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

describe("scient SyncTeX build adapter", () => {
  it.effect("copies a verified prebuilt runtime without mutating its source", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-synctex-build-" });
      const source = path.join(root, "source");
      const resources = path.join(root, "resources");
      yield* fileSystem.makeDirectory(source, { recursive: true });
      const payloadFiles = ["synctex", "LICENSE.synctex", "LICENSE.zlib"];
      for (const file of payloadFiles) {
        yield* fileSystem.writeFileString(path.join(source, file), file);
      }
      yield* fileSystem.writeFileString(
        path.join(source, "provenance.json"),
        yield* encodeUnknownJson({
          schemaVersion: 1,
          component: "synctex",
          platformKey: "darwin-arm64",
          files: payloadFiles.map((file) => ({
            file,
            size: Buffer.byteLength(file),
            sha256: NodeCrypto.createHash("sha256").update(file).digest("hex"),
          })),
        }),
      );

      yield* Effect.promise(() =>
        stageScientSyncTexRuntimeForDesktopBuild({
          repoRoot: root,
          stageResourcesDir: resources,
          platform: "mac",
          arch: "arm64",
          sourceDirectory: source,
          verbose: false,
        }),
      );

      assert.equal(
        yield* fileSystem.readFileString(path.join(resources, "synctex-runtime/synctex")),
        "synctex",
      );
      assert.equal(yield* fileSystem.readFileString(path.join(source, "synctex")), "synctex");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
