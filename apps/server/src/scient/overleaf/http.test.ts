/**
 * What the HTTP routes tell the app about a kept-copy restore: a restore that ran
 * says how its apply ended, so a replan that wrote nothing is never shown as
 * restored. The replan comes from the real engine, with a late writer.
 */
import { ScientOverleafRestoreResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CONNECTION, canApply, read, run, world, write } from "./OverleafCoordinator.testkit.ts";
import { restoreView } from "./http.ts";

const decode = Schema.decodeUnknownSync(ScientOverleafRestoreResult);

describe.skipIf(!canApply)("Overleaf HTTP views", () => {
  it.live("a restore whose apply wrote nothing says so, and one that wrote says restored", () =>
    run(
      Effect.gen(function* () {
        let racing = false;
        let folder = "";
        const w = yield* world({
          synced: { "main.tex": "before\n" },
          remote: { "main.tex": "after\n" },
          overleaf: "git",
          // A program writes the file right after the restore is recorded.
          at: (point) =>
            point === "linked" && racing
              ? write(folder, { "main.tex": "late writer\n" })
              : Effect.void,
        });
        folder = w.folder;
        yield* w.sync("initial");
        const [copy] = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        if (copy === undefined || copy.keptRevision === null) return yield* Effect.die(copy);
        racing = true;
        const replanned = yield* w.coordinator.restoreKept({
          connectionId: CONNECTION,
          requestId: "restore-1",
          applyId: copy.applyId,
          kept: copy.kept,
          keptRevision: copy.keptRevision,
          currentRevision: copy.currentRevision,
        });
        expect(yield* read(folder, "main.tex")).toBe("late writer\n");
        expect(decode(restoreView(replanned))).toEqual({ _tag: "restored", outcome: "replan" });

        racing = false;
        const again = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).find(
          (listed) => listed.applyId === copy.applyId && listed.kept === copy.kept,
        );
        if (again === undefined || again.keptRevision === null) return yield* Effect.die(again);
        const restored = yield* w.coordinator.restoreKept({
          connectionId: CONNECTION,
          requestId: "restore-2",
          applyId: again.applyId,
          kept: again.kept,
          keptRevision: again.keptRevision,
          currentRevision: again.currentRevision,
        });
        expect(yield* read(folder, "main.tex")).toBe("before\n");
        expect(decode(restoreView(restored))).toEqual({ _tag: "restored", outcome: "complete" });
        // A restore that did not run carries no outcome.
        expect(decode(restoreView({ _tag: "stale" }))).toEqual({ _tag: "stale" });
      }),
    ),
  );
});
