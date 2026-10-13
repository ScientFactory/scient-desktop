// @effect-diagnostics nodeBuiltinImport:off -- Real binary, filesystem and restart/update fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../../config.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import {
  bytesRevision,
  decodeRetainedRecord,
  mutateRetainedFile,
  type MutationPoint,
} from "./RetainedFileMutation.ts";
import { fileExchangeTestHelper } from "./fileExchange.testkit.ts";

const compiled = await fileExchangeTestHelper();
const bytes = (s: string) => Buffer.from(s);
const configuredFiles = (root: string, helper: string | undefined) =>
  WorkspaceFileSystem.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return ServerConfig.make({ ...config, fileExchangePath: helper });
        }),
      ).pipe(Layer.provide(ServerConfig.layerTest(root, { prefix: "scient-exchange-config-" }))),
    ),
  );

describe.skipIf(compiled === undefined)("host-configured file exchange", () => {
  it.live.each(["checked", "displaced", "installed", "done"] as MutationPoint[])(
    "resumes %s through an updated resource path",
    (point) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "scient-exchange-update-" }),
        );
        const cwd = NodePath.join(root, "paper"),
          target = NodePath.join(cwd, "main.tex");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(NodePath.join(root, "records"));
        const oldHelper = NodePath.join(
          root,
          "Old.app/Contents/Resources/file-exchange/scient-file-exchange",
        );
        const newHelper = NodePath.join(
          root,
          "Updated.app/Contents/Resources/file-exchange/scient-file-exchange",
        );
        for (const helper of [oldHelper, newHelper]) {
          yield* fs.makeDirectory(NodePath.dirname(helper), { recursive: true });
          yield* fs.copyFile(compiled!, helper);
          yield* fs.chmod(helper, 0o755);
        }
        yield* fs.writeFileString(target, "captured");
        const input = {
          cwd,
          relativePath: "main.tex",
          retentionDirectory: NodePath.join(root, "records"),
          id: "sync",
          expectedRevision: bytesRevision(bytes("captured")),
          bytes: bytes("merged"),
        };
        let interrupted = false;
        yield* Effect.promise(() =>
          mutateRetainedFile({ ...input, exchangeHelper: oldHelper }, target, {
            at: async (p) => {
              if (!interrupted && p === point) {
                interrupted = true;
                throw new Error("crash");
              }
            },
          }),
        ).pipe(Effect.exit);
        expect(interrupted).toBe(true);
        yield* fs.remove(NodePath.join(root, "Old.app"), { recursive: true });
        if (point === "checked") {
          const missing = yield* Effect.gen(function* () {
            const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
            return yield* files.replaceFileRetained({ ...input, bytes: undefined });
          }).pipe(Effect.provide(configuredFiles(root, oldHelper)), Effect.exit);
          expect(missing._tag).toBe("Failure");
          expect(yield* fs.readFileString(target)).toBe("captured");
          expect(
            decodeRetainedRecord(
              yield* fs.readFileString(NodePath.join(root, "records/sync/record.json")),
            ).mechanism,
          ).toBe("exchange");
        }
        const result = yield* Effect.gen(function* () {
          const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          return yield* files.replaceFileRetained({ ...input, bytes: undefined });
        }).pipe(Effect.provide(configuredFiles(root, newHelper)));
        expect(result.outcome).toBe("done");
        expect(yield* fs.readFileString(target)).toBe("merged");
        expect(
          decodeRetainedRecord(
            yield* fs.readFileString(NodePath.join(root, "records/sync/record.json")),
          ).mechanism,
        ).toBe("exchange");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a missing or incompatible helper without falling back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-exchange-missing-" });
      const cwd = NodePath.join(root, "paper"),
        target = NodePath.join(cwd, "main.tex");
      yield* fs.makeDirectory(cwd);
      yield* fs.makeDirectory(NodePath.join(root, "records"));
      yield* fs.writeFileString(target, "captured");
      const incompatible = NodePath.join(root, "wrong-helper");
      yield* fs.writeFileString(incompatible, "#!/bin/sh\necho scient-file-exchange/2\n", {
        mode: 0o755,
      });
      for (const [id, helper] of [
        ["missing", NodePath.join(root, "absent")],
        ["wrong", incompatible],
      ]) {
        const exit = yield* Effect.gen(function* () {
          const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          return yield* files.replaceFileRetained({
            cwd,
            relativePath: "main.tex",
            id: id!,
            retentionDirectory: NodePath.join(root, "records"),
            expectedRevision: bytesRevision(bytes("captured")),
            bytes: bytes("merged"),
          });
        }).pipe(Effect.provide(configuredFiles(root, helper)), Effect.exit);
        expect(exit._tag).toBe("Failure");
        expect(yield* fs.readFileString(target)).toBe("captured");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the target present during exchanges with concurrent readers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-exchange-read-" });
      const target = NodePath.join(root, "target"),
        slot = NodePath.join(root, "slot");
      yield* fs.writeFileString(target, "old");
      yield* fs.writeFileString(slot, "new");
      yield* Effect.promise(async () => {
        let stop = false,
          reads = 0;
        const reader = (async () => {
          while (!stop) {
            expect(["old", "new"]).toContain(await NodeFSP.readFile(target, "utf8"));
            reads++;
          }
        })();
        try {
          for (let i = 0; i < 25; i++)
            await new Promise<void>((resolve, reject) =>
              NodeChildProcess.execFile(compiled!, [target, slot], (error) =>
                error ? reject(error) : resolve(),
              ),
            );
        } finally {
          stop = true;
          await reader;
        }
        expect(reads).toBeGreaterThan(0);
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
