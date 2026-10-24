// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * The coordinator's local half on real folders, a real private repository, the
 * real applier and a scripted Overleaf. A throwing hook stands in for a crash
 * between the coordinator's durable steps: nothing at this level compensates.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import {
  type CheckoutLookupError,
  type CheckoutRecoveryRequiredError,
  type makeCheckoutBarrier,
} from "../workspace/CheckoutBarrier.ts";
import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
import type * as OverleafCoordinator from "./OverleafCoordinator.ts";
import {
  canApply,
  CONNECTION,
  firstKept,
  type Point,
  read,
  revision,
  run,
  world,
  write,
} from "./OverleafCoordinator.testkit.ts";
import * as OverleafStateStore from "./OverleafStateStore.ts";
import { WorkspaceApplier } from "./WorkspaceApplier.ts";

describe.skipIf(!canApply)("OverleafCoordinator, local half", () => {
  it.live("applies a confirmed review and adopts the result once", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A", "other.tex": "O" },
          remote: { "main.tex": "B", "other.tex": "O" },
        });
        const before = yield* w.connection;
        const prepared = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (prepared._tag !== "review") return yield* Effect.die(prepared);
        const request = {
          connectionId: CONNECTION,
          requestId: "request-1",
          reviewId: prepared.review.id,
          digest: prepared.review.digest,
          acknowledgements: prepared.review.binding.acknowledgements,
        };
        const confirmed = yield* w.coordinator.confirm(request);
        expect(confirmed).toMatchObject({ _tag: "applied", adopted: { outcome: "complete" } });
        expect(yield* read(w.folder, "main.tex")).toBe("B");
        const after = yield* w.connection;
        expect(after.activeApply).toBeNull();
        expect(after.base.generation).toBe(before.base.generation + 1);
        expect(after.priorBases[0]).toEqual(before.base);
        expect(after.completedSyncCount).toBe(before.completedSyncCount + 1);
        expect(after.localSnapshots).toHaveLength(1);
        expect(after.retention.copies).toMatchObject([
          { relativePath: "main.tex", state: "releasable" },
        ]);
        // The new base is pinned; the finished apply's intent pin is gone.
        expect(
          yield* w.repos.readRef({ repo: w.repo, name: `base/${after.base.generation}/tree` }),
        ).toBe(after.base.tree);
        if (confirmed._tag !== "applied") return;
        expect(
          yield* w.repos.readRef({
            repo: w.repo,
            name: `apply/${confirmed.adopted.applyId}/target`,
          }),
        ).toBeNull();
        // The same request again returns its receipt and changes nothing; the same ID
        // for a different request is refused.
        expect(yield* w.coordinator.confirm(request)).toMatchObject({
          _tag: "duplicate",
          receipt: { status: "completed", resultCategory: "applied-complete-none" },
        });
        expect(
          String(yield* Effect.exit(w.coordinator.confirm({ ...request, digest: "other" }))),
        ).toContain("OverleafRequestReusedError");
        expect((yield* w.connection).revision).toBe(after.revision);
      }),
    ),
  );

  it.live("refuses a review the folder no longer matches and offers a fresh one", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
        });
        const prepared = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (prepared._tag !== "review") return yield* Effect.die(prepared);
        yield* write(w.folder, { "main.tex": "edited here" });
        const before = yield* w.connection;
        const confirmed = yield* w.coordinator.confirm({
          connectionId: CONNECTION,
          requestId: "request-1",
          reviewId: prepared.review.id,
          digest: prepared.review.digest,
          acknowledgements: prepared.review.binding.acknowledgements,
        });
        expect(confirmed).toMatchObject({ _tag: "stale", reason: "capture" });
        expect(yield* read(w.folder, "main.tex")).toBe("edited here");
        expect((yield* w.connection).revision).toBe(before.revision);
        if (confirmed._tag !== "stale") return;
        expect(w.registry.current(CONNECTION, yield* Clock.currentTimeMillis)?.id).toBe(
          confirmed.review.id,
        );
      }),
    ),
  );

  it.live("recovers an apply interrupted after the applier ran, adopting it once", () => {
    let crash = true;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          at: (point) =>
            crash && point === "applied" ? Effect.die(new Error("process died")) : Effect.void,
        });
        const before = yield* w.connection;
        expect(Exit.isFailure(yield* Effect.exit(w.sync()))).toBe(true);
        expect(yield* read(w.folder, "main.tex")).toBe("B");
        expect((yield* w.connection).activeApply).not.toBeNull();
        crash = false;
        const recovered = yield* w.coordinator.recover({ connectionId: CONNECTION });
        expect(recovered).toMatchObject({ _tag: "recovered", adopted: { outcome: "complete" } });
        const after = yield* w.connection;
        expect(after.activeApply).toBeNull();
        expect(after.base.generation).toBe(before.base.generation + 1);
        expect(yield* w.coordinator.recover({ connectionId: CONNECTION })).toEqual({
          _tag: "none",
          attempts: { accepted: [], unresolved: [] },
        });
        expect((yield* w.connection).base.generation).toBe(after.base.generation);
      }),
    );
  });

  it.live("clears an apply linked just before a crash, with nothing written", () => {
    let crash = true;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          at: (point) =>
            crash && point === "linked" ? Effect.die(new Error("process died")) : Effect.void,
        });
        const before = yield* w.connection;
        expect(Exit.isFailure(yield* Effect.exit(w.sync()))).toBe(true);
        expect((yield* w.connection).activeApply).not.toBeNull();
        crash = false;
        expect(yield* w.coordinator.recover({ connectionId: CONNECTION })).toMatchObject({
          _tag: "recovered",
          adopted: { outcome: "replan" },
        });
        const after = yield* w.connection;
        expect(after.activeApply).toBeNull();
        expect(after.base).toEqual(before.base);
        expect(yield* read(w.folder, "main.tex")).toBe("A");
        // A new review applies normally afterwards.
        expect(yield* w.sync("request-2")).toMatchObject({ _tag: "applied" });
        expect(yield* read(w.folder, "main.tex")).toBe("B");
      }),
    );
  });

  it.live("refuses a second operation on the connection instead of queuing it", () => {
    let competing: Exit.Exit<unknown, OverleafCoordinator.OverleafCoordinatorError> | undefined;
    let coordinator: OverleafCoordinator.OverleafCoordinator["Service"] | undefined;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          at: (point) =>
            point === "linked" && coordinator
              ? coordinator.prepare({ connectionId: CONNECTION }).pipe(
                  Effect.exit,
                  Effect.map((exit) => {
                    competing = exit;
                  }),
                )
              : Effect.void,
        });
        coordinator = w.coordinator;
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        expect(String(competing)).toContain("OverleafOperationActiveError");
      }),
    );
  });

  it.live("makes a bulk change of the checkout wait until the apply is adopted", () => {
    const order: string[] = [];
    let bulk: Fiber.Fiber<void, CheckoutRecoveryRequiredError | CheckoutLookupError> | undefined;
    let barrier: ReturnType<typeof makeCheckoutBarrier> | undefined;
    let checkout = "";
    let before = 0;
    let entered = false;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          at: (point) =>
            Effect.gen(function* () {
              order.push(point);
              if (!barrier) return;
              const epoch = Effect.orDie(
                Effect.map(barrier.current(checkout), (section) => section.epoch),
              );
              if (point === "linked") {
                before = yield* epoch;
                bulk = yield* barrier
                  .bulk(
                    checkout,
                    Effect.sync(() => {
                      order.push("bulk");
                    }),
                  )
                  .pipe(Effect.forkDetach);
              }
              // By adoption the applier's whole run has passed: the bulk change has
              // entered (its entry moves the epoch) and waits for this apply's section.
              if (point === "adopted") entered = (yield* epoch) > before;
            }),
        });
        barrier = w.barrier;
        checkout = w.checkout;
        // The bulk change starts while the apply runs; its epoch move makes the next
        // review stale, but this apply was admitted first and finishes.
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        yield* Fiber.join(bulk!);
        expect(entered).toBe(true);
        expect(order).toEqual(["linked", "applied", "adopted", "bulk"]);
      }),
    );
  });

  it.live("recovers a pending apply inline before a bulk change of its checkout", () => {
    let crash = true;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          at: (point) =>
            crash && point === "applied" ? Effect.die(new Error("process died")) : Effect.void,
        });
        const before = yield* w.connection;
        expect(Exit.isFailure(yield* Effect.exit(w.sync()))).toBe(true);
        crash = false;
        let mutated = false;
        yield* w.barrier.bulk(
          NodePath.join(w.checkout, "paper"),
          Effect.sync(() => {
            mutated = true;
          }),
        );
        expect(mutated).toBe(true);
        const after = yield* w.connection;
        expect(after.activeApply).toBeNull();
        expect(after.base.generation).toBe(before.base.generation + 1);
      }),
    );
  });

  it.live("refuses a bulk change while structural copies sit in the folder", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "A" }, remote: { "main.tex": "A" } });
        const current = yield* w.connection;
        yield* w.store.replaceConnection({
          expectedRevision: current.revision,
          next: {
            ...current,
            revision: current.revision + 1,
            stagingPaths: [".scient-overleaf-apply-earlier-1"],
            updatedAt: "2026-10-22T12:00:00.000Z",
          },
        });
        let mutated = false;
        const refused = yield* Effect.exit(
          w.barrier.bulk(
            w.checkout,
            Effect.sync(() => {
              mutated = true;
            }),
          ),
        );
        expect(String(refused)).toContain("CheckoutRecoveryRequiredError");
        expect(mutated).toBe(false);
      }),
    ),
  );

  it.live("refuses a bulk change when inline recovery finds structural copies", () => {
    let crash = true;
    let staging = "";
    let stateRoot = "";
    let folder = "";
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          // A source copy of this apply, left in the folder just before a crash: only
          // the applier's recovery finds it, so the record read before recovery cannot.
          at: (point) =>
            crash && point === "applied"
              ? Effect.promise(async () => {
                  const intent = (await NodeFSP.readdir(stateRoot, { recursive: true })).find(
                    (path) => path.endsWith("/apply.json"),
                  );
                  staging = `.scient-overleaf-apply-${NodePath.basename(NodePath.dirname(intent!))}-held-source`;
                  await NodeFSP.writeFile(NodePath.join(folder, staging), "the only copy");
                }).pipe(Effect.andThen(Effect.die(new Error("process died"))))
              : Effect.void,
        });
        stateRoot = w.stateRoot;
        folder = w.folder;
        expect(Exit.isFailure(yield* Effect.exit(w.sync()))).toBe(true);
        crash = false;
        let mutated = false;
        const refused = yield* Effect.exit(
          w.barrier.bulk(
            w.checkout,
            Effect.sync(() => {
              mutated = true;
            }),
          ),
        );
        expect(String(refused)).toContain("CheckoutRecoveryRequiredError");
        expect(mutated).toBe(false);
        const after = yield* w.connection;
        expect(after.activeApply).toBeNull();
        expect(after.stagingPaths).toEqual([staging]);
        expect(yield* read(w.folder, staging)).toBe("the only copy");
      }),
    );
  });

  it.live("keeps a group interrupted partway as a forced conflict for the next review", () => {
    let prepared = 0;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "old.tex": "chapter text that moves", "main.tex": "M" },
          remote: { "new.tex": "chapter text that moves", "main.tex": "M" },
          // The rename's second step removes old.tex; it changes just before.
          native: async (point, folder) => {
            if (point === "prepared" && ++prepared === 2)
              await NodeFSP.writeFile(NodePath.join(folder, "old.tex"), "edited meanwhile");
          },
        });
        const confirmed = yield* w.sync();
        expect(confirmed).toMatchObject({ _tag: "applied", adopted: { outcome: "attention" } });
        const after = yield* w.connection;
        expect(after.forcedConflicts).toEqual([["new.tex", "old.tex"]]);
        // Managed paths are the reviewed result's; old.tex stays in the base instead.
        expect(after.managedPaths).toEqual(["main.tex", "new.tex"]);
        expect(after.completedSyncCount).toBe(1);
        expect(yield* read(w.folder, "old.tex")).toBe("edited meanwhile");
        // The next review shows the group as a conflict to decide.
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        expect(next.review.conflicts.map((conflict) => [...conflict.paths].sort())).toContainEqual([
          "new.tex",
          "old.tex",
        ]);
      }),
    );
  });

  it.live("keeps reading a path an interrupted group left outside the base and result", () => {
    let prepared = 0;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "old.tex": "chapter text that moves" },
          remote: { "theirs.tex": "chapter text that moves" },
          // The group's second step removes new.tex; it changes just before.
          native: async (point, folder) => {
            if (point === "prepared" && ++prepared === 2)
              await NodeFSP.writeFile(NodePath.join(folder, "new.tex"), "edited meanwhile");
          },
        });
        // Renamed here to new.tex, and on Overleaf to theirs.tex: Overleaf's name wins.
        yield* Effect.promise(() =>
          NodeFSP.rename(NodePath.join(w.folder, "old.tex"), NodePath.join(w.folder, "new.tex")),
        );
        const selections = (choices: OverleafCoordinator.OverleafSelections["choices"]) => ({
          selectedAdditions: ["new.tex"],
          collisionPaths: [],
          choices,
          releaseMarked: [],
        });
        const first = yield* w.coordinator.prepare({
          connectionId: CONNECTION,
          selections: selections(new Map()),
        });
        if (first._tag !== "review") return yield* Effect.die(first);
        const chosen = yield* w.coordinator.prepare({
          connectionId: CONNECTION,
          selections: selections(
            new Map(first.review.conflicts.map((conflict) => [conflict.key, "theirs" as const])),
          ),
        });
        if (chosen._tag !== "review") return yield* Effect.die(chosen);
        expect(
          yield* w.coordinator.confirm({
            connectionId: CONNECTION,
            requestId: "request-1",
            reviewId: chosen.review.id,
            digest: chosen.review.digest,
            acknowledgements: chosen.review.binding.acknowledgements,
          }),
        ).toMatchObject({ _tag: "applied", adopted: { outcome: "attention" } });
        const after = yield* w.connection;
        expect(after.forcedConflicts).toEqual([["new.tex", "old.tex", "theirs.tex"]]);
        // new.tex is in neither the base nor the reviewed result, yet the next review
        // reads it as part of the group to decide.
        expect(after.managedPaths).toEqual(["theirs.tex"]);
        expect(yield* read(w.folder, "new.tex")).toBe("edited meanwhile");
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        expect(next.review.conflicts.map((conflict) => [...conflict.paths].sort())).toContainEqual([
          "new.tex",
          "old.tex",
          "theirs.tex",
        ]);
      }),
    );
  });

  it.live("refuses before writing a sync whose group could not be recorded if interrupted", () =>
    run(
      Effect.gen(function* () {
        // A rename is one group of two paths; here a forced conflict holds only one.
        const w = yield* world({
          synced: { "old.tex": "chapter text that moves" },
          remote: { "new.tex": "chapter text that moves" },
          limits: { conflictPaths: 1 },
        });
        const before = yield* w.connection;
        const refused = yield* Effect.flip(w.sync());
        expect(refused).toMatchObject({
          _tag: "OverleafRetainedLimitError",
          limit: "conflict-group",
        });
        const after = yield* w.connection;
        expect(after.activeApply).toBeNull();
        expect(after.base).toEqual(before.base);
        expect(yield* read(w.folder, "old.tex")).toBe("chapter text that moves");
        expect(yield* read(w.folder, "new.tex")).toBeNull();
      }),
    ),
  );

  /** Syncs `main.tex` from A to B, then lists the copy of A that the sync kept. */
  const syncedThenListed = (at?: (point: Point) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const w = yield* world({
        synced: { "main.tex": "A" },
        remote: { "main.tex": "B" },
        ...(at ? { at } : {}),
      });
      expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
      const [copy] = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
      return { w, copy: copy! };
    });

  it.live("restores a kept copy, keeping what it replaces and leaving the base", () =>
    run(
      Effect.gen(function* () {
        const { w, copy } = yield* syncedThenListed();
        expect(copy).toMatchObject({ relativePath: "main.tex", state: "releasable" });
        expect(copy.keptRevision).toBe(copy.revision);
        expect(copy.currentRevision).not.toBe(copy.revision);
        const before = yield* w.connection;
        const restored = yield* w.coordinator.restoreKept({
          connectionId: CONNECTION,
          requestId: "restore-1",
          applyId: copy.applyId,
          kept: copy.kept,
          keptRevision: copy.keptRevision!,
          currentRevision: copy.currentRevision,
        });
        expect(restored).toMatchObject({ _tag: "restored", adopted: { outcome: "complete" } });
        expect(yield* read(w.folder, "main.tex")).toBe("A");
        const after = yield* w.connection;
        expect(after.base).toEqual(before.base);
        expect(after.completedSyncCount).toBe(before.completedSyncCount);
        expect(after.activeApply).toBeNull();
        // The file the restore replaced is kept too, never released automatically.
        const listed = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        expect(listed.map((entry) => entry.state).sort()).toEqual(["kept", "releasable"]);
        // The restored bytes are a local change for the next review to send.
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        expect(next.review.outgoing.map((change) => change.kind)).toEqual(["modified"]);
      }),
    ),
  );

  it.live("refuses a restore when the folder's file changed after listing", () =>
    run(
      Effect.gen(function* () {
        const { w, copy } = yield* syncedThenListed();
        yield* write(w.folder, { "main.tex": "edited after listing" });
        const before = yield* w.connection;
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: copy.currentRevision,
          }),
        ).toEqual({ _tag: "stale" });
        expect(yield* read(w.folder, "main.tex")).toBe("edited after listing");
        expect((yield* w.connection).revision).toBe(before.revision);
      }),
    ),
  );

  it.live("recovers a restore interrupted after the applier ran, leaving the base", () => {
    let crash = false;
    return run(
      Effect.gen(function* () {
        const { w, copy } = yield* syncedThenListed((point) =>
          crash && point === "applied" ? Effect.die(new Error("process died")) : Effect.void,
        );
        const before = yield* w.connection;
        crash = true;
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              w.coordinator.restoreKept({
                connectionId: CONNECTION,
                requestId: "restore-1",
                applyId: copy.applyId,
                kept: copy.kept,
                keptRevision: copy.keptRevision!,
                currentRevision: copy.currentRevision,
              }),
            ),
          ),
        ).toBe(true);
        crash = false;
        expect(yield* w.coordinator.recover({ connectionId: CONNECTION })).toMatchObject({
          _tag: "recovered",
          adopted: { outcome: "complete" },
        });
        const after = yield* w.connection;
        expect(after.base).toEqual(before.base);
        expect(after.activeApply).toBeNull();
        expect(yield* read(w.folder, "main.tex")).toBe("A");
      }),
    );
  });

  // Interference in the native layer can leave more than one version of one path
  // (a staged and a provisional copy, say); every one stays listed and restorable,
  // under one record per path.
  it.live("lists every version a step kept of one file", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          applier: (real) =>
            WorkspaceApplier.of({
              apply: (input) =>
                real.apply(input).pipe(
                  Effect.flatMap((result) => {
                    const [first] = result.retained;
                    if (first === undefined) return Effect.succeed(result);
                    const provisional = NodePath.join(
                      NodePath.dirname(first.retainedPath!),
                      "provisional",
                    );
                    return Effect.promise(async () => {
                      await NodeFSP.writeFile(provisional, "D");
                      return {
                        ...result,
                        retained: [
                          ...result.retained,
                          {
                            ...first,
                            retainedPath: provisional,
                            retainedRevision: bytesRevision(new TextEncoder().encode("D")),
                            changed: true,
                          },
                        ],
                      };
                    });
                  }),
                ),
            }),
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).retention.copies).toMatchObject([
          { relativePath: "main.tex", state: "changed" },
        ]);
        const listed = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        expect(listed.map((copy) => copy.kept.split("/").pop()).sort()).toEqual([
          "provisional",
          "slot",
        ]);
        // The extra version restores like the main one.
        const extra = listed.find((copy) => copy.kept.endsWith("/provisional"))!;
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: extra.applyId,
            kept: extra.kept,
            keptRevision: extra.keptRevision!,
            currentRevision: extra.currentRevision,
          }),
        ).toMatchObject({ _tag: "restored" });
        expect(yield* read(w.folder, "main.tex")).toBe("D");
      }),
    ),
  );

  it.live("refuses a bulk change while a connection record cannot be read", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "A" }, remote: { "main.tex": "A" } });
        const records = NodePath.join(w.stateRoot, "connections");
        const file = (yield* Effect.promise(() => NodeFSP.readdir(records))).find((name) =>
          name.endsWith(".json"),
        );
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(records, file!), "{ broken"));
        let mutated = false;
        const refused = yield* Effect.exit(
          w.barrier.bulk(
            w.checkout,
            Effect.sync(() => {
              mutated = true;
            }),
          ),
        );
        expect(String(refused)).toContain("CheckoutRecoveryRequiredError");
        expect(mutated).toBe(false);
      }),
    ),
  );

  it.live("refuses a restore with no room left to keep what it replaces", () =>
    run(
      Effect.gen(function* () {
        const { w, copy } = yield* syncedThenListed();
        const current = yield* w.connection;
        const filler = Array.from({ length: 4_096 - current.retention.copies.length }, (_, n) => ({
          ...current.retention.copies[0]!,
          relativePath: `filler-${n}.tex`,
        }));
        yield* w.store.replaceConnection({
          expectedRevision: current.revision,
          next: {
            ...current,
            revision: current.revision + 1,
            retention: {
              ...current.retention,
              copies: [...current.retention.copies, ...filler],
            },
            updatedAt: "2026-10-22T12:00:00.000Z",
          },
        });
        const refused = yield* Effect.exit(
          w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: copy.currentRevision,
          }),
        );
        expect(String(refused)).toContain("OverleafRetainedLimitError");
        expect(yield* read(w.folder, "main.tex")).toBe("B");
        expect((yield* w.connection).activeApply).toBeNull();
      }),
    ),
  );

  it.live("makes a restored file that a sync deleted part of the next review", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "M", "old.tex": "kept text" },
          remote: { "main.tex": "M" },
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        expect(yield* read(w.folder, "old.tex")).toBeNull();
        const copy = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).find(
          (entry) => entry.relativePath === "old.tex",
        )!;
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: null,
          }),
        ).toMatchObject({ _tag: "restored" });
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        expect(next.review.outgoing).toContainEqual(
          expect.objectContaining({ kind: "added", path: "old.tex" }),
        );
      }),
    ),
  );

  it.live("adopts the local-only set the review counted, without a collision it read in", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "M" },
          remote: { "main.tex": "M", "notes.tex": "theirs" },
          localOnly: { "notes.tex": "mine", "scratch.tex": "S" },
        });
        const first = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (first._tag !== "review") return yield* Effect.die(first);
        expect(first.review.binding.collisionPaths).toEqual(["notes.tex"]);
        const choices = new Map(
          first.review.conflicts.map((conflict) => [conflict.key, conflict.allowed[0]!] as const),
        );
        const chosen = yield* w.coordinator.prepare({
          connectionId: CONNECTION,
          selections: {
            selectedAdditions: [],
            collisionPaths: first.review.binding.collisionPaths,
            choices,
            releaseMarked: [],
          },
        });
        if (chosen._tag !== "review") return yield* Effect.die(chosen);
        expect(
          yield* w.coordinator.confirm({
            connectionId: CONNECTION,
            requestId: "request-1",
            reviewId: chosen.review.id,
            digest: chosen.review.digest,
            acknowledgements: chosen.review.binding.acknowledgements,
          }),
        ).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).localOnlyPaths).toEqual(["scratch.tex"]);
      }),
    ),
  );

  it.live("marks an older kept copy changed when a later sync finds it rewritten", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "A" }, remote: { "main.tex": "B" } });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        const [copy] = (yield* w.connection).retention.copies;
        expect(copy!.state).toBe("releasable");
        const vault = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION }))[0]!;
        yield* Effect.promise(async () => {
          const found = (await NodeFSP.readdir(w.stateRoot, { recursive: true })).find((path) =>
            path.endsWith(vault.kept),
          );
          await NodeFSP.writeFile(NodePath.join(w.stateRoot, found!), "late write");
        });
        w.setRemote({ "main.tex": "B", "other.tex": "O" });
        expect(yield* w.sync("request-2")).toMatchObject({ _tag: "applied" });
        expect(
          (yield* w.connection).retention.copies.find((entry) => entry.applyId === copy!.applyId)!
            .state,
        ).toBe("changed");
      }),
    ),
  );

  it.live("never releases a copy a late writer changed before adoption", () => {
    let stateRoot = "";
    let rewritten = false;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          // After the applier hashed the kept copy, a writer still holding the displaced
          // file rewrites it at the same size, before the coordinator adopts it.
          at: (point) =>
            point !== "applied" || rewritten
              ? Effect.void
              : Effect.promise(async () => {
                  rewritten = true;
                  await NodeFSP.writeFile(await firstKept(stateRoot), "Z");
                }),
        });
        stateRoot = w.stateRoot;
        expect(yield* w.sync()).toMatchObject({
          _tag: "applied",
          adopted: { outcome: "complete" },
        });
        expect(yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).toMatchObject([
          { state: "changed", revision: revision("A"), keptRevision: revision("Z"), unread: false },
        ]);
        // A later sync keeps it changed.
        w.setRemote({ "main.tex": "B", "other.tex": "O" });
        expect(yield* w.sync("request-2")).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).retention.copies).toMatchObject([{ state: "changed" }]);
      }),
    );
  });

  it.live("never releases a copy whose path was replaced while its file was read", () => {
    let stateRoot = "";
    let swapped = false;
    let undo = () => {};
    return run(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => undo()));
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          // When adoption first examines the kept copy's open file, the path is given
          // to another file: the open one still reads as the unchanged copy of A.
          at: (point) =>
            point !== "applied" || swapped
              ? Effect.void
              : Effect.promise(async () => {
                  const path = await firstKept(stateRoot);
                  const probe = await NodeFSP.open(path, "r");
                  const ino = (await probe.stat({ bigint: true })).ino;
                  const prototype = Object.getPrototypeOf(probe) as { stat: typeof probe.stat };
                  const stat = prototype.stat;
                  await probe.close();
                  undo = () => {
                    prototype.stat = stat;
                  };
                  prototype.stat = async function (this: typeof probe, options) {
                    const found = await stat.call(this, { bigint: true });
                    if (!swapped && found.ino === ino) {
                      swapped = true;
                      undo();
                      await NodeFSP.rename(path, `${path}-moved`);
                      await NodeFSP.writeFile(path, "Z");
                    }
                    return stat.call(this, options);
                  } as typeof probe.stat;
                }),
        });
        stateRoot = w.stateRoot;
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        expect(swapped).toBe(true);
        expect((yield* w.connection).retention.copies).toMatchObject([
          { state: "changed", stamp: "0:0" },
        ]);
        expect(yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).toMatchObject([
          { keptRevision: revision("Z"), unread: false },
        ]);
      }),
    );
  });

  it.live("leaves a folder file past the read limit unread, in listing and restore", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          limits: { fileBytes: 2, listingBytes: 10 },
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        yield* write(w.folder, { "main.tex": "LONG" });
        const [copy] = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        expect(copy).toMatchObject({
          keptRevision: revision("A"),
          currentRevision: null,
          unread: true,
        });
        // Neither "absent" nor the file's exact bytes lets a restore read past the limit.
        for (const [attempt, currentRevision] of [null, revision("LONG")].entries())
          expect(
            yield* w.coordinator.restoreKept({
              connectionId: CONNECTION,
              requestId: `restore-${attempt}`,
              applyId: copy!.applyId,
              kept: copy!.kept,
              keptRevision: copy!.keptRevision!,
              currentRevision,
            }),
          ).toEqual({ _tag: "stale" });
        expect(yield* read(w.folder, "main.tex")).toBe("LONG");
      }),
    ),
  );

  it.live("lists a copy grown past what a restore reads back as unread, and restores none", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          limits: { fileBytes: 4 },
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        const [copy] = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        expect(copy).toMatchObject({ keptRevision: revision("A"), unread: false });
        yield* Effect.promise(async () =>
          NodeFSP.writeFile(await firstKept(w.stateRoot), "grown by a late writer"),
        );
        expect(yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).toMatchObject([
          { keptRevision: null, currentRevision: revision("B"), unread: true },
        ]);
        // Even naming the grown bytes exactly, a restore never reads past its limit.
        for (const [attempt, keptRevision] of [
          copy!.keptRevision!,
          revision("grown by a late writer"),
        ].entries())
          expect(
            yield* w.coordinator.restoreKept({
              connectionId: CONNECTION,
              requestId: `restore-${attempt}`,
              applyId: copy!.applyId,
              kept: copy!.kept,
              keptRevision,
              currentRevision: copy!.currentRevision,
            }),
          ).toEqual({ _tag: "stale" });
        expect(yield* read(w.folder, "main.tex")).toBe("B");
      }),
    ),
  );

  it.live("stops reading at one listing's budget and lists the rest unread", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A", "other.tex": "O" },
          remote: { "main.tex": "B", "other.tex": "P" },
          // Each folder file is one byte: the budget covers the first one read.
          limits: { listingBytes: 1 },
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        // The kept copies' stamps still match, so they need no read; the folder's files do.
        const listed = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        expect(listed.map((copy) => copy.keptRevision).sort()).toEqual(
          [revision("A"), revision("O")].sort(),
        );
        const unread = listed.filter((copy) => copy.unread);
        expect(unread).toHaveLength(1);
        expect(unread[0]!.currentRevision).toBeNull();
        expect(listed.find((copy) => !copy.unread)!.currentRevision).not.toBeNull();
        // Unread is not absent: a restore claiming the file is gone finds it stale.
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: unread[0]!.applyId,
            kept: unread[0]!.kept,
            keptRevision: unread[0]!.keptRevision!,
            currentRevision: unread[0]!.currentRevision,
          }),
        ).toEqual({ _tag: "stale" });
        expect(yield* read(w.folder, unread[0]!.relativePath)).toBe(
          unread[0]!.relativePath === "main.tex" ? "B" : "P",
        );
      }),
    ),
  );

  it.live("tracks restored conflict material as unresolved again", () =>
    run(
      Effect.gen(function* () {
        const marked = "<<<<<<< mine\nours\n=======\ntheirs\n>>>>>>> theirs\n";
        const w = yield* world({
          synced: { "main.tex": marked, "other.tex": "O" },
          remote: { "main.tex": "resolved", "other.tex": "O" },
          markerPaths: ["main.tex"],
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        // A later sync finds the material gone and stops tracking it.
        w.setRemote({ "main.tex": "resolved", "other.tex": "O2" });
        expect(yield* w.sync("request-2")).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).markers).toEqual([]);
        const copy = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).find(
          (entry) => entry.relativePath === "main.tex",
        )!;
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: copy.currentRevision,
          }),
        ).toMatchObject({ _tag: "restored" });
        expect((yield* w.connection).markers).toEqual([
          { path: "main.tex", folderPaths: [], overleafPaths: ["main.tex"] },
        ]);
      }),
    ),
  );

  it.live("keeps a restore the applier could not finish as a forced conflict", () => {
    let interfere = false;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          // Just after the restore's step, another writer puts B back.
          native: async (point, folder) => {
            if (!interfere || point !== "done") return;
            interfere = false;
            await NodeFSP.writeFile(NodePath.join(folder, "main.tex"), "B");
          },
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        const [copy] = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        // A group recorded earlier stays beside the restore's.
        const current = yield* w.connection;
        yield* w.store.replaceConnection({
          expectedRevision: current.revision,
          next: {
            ...current,
            revision: current.revision + 1,
            forcedConflicts: [["earlier.tex"]],
            updatedAt: "2026-10-22T12:00:00.000Z",
          },
        });
        interfere = true;
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy!.applyId,
            kept: copy!.kept,
            keptRevision: copy!.keptRevision!,
            currentRevision: copy!.currentRevision,
          }),
        ).toMatchObject({
          _tag: "restored",
          adopted: { outcome: "attention", interrupted: [["main.tex"]] },
        });
        expect(yield* read(w.folder, "main.tex")).toBe("B");
        expect((yield* w.connection).forcedConflicts).toEqual([["earlier.tex"], ["main.tex"]]);
        // The next review asks about main.tex instead of calling the folder up to date.
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        expect(next.review.conflicts.map((conflict) => [...conflict.paths])).toContainEqual([
          "main.tex",
        ]);
      }),
    );
  });

  it.live("refuses before writing a restore with no room for the group it may leave", () =>
    run(
      Effect.gen(function* () {
        const { w, copy } = yield* syncedThenListed();
        const current = yield* w.connection;
        yield* w.store.replaceConnection({
          expectedRevision: current.revision,
          next: {
            ...current,
            revision: current.revision + 1,
            forcedConflicts: Array.from({ length: 4_000 }, (_, n) => [`group-${n}.tex`]),
            updatedAt: "2026-10-22T12:00:00.000Z",
          },
        });
        const refused = yield* Effect.flip(
          w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: copy.currentRevision,
          }),
        );
        expect(refused).toMatchObject({
          _tag: "OverleafRetainedLimitError",
          limit: "conflict-group",
        });
        expect(yield* read(w.folder, "main.tex")).toBe("B");
        expect((yield* w.connection).activeApply).toBeNull();
      }),
    ),
  );

  it.live("refuses before writing a restore that would track too much conflict material", () =>
    run(
      Effect.gen(function* () {
        const marked = "<<<<<<< mine\nours\n=======\ntheirs\n>>>>>>> theirs\n";
        const w = yield* world({
          synced: { "main.tex": marked },
          remote: { "main.tex": "resolved" },
          markerPaths: ["main.tex"],
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        const copy = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION }))[0]!;
        // Other files' conflict material fills the record; bringing main.tex's back
        // would track one more.
        const current = yield* w.connection;
        yield* w.store.replaceConnection({
          expectedRevision: current.revision,
          next: {
            ...current,
            revision: current.revision + 1,
            markers: Array.from({ length: 2_000 }, (_, n) => ({
              path: `marked-${n}.tex`,
              folderPaths: [],
              overleafPaths: [`marked-${n}.tex`],
            })),
            updatedAt: "2026-10-22T12:00:00.000Z",
          },
        });
        const refused = yield* Effect.flip(
          w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: copy.currentRevision,
          }),
        );
        expect(refused).toMatchObject({
          _tag: "OverleafRetainedLimitError",
          limit: "marker-paths",
        });
        expect(yield* read(w.folder, "main.tex")).toBe("resolved");
        const after = yield* w.connection;
        expect(after.activeApply).toBeNull();
        expect(after.markers).toHaveLength(2_000);
      }),
    ),
  );

  it.live("keeps a restored local-only file local-only", () =>
    run(
      Effect.gen(function* () {
        const { w, copy } = yield* syncedThenListed();
        const current = yield* w.connection;
        yield* w.store.replaceConnection({
          expectedRevision: current.revision,
          next: {
            ...current,
            revision: current.revision + 1,
            managedPaths: current.managedPaths.filter((path) => path !== "main.tex"),
            localOnlyPaths: ["main.tex"],
            updatedAt: "2026-10-22T12:00:00.000Z",
          },
        });
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: copy.currentRevision,
          }),
        ).toMatchObject({ _tag: "restored" });
        const after = yield* w.connection;
        expect(after.localOnlyPaths).toEqual(["main.tex"]);
        expect(after.managedPaths).not.toContain("main.tex");
      }),
    ),
  );

  it.live("refuses to bring a file back beyond the managed-path limit", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "M", "old.tex": "kept text" },
          remote: { "main.tex": "M" },
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        const copy = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).find(
          (entry) => entry.relativePath === "old.tex",
        )!;
        const current = yield* w.connection;
        yield* w.store.replaceConnection({
          expectedRevision: current.revision,
          next: {
            ...current,
            revision: current.revision + 1,
            managedPaths: Array.from({ length: 2_000 }, (_, n) => `file-${n}.tex`),
            updatedAt: "2026-10-22T12:00:00.000Z",
          },
        });
        const refused = yield* Effect.flip(
          w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: null,
          }),
        );
        expect(refused).toMatchObject({
          _tag: "OverleafRetainedLimitError",
          limit: "managed-paths",
        });
        expect(yield* read(w.folder, "old.tex")).toBeNull();
        expect((yield* w.connection).activeApply).toBeNull();
      }),
    ),
  );

  /** Wraps the applier to report one more version of the first kept path, written to disk. */
  const withExtraVersion =
    (changed: boolean) =>
    (real: WorkspaceApplier["Service"]): WorkspaceApplier["Service"] =>
      WorkspaceApplier.of({
        apply: (input) =>
          real.apply(input).pipe(
            Effect.flatMap((result) => {
              const [first] = result.retained;
              if (first === undefined) return Effect.succeed(result);
              const provisional = NodePath.join(
                NodePath.dirname(first.retainedPath!),
                "provisional",
              );
              return Effect.promise(async () => {
                await NodeFSP.writeFile(provisional, "D");
                return {
                  ...result,
                  retained: [
                    ...result.retained,
                    {
                      ...first,
                      retainedPath: provisional,
                      retainedRevision: bytesRevision(new TextEncoder().encode("D")),
                      changed,
                    },
                  ],
                };
              });
            }),
          ),
      });

  it.live("never marks a record with another version releasable, even unchanged", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          applier: withExtraVersion(false),
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).retention.copies).toMatchObject([
          { relativePath: "main.tex", state: "ambiguous" },
        ]);
      }),
    ),
  );

  it.live("keeps listing every version when the applier's step record is damaged", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          applier: withExtraVersion(true),
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        yield* Effect.promise(async () => {
          const record = (await NodeFSP.readdir(w.stateRoot, { recursive: true })).find((path) =>
            path.endsWith("/step-0/record.json"),
          );
          await NodeFSP.writeFile(NodePath.join(w.stateRoot, record!), "{ damaged");
        });
        const listed = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        expect(listed).toHaveLength(2);
        // A damaged record is unknown authority to the file layer: the file waits for
        // explicit review before anything, a restore included, writes to it.
        const extra = listed.find((copy) => copy.kept.endsWith("/provisional"))!;
        const refused = yield* Effect.exit(
          w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: extra.applyId,
            kept: extra.kept,
            keptRevision: extra.keptRevision!,
            currentRevision: extra.currentRevision,
          }),
        );
        expect(String(refused)).toContain("needs explicit review");
        expect(yield* read(w.folder, "main.tex")).toBe("B");
      }),
    ),
  );

  it.live("refuses to prepare without this process's writable lease", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "A" }, remote: { "main.tex": "B" } });
        // Another store on the same state folder cannot take the lease this one holds.
        const other = yield* OverleafStateStore.make({
          root: w.stateRoot,
          volumeUuid: w.volumeUuid,
        });
        const blocked = yield* w.coordinatorWith(other);
        const refused = yield* Effect.exit(blocked.prepare({ connectionId: CONNECTION }));
        expect(String(refused)).toContain("OverleafStateLockedError");
      }),
    ),
  );
});
