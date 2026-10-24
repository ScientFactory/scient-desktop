// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * Undo of an accepted send (design section 4.3, engine addition 3): it puts back
 * in the folder what Overleaf had before that send, as a recorded local intent
 * that never publishes, and an ordinary sync then sends it. Real folders, a real
 * private repository and the real applier; real Git for Overleaf wherever the
 * undo is published or Overleaf's history matters.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type {
  OverleafConnectionDocument,
  OverleafPublicationAttempt,
} from "./OverleafConnectionState.ts";
import {
  CONNECTION,
  canApply,
  read,
  revision,
  run,
  world,
  write,
} from "./OverleafCoordinator.testkit.ts";

type World = Effect.Success<ReturnType<typeof world>>;

/** Prepares a review that sends `selected` new files too, and confirms it as offered. */
const syncSelecting = (w: World, requestId: string, selected: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const prepared = yield* w.coordinator.prepare({
      connectionId: CONNECTION,
      selections: { selectedAdditions: selected, collisionPaths: [], choices: new Map() },
    });
    if (prepared._tag !== "review") return yield* Effect.die(prepared);
    return yield* w.coordinator.confirm({
      connectionId: CONNECTION,
      requestId,
      reviewId: prepared.review.id,
      digest: prepared.review.digest,
      acknowledgements: prepared.review.binding.acknowledgements,
    });
  });

const remove = (folder: string, path: string) =>
  Effect.promise(() => NodeFSP.rm(NodePath.join(folder, path)));

const undo = (w: World, attemptNumber: number, requestId = "undo-1") =>
  w.coordinator.undo({ connectionId: CONNECTION, requestId, attemptNumber });

const pinned = (w: World, attemptNumber: number) =>
  Effect.forEach(["parent", "candidate"], (side) =>
    w.repos.readRef({ repo: w.repo, name: `attempt/${attemptNumber}/${side}` }),
  );

/** One accepted send of `main.tex` and `other.tex`, on a scripted Overleaf. */
const sentTwoFiles = (options: Pick<Parameters<typeof world>[0], "at" | "limits"> = {}) =>
  Effect.gen(function* () {
    const w = yield* world({
      synced: { "main.tex": "A", "other.tex": "O", "third.tex": "T" },
      remote: { "main.tex": "A", "other.tex": "O", "third.tex": "T" },
      ...options,
    });
    yield* write(w.folder, { "main.tex": "A2", "other.tex": "O2", "third.tex": "T2" });
    expect(yield* w.sync("send-1")).toMatchObject({
      publication: { _tag: "accepted", attemptNumber: 1 },
    });
    return w;
  });

