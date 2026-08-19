// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { TreeManifest } from "./model.ts";
import { layer, WorkspaceProjector } from "./WorkspaceProjector.ts";

const hash = (contents: string) => NodeCrypto.createHash("sha256").update(contents).digest("hex");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const manifest = (files: Readonly<Record<string, string>>): TreeManifest => ({
  files: Object.entries(files).map(([path, contents]) => ({
    path,
    hash: hash(contents),
    size: Buffer.byteLength(contents),
    executable: false,
  })),
  totalBytes: Object.values(files).reduce(
    (total, contents) => total + Buffer.byteLength(contents),
    0,
  ),
});

const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "overleaf-projector-"))),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

const exists = (path: string) =>
  NodeFSP.stat(path).then(
    () => true,
    () => false,
  );

describe("WorkspaceProjector", () => {
  it.effect(
    "projects binary-safe replacements and deletions from an exact click-time manifest",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory;
        const projector = yield* WorkspaceProjector;
        const source = NodePath.join(root, "source");
        const target = NodePath.join(root, "target");
        const operation = NodePath.join(root, "operation");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(source, { recursive: true });
          await NodeFSP.mkdir(target, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(source, "main.tex"), "remote\n");
          await NodeFSP.writeFile(
            NodePath.join(source, "figure.bin"),
            new Uint8Array([0, 255, 1, 2]),
          );
          await NodeFSP.writeFile(NodePath.join(target, "main.tex"), "local\n");
          await NodeFSP.writeFile(NodePath.join(target, "old.tex"), "delete me\n");
        });
        const expected = manifest({ "main.tex": "local\n", "old.tex": "delete me\n" });
        const binaryHash = NodeCrypto.createHash("sha256")
          .update(new Uint8Array([0, 255, 1, 2]))
          .digest("hex");
        const desired: TreeManifest = {
          files: [
            { path: "main.tex", hash: hash("remote\n"), size: 7, executable: false },
            { path: "figure.bin", hash: binaryHash, size: 4, executable: false },
          ],
          totalBytes: 11,
        };
        yield* projector.project({
          sourceRoot: source,
          targetRoot: target,
          desired,
          expected,
          previousManaged: expected,
          operationDirectory: operation,
        });
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(target, "main.tex"), "utf8")),
        ).toBe("remote\n");
        expect([
          ...(yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(target, "figure.bin")))),
        ]).toEqual([0, 255, 1, 2]);
        expect(yield* Effect.promise(() => exists(NodePath.join(target, "old.tex")))).toBe(false);
        expect(
          yield* Effect.promise(() =>
            exists(NodePath.join(operation, "projection.journal.ndjson")),
          ),
        ).toBe(false);
      }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("never overwrites a file changed after the click-time manifest", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const projector = yield* WorkspaceProjector;
      const source = NodePath.join(root, "source");
      const target = NodePath.join(root, "target");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(source, { recursive: true });
        await NodeFSP.mkdir(target, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(source, "main.tex"), "remote\n");
        await NodeFSP.writeFile(NodePath.join(target, "main.tex"), "edited later\n");
      });
      const expected = manifest({ "main.tex": "click time\n" });
      const desired = manifest({ "main.tex": "remote\n" });
      const failure = yield* projector
        .project({
          sourceRoot: source,
          targetRoot: target,
          desired,
          expected,
          previousManaged: expected,
          operationDirectory: NodePath.join(root, "operation"),
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "workspace_changed" });
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(target, "main.tex"), "utf8")),
      ).toBe("edited later\n");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("recovers only partial output that still matches the journaled candidate", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const projector = yield* WorkspaceProjector;
      const target = NodePath.join(root, "target");
      const operation = NodePath.join(root, "operation");
      const backup = NodePath.join(operation, "projection-backup", "main.tex");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(target, { recursive: true });
        await NodeFSP.mkdir(NodePath.dirname(backup), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(target, "main.tex"), "partial candidate\n");
        await NodeFSP.writeFile(backup, "before\n");
      });
      const temporary = `${NodePath.join(target, "main.tex")}.scient-overleaf-${NodePath.basename(operation)}.tmp`;
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(temporary, "interrupted temporary output\n");
        await NodeFSP.writeFile(
          NodePath.join(operation, "projection.journal.ndjson"),
          `${encodeJson({ schemaVersion: 1, path: "main.tex", desiredHash: hash("partial candidate\n"), backupPath: backup, applied: false })}\n`,
        );
      });
      yield* projector.recover({ operationDirectory: operation, targetRoot: target });
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(target, "main.tex"), "utf8")),
      ).toBe("before\n");
      expect(yield* Effect.promise(() => exists(temporary))).toBe(false);

      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(target, "main.tex"), "later edit\n");
        await NodeFSP.writeFile(
          NodePath.join(operation, "projection.journal.ndjson"),
          `${encodeJson({ schemaVersion: 1, path: "main.tex", desiredHash: hash("partial candidate\n"), backupPath: backup, applied: true })}\n`,
        );
      });
      yield* projector.recover({ operationDirectory: operation, targetRoot: target });
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(target, "main.tex"), "utf8")),
      ).toBe("later edit\n");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("rolls back the currently-applied file when source verification fails", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const projector = yield* WorkspaceProjector;
      const source = NodePath.join(root, "source");
      const target = NodePath.join(root, "target");
      const operation = NodePath.join(root, "operation");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(source, { recursive: true });
        await NodeFSP.mkdir(target, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(source, "main.tex"), "unexpected source\n");
        await NodeFSP.writeFile(NodePath.join(target, "main.tex"), "before\n");
      });
      const expected = manifest({ "main.tex": "before\n" });
      const failure = yield* projector
        .project({
          sourceRoot: source,
          targetRoot: target,
          desired: manifest({ "main.tex": "claimed candidate\n" }),
          expected,
          previousManaged: expected,
          operationDirectory: operation,
        })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "filesystem_failed" });
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(target, "main.tex"), "utf8")),
      ).toBe("before\n");
      expect(
        yield* Effect.promise(() => exists(NodePath.join(operation, "projection.journal.ndjson"))),
      ).toBe(false);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

  it.effect("preserves a later edit detected by final projection verification", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory;
      const projector = yield* WorkspaceProjector;
      const source = NodePath.join(root, "source");
      const target = NodePath.join(root, "target");
      const operation = NodePath.join(root, "operation");
      const largeCandidate = Buffer.alloc(32 * 1024 * 1024, 7);
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(source, { recursive: true });
        await NodeFSP.mkdir(target, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(source, "a.tex"), "candidate\n");
        await NodeFSP.writeFile(NodePath.join(source, "z.bin"), largeCandidate);
        await NodeFSP.writeFile(NodePath.join(target, "a.tex"), "before\n");
        await NodeFSP.writeFile(NodePath.join(target, "z.bin"), "before binary\n");
      });
      let editPromise: Promise<void> | null = null;
      const watcher = NodeFS.watch(target, (_event, filename) => {
        if (filename?.toString() !== "a.tex" || editPromise !== null) return;
        editPromise = NodeFSP.writeFile(NodePath.join(target, "a.tex"), "later edit\n");
      });
      const expected = manifest({ "a.tex": "before\n", "z.bin": "before binary\n" });
      const desired: TreeManifest = {
        files: [
          ...manifest({ "a.tex": "candidate\n" }).files,
          {
            path: "z.bin",
            hash: NodeCrypto.createHash("sha256").update(largeCandidate).digest("hex"),
            size: largeCandidate.byteLength,
            executable: false,
          },
        ],
        totalBytes: Buffer.byteLength("candidate\n") + largeCandidate.byteLength,
      };
      const result = yield* projector
        .project({
          sourceRoot: source,
          targetRoot: target,
          desired,
          expected,
          previousManaged: expected,
          operationDirectory: operation,
        })
        .pipe(Effect.result);
      watcher.close();
      if (editPromise !== null) yield* Effect.promise(() => editPromise!);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "workspace_changed" },
      });
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(target, "a.tex"), "utf8")),
      ).toBe("later edit\n");
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(target, "z.bin"), "utf8")),
      ).toBe("before binary\n");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
