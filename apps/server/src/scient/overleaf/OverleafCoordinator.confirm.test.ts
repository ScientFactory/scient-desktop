// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * What a confirm checks again, and what it does not redo when nothing changed
 * since its review: against a real local bare repository standing in for
 * Overleaf, with real fetch, push and the real applier.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CONNECTION, canApply, read, run, world } from "./OverleafCoordinator.testkit.ts";

describe.skipIf(!canApply)("OverleafCoordinator, confirm", () => {
  it.live("does not fetch again when Overleaf has not moved since the review", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B", "new.tex": "N" },
        });
        expect(yield* w.sync()).toMatchObject({
          _tag: "applied",
          adopted: { outcome: "complete" },
          publication: { _tag: "none" },
        });
        // The review's fetch only: the confirm found the same head by a ref check.
        expect(w.fetches.count).toBe(1);
        expect(yield* read(w.folder, "new.tex")).toBe("N");
        expect((yield* w.connection).base.commit).toBe((yield* w.overleafNow).commit);
      }),
    ),
  );

  it.live("fetches when Overleaf moved since the review, and offers the new state", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
        });
        const prepared = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (prepared._tag !== "review") return yield* Effect.die(prepared);
        const moved = yield* w.collaborate({ "main.tex": "C" });
        const confirmed = yield* w.coordinator.confirm({
          connectionId: CONNECTION,
          requestId: "request-1",
          reviewId: prepared.review.id,
          digest: prepared.review.digest,
          acknowledgements: prepared.review.binding.acknowledgements,
        });
        expect(confirmed).toMatchObject({ _tag: "stale", reason: "remote" });
        if (confirmed._tag !== "stale") return;
        expect(confirmed.review.binding.remoteCommit).toBe(moved);
        expect(w.fetches.count).toBe(2);
        // Nothing was written: the folder still holds what the last sync left.
        expect(yield* read(w.folder, "main.tex")).toBe("A");
      }),
    ),
  );
});
