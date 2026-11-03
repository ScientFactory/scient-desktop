// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * What a sync promises on this computer's disk, each once over real Git: a conflict's
 * other side kept and put back, an undo, a step finished after a restart, and bytes
 * kept exactly. Short enough for the Overleaf Windows job; the full cases are in the
 * coordinator tests.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { OverleafKeptCopy } from "./OverleafCoordinator.ts";
import {
  CONNECTION,
  hasPrivateFoldersAndIdentity,
  read,
  revision,
  run,
  world,
  write,
} from "./OverleafCoordinator.testkit.ts";

type World = Effect.Success<ReturnType<typeof world>>;
const fileBytes = (path: string) => Effect.promise(() => NodeFSP.readFile(path));
let restores = 0;
const restore = (w: World, copy: OverleafKeptCopy) =>
  w.coordinator.restoreKept({
    connectionId: CONNECTION,
    requestId: `restore-${++restores}`,
    applyId: copy.applyId,
    kept: copy.kept,
    keptRevision: copy.keptRevision!,
    currentRevision: copy.currentRevision,
  });
const leftovers = (folder: string) =>
  Effect.promise(async () =>
    (await NodeFSP.readdir(folder)).filter((name) => name.endsWith(".scient-tmp")),
  );

describe.skipIf(!hasPrivateFoldersAndIdentity)("an Overleaf sync on this disk", () => {
  it.live("keeps the side a conflict did not take, and the next sync sends it once put back", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "line\n" },
          remote: { "main.tex": "theirs\n" },
        });
        yield* write(w.folder, { "main.tex": "mine\n" });
        const asked = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (asked._tag !== "review") return yield* Effect.die(asked);
        expect(asked.review.conflicts).toHaveLength(1);
        expect(yield* read(w.folder, "main.tex")).toBe("mine\n");
        const decided = yield* w.coordinator.prepare({
          connectionId: CONNECTION,
          selections: {
            collisionPaths: [],
            choices: new Map([[asked.review.conflicts[0]!.key, "theirs" as const]]),
          },
        });
        if (decided._tag !== "review") return yield* Effect.die(decided);
        expect(
          yield* w.coordinator.confirm({
            connectionId: CONNECTION,
            requestId: "decided",
            reviewId: decided.review.id,
            digest: decided.review.digest,
            acknowledgements: decided.review.binding.acknowledgements,
          }),
        ).toMatchObject({ _tag: "applied" });
        expect(yield* read(w.folder, "main.tex")).toBe("theirs\n");
        const mine = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).find(
          (copy) => copy.keptRevision === revision("mine\n"),
        );
        expect(mine).toMatchObject({ relativePath: "main.tex" });
        expect(yield* restore(w, mine!)).toMatchObject({ _tag: "restored" });
        expect(yield* read(w.folder, "main.tex")).toBe("mine\n");
        expect(yield* w.sync("send")).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": "mine\n" });
      }),
    ),
  );

  it.live("undoes a send, keeping what it replaces, and the next sync sends the undo", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "A" },
        });
        yield* write(w.folder, { "main.tex": "A, sent" });
        expect(yield* w.sync("send")).toMatchObject({
          publication: { _tag: "accepted", attemptNumber: 1 },
        });
        expect(
          yield* w.coordinator.undo({
            connectionId: CONNECTION,
            requestId: "undo",
            attemptNumber: 1,
          }),
        ).toMatchObject({
          _tag: "undone",
          restored: ["main.tex"],
          adopted: { outcome: "complete" },
        });
        expect(yield* read(w.folder, "main.tex")).toBe("A");
        expect(
          (yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).map(
            (copy) => copy.keptRevision,
          ),
        ).toContain(revision("A, sent"));
        expect(yield* w.sync("send-undo")).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": "A" });
      }),
    ),
  );

  it.live("finishes a step stopped after its file was written, once restarted", () => {
    let stop = true;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B", "new.tex": "N" },
          native: async (point) => {
            if (stop && point === "displaced") {
              stop = false;
              throw new Error("process died");
            }
          },
        });
        expect(Exit.isFailure(yield* Effect.exit(w.sync()))).toBe(true);
        expect((yield* w.connection).activeApply).not.toBeNull();
        const restarted = yield* w.restart();
        expect(yield* restarted.coordinator.recover({ connectionId: CONNECTION })).toMatchObject({
          _tag: "recovered",
          adopted: { outcome: "complete" },
        });
        expect(yield* read(w.folder, "main.tex")).toBe("B");
        expect(yield* read(w.folder, "new.tex")).toBe("N");
        expect(yield* leftovers(w.folder)).toEqual([]);
      }),
    );
  });

  it.live("keeps CRLF, BOM and binary bytes exact through apply, kept copy, restore and send", () =>
    run(
      Effect.gen(function* () {
        const before = {
          "crlf.tex": Buffer.from("\\section{A}\r\nline\r\n"),
          "bom.tex": Buffer.from("\uFEFF% first\nline\n"),
          "figure.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]),
        };
        const after = {
          "crlf.tex": Buffer.from("\\section{B}\r\nline\r\nmore\r\n"),
          "bom.tex": Buffer.from("\uFEFF% second\r\nline\n"),
          "figure.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x0d, 0x00]),
        };
        const w = yield* world({ overleaf: "git", synced: before, remote: after });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        for (const [path, bytes] of Object.entries(after))
          expect(yield* fileBytes(NodePath.join(w.folder, path))).toEqual(bytes);
        const copies = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        for (const [path, bytes] of Object.entries(before)) {
          const copy = copies.find((entry) => entry.relativePath === path)!;
          expect(yield* fileBytes(copy.path)).toEqual(bytes);
          expect(yield* restore(w, copy)).toMatchObject({ _tag: "restored" });
          expect(yield* fileBytes(NodePath.join(w.folder, path))).toEqual(bytes);
        }
        expect(yield* w.sync("send")).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).files).toEqual(before);
      }),
    ),
  );
});
