// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * What a confirm checks again, and what it does not redo when nothing changed
 * since its review: against a real local bare repository standing in for
 * Overleaf, with real fetch, push and the real applier.
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

import { CONNECTION, canApply, read, run, world, write } from "./OverleafCoordinator.testkit.ts";

/** Counts the reviews built (prepare's and any confirm's) under `effect`. */
const countingBuilds = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const built = { count: 0 };
  const tracer = Tracer.make({
    span: (options) => {
      if (options.name === "OverleafCoordinator.buildReview") built.count += 1;
      return new Tracer.NativeSpan(options);
    },
  });
  return { built, effect: effect.pipe(Effect.withTracer(tracer)) };
};

type World = Effect.Success<ReturnType<typeof world>>;
/** Prepares a review, runs `between`, then confirms the review as it was offered. */
const confirmAfter = (w: World, between: Effect.Effect<unknown>) =>
  Effect.gen(function* () {
    const prepared = yield* w.coordinator.prepare({ connectionId: CONNECTION });
    if (prepared._tag !== "review") return yield* Effect.die(prepared);
    yield* between;
    return yield* w.coordinator.confirm({
      connectionId: CONNECTION,
      requestId: "request-1",
      reviewId: prepared.review.id,
      digest: prepared.review.digest,
      acknowledgements: prepared.review.binding.acknowledgements,
    });
  });

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

  it.live("confirms the review as built when nothing changed, without building it again", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A", "other.tex": "O" },
          remote: { "main.tex": "A", "other.tex": "O2" },
        });
        yield* write(w.folder, { "main.tex": "A, edited here", "fresh.tex": "F" });
        const counted = countingBuilds(confirmAfter(w, Effect.void));
        expect(yield* counted.effect).toMatchObject({
          _tag: "applied",
          adopted: { outcome: "complete" },
          publication: { _tag: "accepted" },
        });
        expect(counted.built.count).toBe(1);
        expect((yield* w.overleafNow).contents).toEqual({
          "main.tex": "A, edited here",
          "other.tex": "O2",
          "fresh.tex": "F",
        });
      }),
    ),
  );

  it.live("builds the review again, and applies nothing, when a file changed after it", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "A", "other.tex": "O" },
        });
        const counted = countingBuilds(
          confirmAfter(w, write(w.folder, { "main.tex": "A, edited after the review" })),
        );
        expect(yield* counted.effect).toMatchObject({ _tag: "stale", reason: "capture" });
        expect(counted.built.count).toBe(2);
        expect(yield* read(w.folder, "other.tex")).toBeNull();
        expect(w.pushes).toHaveLength(0);
      }),
    ),
  );

  it.live("builds the review again when a new file appeared after it", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "A", "other.tex": "O" },
        });
        const confirmed = yield* confirmAfter(w, write(w.folder, { "late.tex": "L" }));
        expect(confirmed).toMatchObject({ _tag: "stale" });
        if (confirmed._tag !== "stale") return;
        // The late file is a new file of the fresh review, sent by default.
        expect(confirmed.review.binding.selectedAdditions).toContain("late.tex");
        expect(yield* read(w.folder, "other.tex")).toBeNull();
      }),
    ),
  );

  it.live("builds the review again when the connection record changed after it", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
        });
        const confirmed = yield* confirmAfter(
          w,
          Effect.gen(function* () {
            const document = yield* w.connection;
            yield* w.store.replaceConnection({
              expectedRevision: document.revision,
              next: { ...document, revision: document.revision + 1 },
            });
          }).pipe(Effect.orDie),
        );
        expect(confirmed).toMatchObject({ _tag: "stale", reason: "connection-revision" });
        expect(yield* read(w.folder, "main.tex")).toBe("A");
      }),
    ),
  );

  it.live("builds the review again after a bulk change of the checkout", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
        });
        const confirmed = yield* confirmAfter(
          w,
          w.barrier.bulk(w.checkout, Effect.void).pipe(Effect.orDie),
        );
        expect(confirmed).toMatchObject({ _tag: "stale", reason: "checkout-epoch" });
        expect(yield* read(w.folder, "main.tex")).toBe("A");
      }),
    ),
  );

  it.live("builds the review again after the token was renewed", () => {
    let epoch = 0;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          credentialEpoch: () => epoch,
        });
        const confirmed = yield* confirmAfter(
          w,
          Effect.sync(() => {
            epoch = 1;
          }),
        );
        expect(confirmed).toMatchObject({ _tag: "stale", reason: "credential-epoch" });
        expect(yield* read(w.folder, "main.tex")).toBe("A");
      }),
    );
  });
});
