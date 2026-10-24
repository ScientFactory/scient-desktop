// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * Each write an apply makes takes one native lease, which binds at most 256
 * folders. A sync with a write that could not be leased is refused before
 * anything is written, never stopped part way through. (300 new files into one
 * folder, which once stopped at file 236, is the `incoming 300` case of
 * `OverleafSync.bench.test.ts`; `WorkspaceFileMutations.lease.test.ts` keeps
 * the lease from growing with the records a folder keeps.)
 */
import * as NodeFSP from "node:fs/promises";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { canApply, run, world } from "./OverleafCoordinator.testkit.ts";

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
});
