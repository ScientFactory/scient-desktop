// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/** Each apply write takes one native lease binding at most 256 folders; a sync
 * with an unleaseable write is refused before anything is written, never stopped
 * part way through. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CONNECTION, canApply, read, run, world } from "./OverleafCoordinator.testkit.ts";

/** Folders deep enough that a write there needs more than one lease can bind. */
const DEEP = `${"d/".repeat(260)}deep.tex`;

describe.skipIf(!canApply)("Overleaf apply and native leases", () => {
  it.live("refuses a file nested deeper than a lease can reach, with nothing written", () =>
    run(
      Effect.gen(function* () {
        const synced = { "main.tex": "\\documentclass{article}\n" };
        const w = yield* world({
          overleaf: "git",
          synced,
          remote: { ...synced, "a-first.tex": "first\n", [DEEP]: "deep\n" },
        });
        expect(yield* Effect.flip(w.sync())).toMatchObject({
          _tag: "OverleafRetainedLimitError",
          limit: "folder-depth",
        });
        expect(yield* Effect.promise(() => NodeFSP.readdir(w.folder))).toEqual(["main.tex"]);
        expect((yield* w.connection).activeApply).toBeNull();
      }),
    ),
  );

  it.live("refuses a restore whose write could not be leased, before recording anything", () =>
    run(
      Effect.gen(function* () {
        let room = true,
          asked = 0;
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          applier: (real) => ({
            ...real,
            fits: (input) =>
              Effect.suspend(() => {
                asked += 1;
                return room ? real.fits(input) : Effect.succeed(false);
              }),
          }),
        });
        yield* w.sync();
        const [copy] = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        room = false;
        const before = asked;
        expect(
          yield* Effect.flip(
            w.coordinator.restoreKept({
              connectionId: CONNECTION,
              requestId: "restore",
              applyId: copy!.applyId,
              kept: copy!.kept,
              keptRevision: copy!.keptRevision!,
              currentRevision: copy!.currentRevision,
            }),
          ),
        ).toMatchObject({ _tag: "OverleafRetainedLimitError", limit: "folder-depth" });
        expect(asked).toBe(before + 1);
        expect(yield* read(w.folder, "main.tex")).toBe("B");
        expect((yield* w.connection).activeApply).toBeNull();
      }),
    ),
  );

  it.live(
    "refuses a file over folders nested deeper than a lease can reach, with nothing written",
    () =>
      run(
        Effect.gen(function* () {
          const w = yield* world({
            synced: { "main.tex": "A" },
            remote: { "main.tex": "B", "a-first.tex": "first", "z-shallow.tex": "new" },
          });
          // A folder stands where Overleaf has a file; writing the file removes every
          // folder below it first, each with a lease of its own.
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.join(w.folder, "z-shallow.tex", "d/".repeat(260)), {
              recursive: true,
            }),
          );
          expect(yield* Effect.flip(w.sync())).toMatchObject({
            _tag: "OverleafRetainedLimitError",
            limit: "folder-depth",
          });
          expect(yield* read(w.folder, "main.tex")).toBe("A");
          expect(yield* read(w.folder, "a-first.tex")).toBeNull();
          expect((yield* w.connection).activeApply).toBeNull();
        }),
      ),
  );
});
