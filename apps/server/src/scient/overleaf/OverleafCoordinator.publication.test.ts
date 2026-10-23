// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * Publication (contract sections 5 and 6, acceptance A03, A07–A09, A12–A15, A31)
 * against a real local bare repository standing in for Overleaf, with real fetch
 * and push, real folders and the real applier. Every test counts pushes.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  CONNECTION,
  canApply,
  read,
  revision,
  run,
  world,
  write,
} from "./OverleafCoordinator.testkit.ts";

const marked = "<<<<<<< mine\nours\n=======\ntheirs\n>>>>>>> theirs\n";

describe.skipIf(!canApply)("OverleafCoordinator, publication", () => {
  it.live("sends a two-way sync once: the reviewed tree on the fetched head", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A", "other.tex": "O" },
          remote: { "main.tex": "A", "other.tex": "O2" },
        });
        yield* write(w.folder, { "main.tex": "A, edited here" });
        const fetched = yield* w.overleafNow;
        expect(yield* w.sync()).toMatchObject({
          _tag: "applied",
          adopted: { outcome: "complete" },
          publication: { _tag: "accepted", attemptNumber: 1 },
        });
        expect(w.pushes).toHaveLength(1);
        const overleaf = yield* w.overleafNow;
        expect(overleaf.contents).toEqual({ "main.tex": "A, edited here", "other.tex": "O2" });
        const after = yield* w.connection;
        expect(after.attempts).toMatchObject([
          {
            attemptNumber: 1,
            outcome: "accepted",
            evidence: "push-accepted",
            parentCommit: fetched.commit,
            candidateCommit: overleaf.commit,
          },
        ]);
        expect(after.base).toMatchObject({ commit: overleaf.commit, tree: overleaf.tree });
        expect(yield* read(w.folder, "other.tex")).toBe("O2");
        // Nothing left: the next review is up to date and sends nothing.
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        expect(next.review.upToDate).toBe(true);
      }),
    ),
  );

  it.live("sends nothing for an incoming-only sync", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
        });
        expect(yield* w.sync()).toMatchObject({ publication: { _tag: "none" } });
        expect(w.pushes).toHaveLength(0);
        expect((yield* w.connection).attempts).toEqual([]);
        expect(yield* read(w.folder, "main.tex")).toBe("B");
      }),
    ),
  );

  it.live("sends nothing when the folder changed after the apply", () => {
    let folder = "";
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "A" },
          at: (point) =>
            point === "adopted"
              ? write(folder, { "main.tex": "edited after the apply" })
              : Effect.void,
        });
        folder = w.folder;
        yield* write(w.folder, { "main.tex": "A, edited here" });
        expect(yield* w.sync()).toMatchObject({ publication: { _tag: "not-verified" } });
        expect(w.pushes).toHaveLength(0);
        expect((yield* w.connection).attempts).toEqual([]);
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": "A" });
        // The later edit is the next review's to send.
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        expect(next.review.outgoing.map((change) => change.kind)).toEqual(["modified"]);
      }),
    );
  });

  it.live("sends nothing when a file Overleaf deleted is back before verification", () => {
    let folder = "";
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "a.tex": "A", "gone.tex": "old" },
          remote: { "a.tex": "A" },
          // The deletion is applied; then the file is written again before verification.
          at: (point) =>
            point === "adopted" ? write(folder, { "gone.tex": "new work" }) : Effect.void,
        });
        folder = w.folder;
        yield* write(w.folder, { "a.tex": "B" });
        expect(yield* w.sync()).toMatchObject({ publication: { _tag: "not-verified" } });
        expect(w.pushes).toHaveLength(0);
        expect(yield* read(w.folder, "gone.tex")).toBe("new work");
      }),
    );
  });

  it.live("sends nothing when a kept copy changed after the apply", () => {
    let held: NodeFSP.FileHandle | undefined;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "a.tex": "A", "other.tex": "O" },
          remote: { "a.tex": "A", "other.tex": "O2" },
          // An editor still holding other.tex saves into the file the sync replaced,
          // which is now the kept copy.
          at: (point) =>
            point === "adopted"
              ? Effect.promise(async () => {
                  await held!.truncate(0);
                  await held!.write("newer work", 0, "utf8");
                })
              : Effect.void,
        });
        held = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.open(NodePath.join(w.folder, "other.tex"), "r+")),
          (handle) => Effect.promise(() => handle.close()),
        );
        yield* write(w.folder, { "a.tex": "B" });
        expect(yield* w.sync()).toMatchObject({
          publication: { _tag: "blocked", reason: "kept-copy-changed" },
        });
        expect(w.pushes).toHaveLength(0);
        expect((yield* w.connection).retention.copies).toMatchObject([
          { relativePath: "other.tex", state: "changed" },
        ]);
        expect(yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).toMatchObject([
          { relativePath: "other.tex", keptRevision: revision("newer work") },
        ]);
      }),
    );
  });

  it.live("sends the verified candidate, not an edit made after verification", () => {
    let folder = "";
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "A" },
          at: (point) =>
            point === "recorded"
              ? write(folder, { "main.tex": "edited after verifying" })
              : Effect.void,
        });
        folder = w.folder;
        yield* write(w.folder, { "main.tex": "A, edited here" });
        expect(yield* w.sync()).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": "A, edited here" });
        expect(yield* read(w.folder, "main.tex")).toBe("edited after verifying");
      }),
    );
  });

  it.live("keeps unresolved conflict material from being sent", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": marked, "other.tex": "O" },
          remote: { "main.tex": marked, "other.tex": "O" },
          markerPaths: ["main.tex"],
        });
        yield* write(w.folder, { "other.tex": "O, edited here" });
        expect(yield* w.sync()).toMatchObject({
          publication: { _tag: "blocked", reason: "markers" },
        });
        expect(w.pushes).toHaveLength(0);
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": marked, "other.tex": "O" });
      }),
    ),
  );

  it.live("settles a push whose record was lost by Overleaf's head, without sending again", () => {
    let crash = true;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "A" },
          // The push went through; the process dies before recording it.
          at: (point) =>
            crash && point === "sent" ? Effect.die(new Error("process died")) : Effect.void,
        });
        yield* write(w.folder, { "main.tex": "A, edited here" });
        const prepared = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (prepared._tag !== "review") return yield* Effect.die(prepared);
        const request = {
          connectionId: CONNECTION,
          requestId: "request-1",
          reviewId: prepared.review.id,
          digest: prepared.review.digest,
          acknowledgements: prepared.review.binding.acknowledgements,
        };
        expect(Exit.isFailure(yield* Effect.exit(w.coordinator.confirm(request)))).toBe(true);
        crash = false;
        expect((yield* w.connection).attempts).toMatchObject([{ outcome: "unknown" }]);
        expect(yield* w.coordinator.recover({ connectionId: CONNECTION })).toMatchObject({
          attempts: { accepted: [1], unresolved: [] },
        });
        const overleaf = yield* w.overleafNow;
        const after = yield* w.connection;
        expect(after.attempts).toMatchObject([
          { outcome: "accepted", evidence: "remote-head-tree" },
        ]);
        expect(after.base).toMatchObject({
          commit: after.attempts[0]!.candidateCommit,
          tree: overleaf.tree,
        });
        // Repeating the confirmation returns its receipt, left running by the crash;
        // it never sends again.
        expect(yield* w.coordinator.confirm(request)).toMatchObject({
          _tag: "duplicate",
          receipt: { status: "running" },
        });
        expect(w.pushes).toHaveLength(1);
      }),
    );
  });

  it.live("finds an accepted push in history after a collaborator reverted it", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "A" },
          // Sent, but the answer never arrived.
          push: (send) => Effect.as(send, { _tag: "unknown" as const, detail: "connection reset" }),
        });
        yield* write(w.folder, { "main.tex": "A, edited here" });
        expect(yield* w.sync()).toMatchObject({ publication: { _tag: "unknown" } });
        yield* w.collaborate({ "main.tex": "A" });
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        const after = yield* w.connection;
        expect(after.attempts).toMatchObject([{ outcome: "accepted", evidence: "remote-history" }]);
        expect(after.base.commit).toBe(after.attempts[0]!.candidateCommit);
        // The revert comes back as Overleaf's change, never sent again.
        expect(next.review.incoming.map((change) => change.kind)).toEqual(["modified"]);
        expect(next.review.binding.warnings).toEqual([]);
        expect(w.pushes).toHaveLength(1);
      }),
    ),
  );

  it.live("takes nothing from a rewritten history that only happens to hold the same tree", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "a.tex": "A" },
          remote: { "a.tex": "A" },
          push: () => Effect.succeed({ _tag: "unknown" as const, detail: "never sent" }),
        });
        yield* write(w.folder, { "a.tex": "B" });
        expect(yield* w.sync()).toMatchObject({ publication: { _tag: "unknown" } });
        const before = yield* w.connection;
        // Overleaf's history is replaced: one unrelated commit holds the candidate's tree,
        // but neither the recorded parent nor the candidate commit is in it.
        yield* w.rewriteHistory([{ "a.tex": "B" }, { "a.tex": "C" }]);
        expect(yield* w.coordinator.recover({ connectionId: CONNECTION })).toMatchObject({
          attempts: { accepted: [], unresolved: [1] },
        });
        const after = yield* w.connection;
        expect(after.attempts).toMatchObject([{ outcome: "unknown" }]);
        expect(after.base).toEqual(before.base);
      }),
    ),
  );

  it.live("leaves a send unknown without positive evidence, and the review says so", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "A" },
          // Nothing reached Overleaf, and nothing says so.
          push: () => Effect.succeed({ _tag: "unknown" as const, detail: "timed out" }),
        });
        yield* write(w.folder, { "main.tex": "A, edited here" });
        expect(yield* w.sync()).toMatchObject({
          publication: { _tag: "unknown", attemptNumber: 1 },
        });
        // Overleaf still holds the parent: that proves nothing either way.
        expect(yield* w.coordinator.recover({ connectionId: CONNECTION })).toMatchObject({
          attempts: { accepted: [], unresolved: [1] },
        });
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        const [attempt] = (yield* w.connection).attempts;
        expect(attempt).toMatchObject({ outcome: "unknown", evidence: null });
        expect(next.review.binding.warnings).toContainEqual({
          kind: "unresolved-publication",
          attemptNumber: 1,
          candidateCommit: attempt!.candidateCommit,
        });
        expect(next.review.binding.acknowledgements).toContain("unresolved-publication");
      }),
    ),
  );

  it.live("records an explicit out-of-date answer and keeps the base", () => {
    let collaborate: (() => Effect.Effect<void>) | undefined;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A", "other.tex": "O" },
          remote: { "main.tex": "A", "other.tex": "O" },
          // A collaborator pushes between the review's fetch and this send.
          at: (point) => (point === "recorded" && collaborate ? collaborate() : Effect.void),
        });
        collaborate = () =>
          Effect.orDie(Effect.asVoid(w.collaborate({ "main.tex": "A", "other.tex": "O2" })));
        yield* write(w.folder, { "main.tex": "A, edited here" });
        const before = yield* w.connection;
        expect(yield* w.sync()).toMatchObject({ publication: { _tag: "out-of-date" } });
        collaborate = undefined;
        const after = yield* w.connection;
        expect(after.attempts).toMatchObject([
          { outcome: "out-of-date", evidence: "push-out-of-date" },
        ]);
        // The base is the apply's, not the candidate.
        expect(after.base.generation).toBe(before.base.generation + 1);
        expect(after.base.commit).not.toBe(after.attempts[0]!.candidateCommit);
        expect(w.pushes).toHaveLength(1);
        // A new review brings the collaborator's change and sends the edit again only on confirmation.
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        expect(next.review.incoming.length).toBe(1);
        expect(next.review.outgoing.length).toBe(1);
        expect(w.pushes).toHaveLength(1);
      }),
    );
  });

  it.live("supersedes an unknown send; its late acceptance never moves the newer base", () => {
    let report = true;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A", "other.tex": "O" },
          remote: { "main.tex": "A", "other.tex": "O" },
          push: (send) =>
            report ? Effect.succeed({ _tag: "unknown" as const, detail: "timed out" }) : send,
        });
        yield* write(w.folder, { "main.tex": "A, edited here" });
        expect(yield* w.sync()).toMatchObject({ publication: { _tag: "unknown" } });
        const [first] = (yield* w.connection).attempts;
        // A collaborator's change, then an acknowledged sync bringing it in.
        yield* w.collaborate({ "main.tex": "A", "other.tex": "O2" });
        report = false;
        expect(yield* w.sync("request-2")).toMatchObject({
          publication: { _tag: "accepted", attemptNumber: 2 },
        });
        const later = yield* w.connection;
        expect(later.attempts).toMatchObject([
          { attemptNumber: 1, outcome: "superseded-unresolved" },
          { attemptNumber: 2, outcome: "accepted" },
        ]);
        // Evidence for the first send arrives late: Overleaf now holds its exact tree.
        yield* w.collaborate({ "main.tex": "A, edited here", "other.tex": "O" });
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        const after = yield* w.connection;
        expect(after.attempts[0]).toMatchObject({
          outcome: "accepted",
          evidence: "remote-head-tree",
        });
        expect(after.base).toEqual(later.base);
        expect(first!.candidateCommit).not.toBe(after.base.commit);
        expect(w.pushes).toHaveLength(2);
      }),
    );
  });

  it.live("records a send refused when the credential changed since the review", () => {
    let epoch = 0;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "A" },
          remote: { "main.tex": "A" },
          credentialEpoch: () => epoch,
          at: (point) =>
            point === "adopted"
              ? Effect.sync(() => {
                  epoch = 1;
                })
              : Effect.void,
        });
        yield* write(w.folder, { "main.tex": "A, edited here" });
        expect(yield* w.sync()).toMatchObject({
          publication: { _tag: "not-sent", attemptNumber: 1 },
        });
        expect((yield* w.connection).attempts).toMatchObject([
          { outcome: "not-sent", evidence: "send-refused" },
        ]);
        expect(w.pushes).toHaveLength(0);
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": "A" });
      }),
    );
  });

  it.live("refuses a sync with changes to send once sixteen sends are unresolved", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "A" }, remote: { "main.tex": "A" } });
        const current = yield* w.connection;
        yield* w.store.replaceConnection({
          expectedRevision: current.revision,
          next: {
            ...current,
            revision: current.revision + 1,
            lastAttemptNumber: 16,
            attempts: Array.from({ length: 16 }, (_, n) => ({
              attemptNumber: n + 1,
              operationId: `operation-${n}`,
              requestId: `request-${n}`,
              planDigest: "0".repeat(64),
              authority: current.binding,
              branch: "main" as const,
              parentCommit: current.base.commit!,
              // Sends no evidence will settle: candidates Overleaf never had.
              candidateCommit: (n + 1).toString(16).padStart(40, "a"),
              candidateTree: (n + 1).toString(16).padStart(40, "b"),
              baseGeneration: current.base.generation,
              outcome: "unknown" as const,
              evidence: null,
              recordedAt: "2026-10-23T12:00:00.000Z",
            })),
            updatedAt: "2026-10-23T12:00:00.000Z",
          },
        });
        yield* write(w.folder, { "main.tex": "A, edited here" });
        const prepared = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (prepared._tag !== "review") return yield* Effect.die(prepared);
        const refused = yield* Effect.flip(
          w.coordinator.confirm({
            connectionId: CONNECTION,
            requestId: "request-1",
            reviewId: prepared.review.id,
            digest: prepared.review.digest,
            acknowledgements: prepared.review.binding.acknowledgements,
          }),
        );
        expect(refused).toMatchObject({
          _tag: "OverleafRetainedLimitError",
          limit: "attempts",
        });
        expect((yield* w.connection).activeApply).toBeNull();
        expect(w.pushes).toHaveLength(0);
      }),
    ),
  );
});