describe.skipIf(!canApply)("OverleafCoordinator, undo", () => {
  it.live("undoes a send that changed, added, deleted and renamed files; a sync sends it", () =>
    run(
      Effect.gen(function* () {
        const original = {
          "main.tex": "A",
          "old.tex": "chapter text that moves, long enough to be found as a rename\n",
          "gone.tex": "G",
          "keep.tex": "K",
        };
        const w = yield* world({ overleaf: "git", synced: original, remote: original });
        yield* write(w.folder, {
          "main.tex": "A, edited here",
          "new.tex": original["old.tex"],
          "added.tex": "N",
        });
        yield* remove(w.folder, "old.tex");
        yield* remove(w.folder, "gone.tex");
        expect(yield* syncSelecting(w, "send-1", ["added.tex", "new.tex"])).toMatchObject({
          publication: { _tag: "accepted", attemptNumber: 1 },
        });
        expect((yield* w.overleafNow).contents).toEqual({
          "main.tex": "A, edited here",
          "new.tex": original["old.tex"],
          "added.tex": "N",
          "keep.tex": "K",
        });
        const before = yield* w.connection;

        expect(yield* undo(w, 1)).toEqual({
          _tag: "undone",
          restored: ["main.tex"],
          removed: ["added.tex", "new.tex"],
          recreated: ["gone.tex", "old.tex"],
          skipped: [],
          adopted: expect.objectContaining({ outcome: "complete", interrupted: [] }),
        });
        for (const [path, content] of Object.entries(original))
          expect(yield* read(w.folder, path)).toBe(content);
        expect(yield* read(w.folder, "new.tex")).toBeNull();
        expect(yield* read(w.folder, "added.tex")).toBeNull();
        // A local change only: the base stays, nothing was sent, and every file it
        // displaced is kept, never released automatically.
        const after = yield* w.connection;
        expect(after.base).toEqual(before.base);
        expect(after.activeApply).toBeNull();
        expect(w.pushes).toHaveLength(1);
        expect(
          after.retention.copies
            .filter((copy) => copy.state === "kept")
            .map((copy) => copy.relativePath)
            .sort(),
        ).toEqual(["added.tex", "main.tex", "new.tex"]);

        // The ordinary sync sends the undo, and Overleaf has its earlier content again.
        expect(yield* w.sync("request-2")).toMatchObject({
          publication: { _tag: "accepted", attemptNumber: 2 },
        });
        expect((yield* w.overleafNow).contents).toEqual(original);
        expect(w.pushes).toHaveLength(2);
      }),
    ),
  );

  it.live("leaves a file edited since the send alone, and reports one already put back", () =>
    run(
      Effect.gen(function* () {
        const w = yield* sentTwoFiles();
        yield* write(w.folder, { "main.tex": "A3, edited since", "third.tex": "T" });
        expect(yield* undo(w, 1)).toMatchObject({
          _tag: "undone",
          restored: ["other.tex"],
          removed: [],
          recreated: [],
          skipped: [
            { path: "main.tex", reason: "changed" },
            { path: "third.tex", reason: "already-undone" },
          ],
          adopted: { outcome: "complete" },
        });
        expect(yield* read(w.folder, "main.tex")).toBe("A3, edited since");
        expect(yield* read(w.folder, "other.tex")).toBe("O");
        expect(yield* read(w.folder, "third.tex")).toBe("T");
      }),
    ),
  );

  it.live("lists the sends it can undo, newest first, with what each changed on Overleaf", () =>
    run(
      Effect.gen(function* () {
        const w = yield* sentTwoFiles();
        const listed = () => w.coordinator.undoableSends({ connectionId: CONNECTION });
        expect(yield* listed()).toEqual([
          {
            attemptNumber: 1,
            recordedAt: expect.any(String),
            changes: [
              { kind: "modified", path: "main.tex" },
              { kind: "modified", path: "other.tex" },
              { kind: "modified", path: "third.tex" },
            ],
          },
        ]);
        // An undo writes the folder only; the sync after it is the next accepted send.
        expect(yield* undo(w, 1)).toMatchObject({ _tag: "undone" });
        expect(yield* w.sync("send-2")).toMatchObject({
          publication: { _tag: "accepted", attemptNumber: 2 },
        });
        expect((yield* listed()).map((send) => send.attemptNumber)).toEqual([2, 1]);
        // Listing reads only: no receipt, no hold, nothing written.
        expect((yield* w.connection).activeApply).toBeNull();
      }),
    ),
  );

  it.live("leaves a deleted file's name alone when another spelling of it is there now", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A", "Figure.tex": "F" },
          remote: { "main.tex": "A", "Figure.tex": "F" },
        });
        yield* remove(w.folder, "Figure.tex");
        yield* write(w.folder, { "main.tex": "A2" });
        expect(yield* w.sync("send-1")).toMatchObject({ publication: { _tag: "accepted" } });
        // Recreating Figure.tex would write over figure.tex on a disk that ignores case.
        yield* write(w.folder, { "figure.tex": "newer, not synced" });
        expect(yield* undo(w, 1)).toMatchObject({
          restored: ["main.tex"],
          recreated: [],
          skipped: [{ path: "Figure.tex", reason: "name-clash" }],
        });
        expect(yield* read(w.folder, "figure.tex")).toBe("newer, not synced");
        expect(yield* read(w.folder, "main.tex")).toBe("A");
      }),
    ),
  );

  it.live("is not eligible for a send that is unknown, not sent, out of date or not recorded", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "A" }, remote: { "main.tex": "A" } });
        const synced = yield* w.connection;
        const attempt = (attemptNumber: number): OverleafPublicationAttempt => ({
          attemptNumber,
          operationId: `operation-${attemptNumber}`,
          requestId: `request-${attemptNumber}`,
          planDigest: "a".repeat(64),
          authority: synced.binding,
          branch: "main",
          parentCommit: synced.base.commit!,
          candidateCommit: synced.base.commit!,
          candidateTree: synced.base.tree!,
          baseGeneration: synced.base.generation,
          outcome: "unknown",
          evidence: null,
          recordedAt: "2026-10-24T10:00:00.000Z",
        });
        // Three sends recorded, then two of them settled without acceptance.
        yield* w.store.replaceConnection({
          expectedRevision: synced.revision,
          next: {
            ...synced,
            revision: synced.revision + 1,
            lastAttemptNumber: 3,
            attempts: [attempt(1), attempt(2), attempt(3)],
          },
        });
        const recorded = yield* w.connection;
        yield* w.store.replaceConnection({
          expectedRevision: recorded.revision,
          next: {
            ...recorded,
            revision: recorded.revision + 1,
            attempts: [
              attempt(1),
              { ...attempt(2), outcome: "not-sent", evidence: "send-refused" },
              { ...attempt(3), outcome: "out-of-date", evidence: "push-out-of-date" },
            ],
          },
        });
        const before = yield* w.connection;
        const reasons = [];
        for (const [index, attemptNumber] of [1, 2, 3, 9].entries()) {
          const result = yield* undo(w, attemptNumber, `undo-${index}`);
          reasons.push(result._tag === "not-eligible" ? result.reason : result._tag);
        }
        expect(reasons).toEqual(["unresolved", "not-sent", "out-of-date", "not-recorded"]);
        expect((yield* w.connection).revision).toBe(before.revision);
        expect(yield* read(w.folder, "main.tex")).toBe("A");
      }),
    ),
  );

  it.live("returns the receipt for a repeated request and applies once", () =>
    run(
      Effect.gen(function* () {
        const w = yield* sentTwoFiles();
        expect(yield* undo(w, 1)).toMatchObject({
          _tag: "undone",
          adopted: { outcome: "complete" },
        });
        // Edited again after the undo: a repeat must not put the earlier version back.
        yield* write(w.folder, { "main.tex": "edited after the undo" });
        const before = yield* w.connection;
        expect(yield* undo(w, 1)).toMatchObject({
          _tag: "duplicate",
          receipt: { kind: "undo", status: "completed", resultCategory: "undone-complete" },
        });
        expect((yield* w.connection).revision).toBe(before.revision);
        expect(yield* read(w.folder, "main.tex")).toBe("edited after the undo");
      }),
    ),
  );

  it.live("recovers an undo interrupted after the applier ran, once", () => {
    let crash = false;
    return run(
      Effect.gen(function* () {
        const w = yield* sentTwoFiles({
          at: (point) =>
            crash && point === "applied" ? Effect.die(new Error("process died")) : Effect.void,
        });
        const before = yield* w.connection;
        crash = true;
        expect(Exit.isFailure(yield* Effect.exit(undo(w, 1)))).toBe(true);
        crash = false;
        expect((yield* w.connection).activeApply).toMatchObject({
          kind: "sync-undo",
          undoneAttempt: 1,
        });
        // While it is pending, the attempt and its pins stay.
        expect((yield* pinned(w, 1)).every((oid) => oid !== null)).toBe(true);
        expect(yield* w.coordinator.recover({ connectionId: CONNECTION })).toMatchObject({
          _tag: "recovered",
          adopted: { outcome: "complete" },
        });
        const after = yield* w.connection;
        expect(after.activeApply).toBeNull();
        expect(after.base).toEqual(before.base);
        expect(yield* read(w.folder, "main.tex")).toBe("A");
        expect(yield* read(w.folder, "other.tex")).toBe("O");
        const kept = after.retention.copies.filter((copy) => copy.state === "kept").length;
        expect(kept).toBe(3);
        // Nothing is left to recover, the retried request returns its receipt, and a
        // new request finds everything already put back: it is applied once.
        expect(yield* w.coordinator.recover({ connectionId: CONNECTION })).toMatchObject({
          _tag: "none",
        });
        expect(yield* undo(w, 1)).toMatchObject({
          _tag: "duplicate",
          receipt: { status: "running" },
        });
        expect(yield* undo(w, 1, "undo-2")).toMatchObject({
          _tag: "undone",
          restored: [],
          adopted: null,
          skipped: [
            { path: "main.tex", reason: "already-undone" },
            { path: "other.tex", reason: "already-undone" },
            { path: "third.tex", reason: "already-undone" },
          ],
        });
        const last = yield* w.connection;
        expect(last.retention.copies.filter((copy) => copy.state === "kept")).toHaveLength(kept);
      }),
    );
  });

  it.live(
    "keeps Undo possible after base rotation, rewritten history, garbage collection and a restart",
    () =>
      run(
        Effect.gen(function* () {
          const w = yield* world({
            overleaf: "git",
            synced: { "main.tex": "A", "notes.tex": "n0" },
            remote: { "main.tex": "A", "notes.tex": "n0" },
            // No earlier base kept instead of twenty, so one later sync rotates the send's out.
            limits: { priorBases: 0 },
          });
          yield* write(w.folder, { "main.tex": "A, sent" });
          expect(yield* w.sync("send-1")).toMatchObject({ publication: { _tag: "accepted" } });
          const sent = (yield* w.connection).attempts[0]!;
          // Overleaf's history is replaced: neither commit of the send is in it any more.
          yield* w.rewriteHistory([{ "main.tex": "A, sent", "notes.tex": "n0" }]);
          // More later syncs than the connection keeps bases for.
          yield* w.collaborate({ "main.tex": "A, sent", "notes.tex": "n1" });
          expect(yield* w.sync("later-1")).toMatchObject({ _tag: "applied" });
          const rotated = yield* w.connection;
          const bases = [rotated.base, ...rotated.priorBases].map((base) => base.commit);
          expect(bases).not.toContain(sent.parentCommit);
          expect(bases).not.toContain(sent.candidateCommit);
          yield* w.collectGarbage;
          const restarted = yield* w.restart();

          expect(
            yield* restarted.coordinator.undo({
              connectionId: CONNECTION,
              requestId: "undo-1",
              attemptNumber: 1,
            }),
          ).toMatchObject({ _tag: "undone", restored: ["main.tex"], skipped: [] });
          expect(yield* read(w.folder, "main.tex")).toBe("A");
          expect(yield* read(w.folder, "notes.tex")).toBe("n1");
          // The next sync sends it (the first test sends one through).
          const next = yield* restarted.coordinator.prepare({ connectionId: CONNECTION });
          if (next._tag !== "review") return yield* Effect.die(next);
          expect(next.review.outgoing).toMatchObject([{ kind: "modified", path: "main.tex" }]);
        }),
      ),
  );

  it.live("releases an attempt's pins when it is pruned, and Undo is then not offered", () =>
    run(
      Effect.gen(function* () {
        const w = yield* sentTwoFiles();
        expect((yield* pinned(w, 1)).every((oid) => oid !== null)).toBe(true);
        // Sixty-three more sends settled without acceptance fill the attempt history
        // (recorded unknown, at most sixteen at a time, then settled).
        for (let first = 2; first <= 64; first += 16) {
          const numbers = Array.from({ length: Math.min(16, 65 - first) }, (_, i) => first + i);
          const current = yield* w.connection;
          const recorded = numbers.map((attemptNumber): OverleafPublicationAttempt => ({
            ...current.attempts[0]!,
            attemptNumber,
            operationId: `operation-${attemptNumber}`,
            requestId: `request-${attemptNumber}`,
            baseGeneration: current.base.generation,
            outcome: "unknown",
            evidence: null,
          }));
          yield* w.store.replaceConnection({
            expectedRevision: current.revision,
            next: {
              ...current,
              revision: current.revision + 1,
              lastAttemptNumber: numbers.at(-1)!,
              attempts: [...current.attempts, ...recorded],
            },
          });
          const unknown = yield* w.connection;
          yield* w.store.replaceConnection({
            expectedRevision: unknown.revision,
            next: {
              ...unknown,
              revision: unknown.revision + 1,
              attempts: unknown.attempts.map((attempt) =>
                attempt.outcome === "unknown"
                  ? { ...attempt, outcome: "not-sent" as const, evidence: "send-refused" as const }
                  : attempt,
              ),
            },
          });
        }
        expect((yield* w.connection).attempts).toHaveLength(64);
        // The next send makes room by pruning the oldest settled attempt: the accepted one.
        yield* write(w.folder, { "main.tex": "A4" });
        expect(yield* w.sync("send-65")).toMatchObject({
          publication: { _tag: "accepted", attemptNumber: 65 },
        });
        const after = yield* w.connection;
        expect(after.attempts.map((attempt) => attempt.attemptNumber)).not.toContain(1);
        expect(yield* pinned(w, 1)).toEqual([null, null]);
        expect((yield* pinned(w, 65)).every((oid) => oid !== null)).toBe(true);
        expect(yield* undo(w, 1)).toEqual({ _tag: "not-eligible", reason: "not-recorded" });
      }),
    ),
  );

  it.live("reserves a kept copy for every path it touches, a file it recreates included", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A", "gone.tex": "G" },
          remote: { "main.tex": "A", "gone.tex": "G" },
        });
        yield* write(w.folder, { "main.tex": "A2" });
        yield* remove(w.folder, "gone.tex");
        expect(yield* w.sync("send-1")).toMatchObject({ publication: { _tag: "accepted" } });
        // One record short of the limit: room for the file it replaces, not also for
        // a version a step could keep where it recreates gone.tex.
        const sent = yield* w.connection;
        const filler = (
          index: number,
        ): OverleafConnectionDocument["retention"]["copies"][number] => ({
          applyId: "earlier",
          relativePath: `earlier/${index}.tex`,
          revision: "sha256:0",
          state: "kept",
          retainedAt: sent.updatedAt,
          retainedAtSyncCount: sent.completedSyncCount,
          kept: `earlier/files/step-${index}/retained`,
          markers: false,
          markerLinks: [],
          versions: [],
          stamp: "0:0",
        });
        yield* w.store.replaceConnection({
          expectedRevision: sent.revision,
          next: {
            ...sent,
            revision: sent.revision + 1,
            retention: {
              ...sent.retention,
              copies: [
                ...sent.retention.copies,
                ...Array.from({ length: 4_095 - sent.retention.copies.length }, (_, index) =>
                  filler(index),
                ),
              ],
            },
          },
        });
        const before = yield* w.connection;
        expect(yield* Effect.flip(undo(w, 1))).toMatchObject({
          _tag: "OverleafRetainedLimitError",
          limit: "kept-copies",
        });
        const after = yield* w.connection;
        expect(after.revision).toBe(before.revision);
        expect(after.activeApply).toBeNull();
        expect(yield* read(w.folder, "main.tex")).toBe("A2");
        expect(yield* read(w.folder, "gone.tex")).toBeNull();
      }),
    ),
  );

  it.live("rewrites pins found missing, and Undo is not eligible once the history is gone", () =>
    run(
      Effect.gen(function* () {
        // No earlier base kept, so only the attempt's pins hold the send's commits.
        const w = yield* sentTwoFiles({ limits: { priorBases: 0 } });
        const unpin = Effect.forEach(["parent", "candidate"], (side) =>
          w.repos.deleteRef({ repo: w.repo, name: `attempt/1/${side}` }),
        );
        // As a record from before accepted sends were pinned: the refs were never written.
        yield* unpin;
        w.setRemote({ "main.tex": "A2", "other.tex": "O2", "third.tex": "T3" });
        expect(yield* w.sync("later-1")).toMatchObject({ publication: { _tag: "none" } });
        expect((yield* pinned(w, 1)).every((oid) => oid !== null)).toBe(true);
        // Once the objects are gone, Undo says so instead of failing in Git.
        yield* unpin;
        yield* w.collectGarbage;
        expect(yield* undo(w, 1)).toEqual({
          _tag: "not-eligible",
          reason: "history-unavailable",
        });
        expect(yield* read(w.folder, "main.tex")).toBe("A2");
        // A ref kept only for Undo whose object is gone never blocks a later change of
        // the record (here a kept-copy restore).
        const [copy] = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy!.applyId,
            kept: copy!.kept,
            keptRevision: copy!.keptRevision!,
            currentRevision: copy!.currentRevision,
          }),
        ).toMatchObject({ _tag: "restored" });
        expect(yield* pinned(w, 1)).toEqual([null, null]);
      }),
    ),
  );

  it.live("undoes a rename in a project at the managed-file limit", () =>
    run(
      Effect.gen(function* () {
        const chapter = "chapter text that moves, long enough to be found as a rename\n";
        const w = yield* world({
          synced: { "main.tex": "M", "old.tex": chapter },
          remote: { "main.tex": "M", "old.tex": chapter },
        });
        yield* write(w.folder, { "new.tex": chapter });
        yield* remove(w.folder, "old.tex");
        expect(yield* syncSelecting(w, "send-1", ["new.tex"])).toMatchObject({
          publication: { _tag: "accepted" },
        });
        // Paths the connection manages up to the limit (absent from the folder here).
        const sent = yield* w.connection;
        const fillers = Array.from(
          { length: 2_000 - sent.managedPaths.length },
          (_, index) => `fillers/${index}.tex`,
        );
        yield* w.store.replaceConnection({
          expectedRevision: sent.revision,
          next: {
            ...sent,
            revision: sent.revision + 1,
            managedPaths: [...sent.managedPaths, ...fillers].sort(),
          },
        });
        expect(yield* undo(w, 1)).toMatchObject({
          _tag: "undone",
          removed: ["new.tex"],
          recreated: ["old.tex"],
          adopted: { outcome: "complete" },
        });
        const after = yield* w.connection;
        expect(after.managedPaths).toHaveLength(2_000);
        expect(after.managedPaths).toContain("old.tex");
        expect(after.managedPaths).not.toContain("new.tex");
        expect(yield* read(w.folder, "old.tex")).toBe(chapter);
      }),
    ),
  );

  it.live("forgets reviews across a restart, and restarts more than once", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "A" }, remote: { "main.tex": "A" } });
        yield* write(w.folder, { "main.tex": "B" });
        const prepared = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (prepared._tag !== "review") return yield* Effect.die(prepared);
        const first = yield* w.restart();
        expect(
          yield* first.coordinator.confirm({
            connectionId: CONNECTION,
            requestId: "request-1",
            reviewId: prepared.review.id,
            digest: prepared.review.digest,
            acknowledgements: prepared.review.binding.acknowledgements,
          }),
        ).toMatchObject({ _tag: "review-refused" });
        // The second restart takes the lease the first one's store held.
        const second = yield* w.restart();
        expect(yield* second.coordinator.prepare({ connectionId: CONNECTION })).toMatchObject({
          _tag: "review",
        });
        expect(yield* read(w.folder, "main.tex")).toBe("B");
      }),
    ),
  );

  it.live("keeps a file managed when the undo could not remove it", () => {
    let interfere = false;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "M" },
          remote: { "main.tex": "M" },
          // Edited just before the undo's step removes it.
          beforeStep: async (path, folder) => {
            if (!interfere || path !== "added.tex") return;
            interfere = false;
            await NodeFSP.writeFile(NodePath.join(folder, "added.tex"), "N, edited during Undo");
          },
        });
        yield* write(w.folder, { "added.tex": "N" });
        expect(yield* syncSelecting(w, "send-1", ["added.tex"])).toMatchObject({
          publication: { _tag: "accepted" },
        });
        // Overleaf deletes it, and its kept copy is put back: managed, outside the base.
        w.setRemote({ "main.tex": "M" });
        expect(yield* w.sync("remote-deletion")).toMatchObject({ publication: { _tag: "none" } });
        const copy = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).find(
          (entry) => entry.relativePath === "added.tex" && entry.keptRevision === revision("N"),
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
        ).toMatchObject({ _tag: "restored", adopted: { outcome: "complete" } });
        interfere = true;
        expect(yield* undo(w, 1)).toMatchObject({
          removed: ["added.tex"],
          adopted: { outcome: "attention" },
        });
        expect(yield* read(w.folder, "added.tex")).toBe("N, edited during Undo");
        expect((yield* w.connection).managedPaths).toContain("added.tex");
        // The edit still goes out with the next sync.
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        expect(next.review.outgoing).toContainEqual({ kind: "added", path: "added.tex" });
      }),
    );
  });

  it.live("reads a path the send changed that a later sync stopped reading", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A", "keep.tex": "K" },
          remote: { "main.tex": "A", "keep.tex": "K" },
        });
        yield* write(w.folder, { "main.tex": "B" });
        expect(yield* w.sync("send-1")).toMatchObject({ publication: { _tag: "accepted" } });
        yield* remove(w.folder, "main.tex");
        expect(yield* w.sync("send-2")).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.connection).managedPaths).not.toContain("main.tex");
        // The same bytes the first send left, written again: that send's to undo.
        yield* write(w.folder, { "main.tex": "B" });
        expect(yield* undo(w, 1)).toMatchObject({ restored: ["main.tex"], skipped: [] });
        expect(yield* read(w.folder, "main.tex")).toBe("A");
        expect((yield* w.connection).managedPaths).toContain("main.tex");
      }),
    ),
  );

  it.live("fails a sync whose pin repair fails while the objects exist, then repairs it", () =>
    run(
      Effect.gen(function* () {
        const w = yield* sentTwoFiles();
        const lock = (side: string) => NodePath.join(w.repo, `refs/scient/attempt/1/${side}.lock`);
        // The refs are missing and Git cannot write them (stale locks), while the
        // commits they name are still there.
        for (const side of ["parent", "candidate"]) {
          yield* w.repos.deleteRef({ repo: w.repo, name: `attempt/1/${side}` });
          yield* Effect.promise(() => NodeFSP.writeFile(lock(side), "stale lock"));
        }
        w.setRemote({ "main.tex": "A2", "other.tex": "O2", "third.tex": "T3" });
        const before = yield* w.connection;
        expect(yield* Effect.flip(w.sync("later-1"))).toMatchObject({ _tag: "OverleafGitError" });
        expect((yield* w.connection).revision).toBe(before.revision);
        expect(yield* pinned(w, 1)).toEqual([null, null]);
        // Once Git can write them, the next change of the record repairs them first.
        for (const side of ["parent", "candidate"])
          yield* Effect.promise(() => NodeFSP.rm(lock(side)));
        expect(yield* undo(w, 1)).toMatchObject({
          _tag: "undone",
          restored: ["main.tex", "other.tex", "third.tex"],
        });
        expect((yield* pinned(w, 1)).every((oid) => oid !== null)).toBe(true);
      }),
    ),
  );

  it.live("keeps a local-only file local-only when the undo could not write it", () => {
    let interfere = false;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A", "keep.tex": "K" },
          remote: { "main.tex": "A", "keep.tex": "K" },
          // Changed just before the undo's step writes it.
          beforeStep: async (path, folder) => {
            if (!interfere || path !== "main.tex") return;
            interfere = false;
            await NodeFSP.writeFile(NodePath.join(folder, path), "private edit during Undo");
          },
        });
        yield* write(w.folder, { "main.tex": "B" });
        expect(yield* w.sync("send-1")).toMatchObject({ publication: { _tag: "accepted" } });
        yield* remove(w.folder, "main.tex");
        expect(yield* w.sync("send-2")).toMatchObject({ publication: { _tag: "accepted" } });
        // Written again with the first send's bytes and left unsent, as a sync records an
        // addition left unchecked: local-only.
        yield* write(w.folder, { "main.tex": "B" });
        const deleted = yield* w.connection;
        yield* w.store.replaceConnection({
          expectedRevision: deleted.revision,
          next: {
            ...deleted,
            revision: deleted.revision + 1,
            localOnlyPaths: [...deleted.localOnlyPaths, "main.tex"],
          },
        });
        interfere = true;
        expect(yield* undo(w, 1)).toMatchObject({
          restored: ["main.tex"],
          adopted: { outcome: "attention" },
        });
        expect(yield* read(w.folder, "main.tex")).toBe("private edit during Undo");
        const after = yield* w.connection;
        expect(after.localOnlyPaths).toContain("main.tex");
        // Outside the base and unmanaged, the next sync leaves it alone.
        expect(after.managedPaths).not.toContain("main.tex");
        expect(after.base).toEqual(deleted.base);
      }),
    );
  });
});
