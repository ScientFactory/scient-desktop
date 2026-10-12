// @effect-diagnostics nodeBuiltinImport:off -- Native stat verifies POSIX permission bits at the packaging boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { stageScientSyncTexRuntimeForDesktopBuild } from "./scient-synctex-build.ts";

const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

describe("scient SyncTeX build adapter", () => {
  it.effect.each(["mac", "linux", "win"] as const)(
    "stages a verified %s runtime without mutating its source",
    (platform) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-synctex-build-" });
        const source = path.join(root, "source");
        const resources = path.join(root, "resources");
        yield* fileSystem.makeDirectory(source, { recursive: true });
        const executable = platform === "win" ? "synctex.exe" : "synctex";
        const payloadFiles = [executable, "LICENSE.synctex", "LICENSE.zlib"];
        const expectedHashes: Record<string, string> = {
          [executable]: "7af644f4974ee9e0de8b906a55d4d93216310131e87ca3f6067df3565fc8c5a2",
          "LICENSE.synctex": "b8eaac6560c7cbe6f51eeddd77fca6c08feb97d06ab9c6fd58e23f993e70cd46",
          "LICENSE.zlib": "6fcf80a11553048846b03522780d218a026a366d7f424e841786990ab2616fe0",
        };
        for (const file of payloadFiles) {
          yield* fileSystem.writeFileString(
            path.join(source, file),
            file === executable ? "synctex" : file,
          );
          yield* fileSystem.chmod(path.join(source, file), 0o644);
        }
        yield* fileSystem.writeFileString(
          path.join(source, "provenance.json"),
          yield* encodeUnknownJson({
            schemaVersion: 1,
            component: "synctex",
            platformKey: `${platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux"}-arm64`,
            files: payloadFiles.map((file) => ({
              file,
              size: Buffer.byteLength(file === executable ? "synctex" : file),
              sha256: expectedHashes[file],
            })),
          }),
        );

        yield* Effect.promise(() =>
          stageScientSyncTexRuntimeForDesktopBuild({
            repoRoot: root,
            stageResourcesDir: resources,
            platform,
            arch: "arm64",
            sourceDirectory: source,
            verbose: false,
          }),
        );

        assert.equal(
          yield* fileSystem.readFileString(path.join(resources, "synctex-runtime", executable)),
          "synctex",
        );
        assert.equal(yield* fileSystem.readFileString(path.join(source, executable)), "synctex");
        for (const file of [...payloadFiles, "provenance.json"]) {
          assert.equal(
            yield* fileSystem.readFileString(path.join(resources, "synctex-runtime", file)),
            yield* fileSystem.readFileString(path.join(source, file)),
          );
        }
        if ((yield* HostProcess.Platform) !== "win32") {
          const sourceStat = yield* Effect.promise(() =>
            NodeFSP.stat(path.join(source, executable)),
          );
          const stagedStat = yield* Effect.promise(() =>
            NodeFSP.stat(path.join(resources, "synctex-runtime", executable)),
          );
          assert.equal(sourceStat.mode & 0o777, 0o644);
          assert.equal(stagedStat.mode & 0o777, platform === "win" ? 0o644 : 0o755);
          for (const file of ["LICENSE.synctex", "LICENSE.zlib", "provenance.json"]) {
            const staged = yield* Effect.promise(() =>
              NodeFSP.stat(path.join(resources, "synctex-runtime", file)),
            );
            assert.equal(staged.mode & 0o111, 0);
          }
        }
        // A corrupt download must fail before replacing the verified staging
        // destination or repairing permissions on the source.
        yield* fileSystem.writeFileString(path.join(source, executable), "corrupt");
        const error = yield* Effect.tryPromise(() =>
          stageScientSyncTexRuntimeForDesktopBuild({
            repoRoot: root,
            stageResourcesDir: resources,
            platform,
            arch: "arm64",
            sourceDirectory: source,
            verbose: false,
          }),
        ).pipe(Effect.flip);
        assert.include(String(error.cause), "failed integrity verification");
        assert.equal(
          yield* fileSystem.readFileString(path.join(resources, "synctex-runtime", executable)),
          "synctex",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
