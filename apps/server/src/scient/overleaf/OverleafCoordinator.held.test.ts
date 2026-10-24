// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * Holding back only a file with conflict marks (design section 4.2, engine
 * addition 1), against a real local bare repository standing in for Overleaf:
 * the marked file keeps Overleaf's version, at Overleaf's paths, until its marks
 * are gone; everything else is sent.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { OverleafCoordinator } from "./OverleafCoordinator.ts";
import { CONNECTION, canApply, read, run, world, write } from "./OverleafCoordinator.testkit.ts";
import { type ConflictChoice, hasConflictMarkers } from "./syncRules.ts";

/** A long file with one line that differs, so renames are recognized by content. */
const doc = (line: string) =>
  `${[
    "\\section{Introduction}",
    ...Array.from({ length: 30 }, (_, n) => `Shared opening sentence ${n} of the paper.`),
    line,
    ...Array.from({ length: 30 }, (_, n) => `Shared closing sentence ${n} of the paper.`),
    "\\end{document}",
  ].join("\n")}\n`;

type World = Effect.Success<ReturnType<typeof world>>;

/** Prepares, chooses `choice` for every conflict, and confirms the review as offered. */
const syncChoosing = (
  coordinator: OverleafCoordinator["Service"],
  choice: ConflictChoice,
  options: { readonly requestId?: string; readonly select?: ReadonlyArray<string> } = {},
) =>
  Effect.gen(function* () {
    const selections = (choices: ReadonlyMap<string, ConflictChoice>) => ({
      selectedAdditions: options.select ?? [],
      collisionPaths: [],
      choices,
    });
    const open = yield* coordinator.prepare({
      connectionId: CONNECTION,
      selections: selections(new Map()),
    });
    if (open._tag !== "review") return yield* Effect.die(open);
    const prepared = yield* coordinator.prepare({
      connectionId: CONNECTION,
      selections: selections(
        new Map(open.review.conflicts.map((conflict) => [conflict.key, choice])),
      ),
    });
    if (prepared._tag !== "review") return yield* Effect.die(prepared);
    const result = yield* coordinator.confirm({
      connectionId: CONNECTION,
      requestId: options.requestId ?? "request-1",
      reviewId: prepared.review.id,
      digest: prepared.review.digest,
      acknowledgements: prepared.review.binding.acknowledgements,
    });
    return { conflicts: open.review.conflicts, review: prepared.review, result };
  });

const marked = (w: World, path: string) =>
  Effect.map(read(w.folder, path), (text) => text !== null && hasConflictMarkers(text));

/**
 * The first sync of each case: main.tex conflicts and is merged in the editor
 * (conflict marks written), while other.tex has an edit to send.
 */
const heldWorld = (at?: Parameters<typeof world>[0]["at"]) =>
  Effect.gen(function* () {
    const w = yield* world({
      overleaf: "git",
      synced: { "main.tex": doc("one"), "other.tex": "O" },
      remote: { "main.tex": doc("theirs"), "other.tex": "O" },
      ...(at ? { at } : {}),
    });
    yield* write(w.folder, { "main.tex": doc("mine"), "other.tex": "O, edited here" });
    return w;
  });

// Each case runs three or four real syncs, each with its own fetch, apply and push.
const SEVERAL_SYNCS = { timeout: 600_000 };

describe.skipIf(!canApply)(
  "OverleafCoordinator, holding back a file with conflict marks",
  SEVERAL_SYNCS,
  () => {
    it.live("sends everything but the marked file, across syncs, until its marks are gone", () =>
      run(
        Effect.gen(function* () {
          const w = yield* heldWorld();
          const first = yield* syncChoosing(w.coordinator, "markers");
          expect(first.review.binding.markerPaths).toEqual(["main.tex"]);
          expect(first.review.binding.heldPaths).toEqual(["main.tex"]);
          expect(first.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
          expect(first.result).toMatchObject({
            _tag: "applied",
            adopted: { outcome: "attention", markerPaths: ["main.tex"] },
            publication: { _tag: "accepted", attemptNumber: 1 },
          });
          expect(yield* marked(w, "main.tex")).toBe(true);
          let overleaf = yield* w.overleafNow;
          expect(overleaf.contents).toEqual({
            "main.tex": doc("theirs"),
            "other.tex": "O, edited here",
          });
          let connection = yield* w.connection;
          expect(connection.markers).toEqual([{ path: "main.tex", overleafPaths: ["main.tex"] }]);
          // The base is what was sent: Overleaf's version of the held file.
          expect(connection.base.tree).toBe(overleaf.tree);
          expect(connection.attempts[0]).toMatchObject({
            outcome: "accepted",
            candidateTree: overleaf.tree,
          });

          // Carried over: the file stays held while it has marks; Overleaf's change to
          // another file comes in, and an edit goes out.
          yield* w.collaborate({
            "main.tex": doc("theirs"),
            "other.tex": "O, edited here",
            "new.tex": "N",
          });
          yield* write(w.folder, { "other.tex": "O, edited twice" });
          const carried = yield* w.coordinator.prepare({ connectionId: CONNECTION });
          if (carried._tag !== "review") return yield* Effect.die(carried);
          expect(carried.review.unresolvedMarkers).toEqual(["main.tex"]);
          expect(carried.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
          expect(yield* w.sync("request-2")).toMatchObject({
            adopted: { outcome: "complete" },
            publication: { _tag: "accepted", attemptNumber: 2 },
          });
          expect((yield* w.overleafNow).contents).toEqual({
            "main.tex": doc("theirs"),
            "other.tex": "O, edited twice",
            "new.tex": "N",
          });
          expect(yield* read(w.folder, "new.tex")).toBe("N");
          expect((yield* w.connection).markers).toEqual([
            { path: "main.tex", overleafPaths: ["main.tex"] },
          ]);

          // Settled: the user's merge goes out, and nothing is held any more.
          yield* write(w.folder, { "main.tex": doc("merged") });
          expect(yield* w.sync("request-3")).toMatchObject({
            publication: { _tag: "accepted", attemptNumber: 3 },
          });
          overleaf = yield* w.overleafNow;
          expect(overleaf.contents["main.tex"]).toBe(doc("merged"));
          connection = yield* w.connection;
          expect(connection.markers).toEqual([]);
          expect(connection.base.tree).toBe(overleaf.tree);
          expect(w.pushes).toHaveLength(3);
        }),
      ),
    );

    it.live("sends a Markdown file with ======= lines beside a held file", () =>
      run(
        Effect.gen(function* () {
          const w = yield* world({
            overleaf: "git",
            synced: { "main.tex": doc("one"), "notes.md": "Notes\n" },
            remote: { "main.tex": doc("theirs"), "notes.md": "Notes\n" },
          });
          const heading = "Results\n=======\n\nAll good.\n";
          yield* write(w.folder, { "main.tex": doc("mine"), "notes.md": heading });
          const first = yield* syncChoosing(w.coordinator, "markers");
          expect(first.review.binding.heldPaths).toEqual(["main.tex"]);
          expect(first.result).toMatchObject({ publication: { _tag: "accepted" } });
          expect((yield* w.overleafNow).contents).toEqual({
            "main.tex": doc("theirs"),
            "notes.md": heading,
          });
          // Only the file Scient wrote marks into is recorded.
          expect((yield* w.connection).markers).toEqual([
            { path: "main.tex", overleafPaths: ["main.tex"] },
          ]);
        }),
      ),
    );

    it.live(
      "keeps Overleaf's name for a marked file renamed in the folder, then sends the rename",
      () =>
        run(
          Effect.gen(function* () {
            const w = yield* heldWorld();
            yield* syncChoosing(w.coordinator, "markers");
            yield* Effect.promise(() =>
              NodeFSP.rename(
                NodePath.join(w.folder, "main.tex"),
                NodePath.join(w.folder, "chapter.tex"),
              ),
            );
            yield* write(w.folder, { "other.tex": "O, again" });
            const renamed = yield* syncChoosing(w.coordinator, "mine", {
              requestId: "request-2",
              select: ["chapter.tex"],
            });
            expect(renamed.review.binding.heldPaths).toEqual(["chapter.tex", "main.tex"]);
            // Overleaf sees neither the rename nor the marks.
            expect(renamed.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
            expect(renamed.review.binding.warnings).toEqual([]);
            expect(renamed.result).toMatchObject({ publication: { _tag: "accepted" } });
            expect((yield* w.overleafNow).contents).toEqual({
              "main.tex": doc("theirs"),
              "other.tex": "O, again",
            });
            expect((yield* w.connection).markers).toEqual([
              { path: "chapter.tex", overleafPaths: ["main.tex"] },
            ]);
            expect(yield* marked(w, "chapter.tex")).toBe(true);
            expect(yield* read(w.folder, "main.tex")).toBeNull();

            // Settled: the rename and the merge reach Overleaf together.
            yield* write(w.folder, { "chapter.tex": doc("merged") });
            const settled = yield* w.coordinator.prepare({ connectionId: CONNECTION });
            if (settled._tag !== "review") return yield* Effect.die(settled);
            expect(settled.review.binding.heldPaths).toEqual([]);
            expect(settled.review.outgoing).toEqual([
              { kind: "renamed", from: "main.tex", to: "chapter.tex" },
            ]);
            expect(yield* w.sync("request-3")).toMatchObject({ publication: { _tag: "accepted" } });
            expect((yield* w.overleafNow).contents).toEqual({
              "chapter.tex": doc("merged"),
              "other.tex": "O, again",
            });
            expect((yield* w.connection).markers).toEqual([]);
          }),
        ),
    );

    it.live("follows a marked file Overleaf renamed, keeping Overleaf's file as it is", () =>
      run(
        Effect.gen(function* () {
          const w = yield* heldWorld();
          yield* syncChoosing(w.coordinator, "markers");
          yield* w.collaborate({ "chapter.tex": doc("theirs"), "other.tex": "O, edited here" });
          yield* write(w.folder, { "other.tex": "O, again" });
          const followed = yield* syncChoosing(w.coordinator, "mine", { requestId: "request-2" });
          expect(followed.conflicts).toEqual([]);
          expect(followed.review.binding.heldPaths).toEqual(["chapter.tex", "main.tex"]);
          expect(followed.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
          expect(followed.result).toMatchObject({ publication: { _tag: "accepted" } });
          // The marked file moved with Overleaf's rename.
          expect(yield* marked(w, "chapter.tex")).toBe(true);
          expect(yield* read(w.folder, "main.tex")).toBeNull();
          expect((yield* w.overleafNow).contents).toEqual({
            "chapter.tex": doc("theirs"),
            "other.tex": "O, again",
          });
          expect((yield* w.connection).markers).toEqual([
            { path: "chapter.tex", overleafPaths: ["chapter.tex"] },
          ]);

          yield* write(w.folder, { "chapter.tex": doc("merged") });
          expect(yield* w.sync("request-3")).toMatchObject({ publication: { _tag: "accepted" } });
          expect((yield* w.overleafNow).contents).toEqual({
            "chapter.tex": doc("merged"),
            "other.tex": "O, again",
          });
          expect((yield* w.connection).markers).toEqual([]);
        }),
      ),
    );

    it.live("keeps Overleaf's name for a marked file renamed on both sides", () =>
      run(
        Effect.gen(function* () {
          const w = yield* heldWorld();
          yield* syncChoosing(w.coordinator, "markers");
          yield* Effect.promise(() =>
            NodeFSP.rename(
              NodePath.join(w.folder, "main.tex"),
              NodePath.join(w.folder, "mine.tex"),
            ),
          );
          yield* w.collaborate({ "theirs.tex": doc("theirs"), "other.tex": "O, edited here" });
          yield* write(w.folder, { "other.tex": "O, again" });
          const both = yield* syncChoosing(w.coordinator, "mine", {
            requestId: "request-2",
            select: ["mine.tex"],
          });
          expect(both.conflicts.map((conflict) => conflict.paths)).toEqual([
            ["main.tex", "mine.tex", "theirs.tex"],
          ]);
          expect(both.review.binding.heldPaths).toEqual(["main.tex", "mine.tex", "theirs.tex"]);
          expect(both.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
          expect(both.result).toMatchObject({ publication: { _tag: "accepted" } });
          expect((yield* w.overleafNow).contents).toEqual({
            "theirs.tex": doc("theirs"),
            "other.tex": "O, again",
          });
          expect(yield* marked(w, "mine.tex")).toBe(true);
          expect(yield* read(w.folder, "theirs.tex")).toBeNull();
          expect((yield* w.connection).markers).toEqual([
            { path: "mine.tex", overleafPaths: ["theirs.tex"] },
          ]);

          yield* write(w.folder, { "mine.tex": doc("merged") });
          expect(yield* w.sync("request-3")).toMatchObject({ publication: { _tag: "accepted" } });
          expect((yield* w.overleafNow).contents).toEqual({
            "mine.tex": doc("merged"),
            "other.tex": "O, again",
          });
          expect((yield* w.connection).markers).toEqual([]);
        }),
      ),
    );

    it.live("keeps a marked file Overleaf deleted off Overleaf until its marks are gone", () =>
      run(
        Effect.gen(function* () {
          const w = yield* heldWorld();
          yield* syncChoosing(w.coordinator, "markers");
          yield* w.collaborate({ "other.tex": "O, edited here" });
          yield* write(w.folder, { "other.tex": "O, again" });
          const kept = yield* syncChoosing(w.coordinator, "mine", { requestId: "request-2" });
          expect(kept.conflicts.map((conflict) => conflict.paths)).toEqual([["main.tex"]]);
          expect(kept.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
          expect(kept.result).toMatchObject({ publication: { _tag: "accepted" } });
          expect((yield* w.overleafNow).contents).toEqual({ "other.tex": "O, again" });
          expect(yield* marked(w, "main.tex")).toBe(true);
          expect((yield* w.connection).markers).toEqual([{ path: "main.tex", overleafPaths: [] }]);

          // Still held at the next sync, though Overleaf has no such file to keep.
          yield* write(w.folder, { "other.tex": "O, third" });
          const later = yield* w.coordinator.prepare({ connectionId: CONNECTION });
          if (later._tag !== "review") return yield* Effect.die(later);
          expect(later.review.binding.heldPaths).toEqual(["main.tex"]);
          expect(later.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
          expect(yield* w.sync("request-3")).toMatchObject({ publication: { _tag: "accepted" } });
          expect((yield* w.overleafNow).contents).toEqual({ "other.tex": "O, third" });

          yield* write(w.folder, { "main.tex": doc("merged") });
          expect(yield* w.sync("request-4")).toMatchObject({ publication: { _tag: "accepted" } });
          expect((yield* w.overleafNow).contents).toEqual({
            "main.tex": doc("merged"),
            "other.tex": "O, third",
          });
          expect((yield* w.connection).markers).toEqual([]);
        }),
      ),
    );

    it.live("sends the rest after a restart between the apply and the send", () => {
      let crash = true;
      return run(
        Effect.gen(function* () {
          // The process dies once the apply is adopted, before anything is recorded to send.
          const w = yield* heldWorld((point) =>
            crash && point === "adopted" ? Effect.die(new Error("process died")) : Effect.void,
          );
          expect(Exit.isFailure(yield* Effect.exit(syncChoosing(w.coordinator, "markers")))).toBe(
            true,
          );
          crash = false;
          const adopted = yield* w.connection;
          expect(adopted.activeApply).toBeNull();
          expect(adopted.attempts).toEqual([]);
          expect(adopted.markers).toEqual([{ path: "main.tex", overleafPaths: ["main.tex"] }]);
          expect(w.pushes).toHaveLength(0);
          // A new server process: nothing in memory survives, the record does.
          const restarted = yield* w.coordinatorWith(w.store);
          const next = yield* syncChoosing(restarted, "mine", { requestId: "request-2" });
          expect(next.review.unresolvedMarkers).toEqual(["main.tex"]);
          expect(next.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
          expect(next.result).toMatchObject({ publication: { _tag: "accepted" } });
          expect((yield* w.overleafNow).contents).toEqual({
            "main.tex": doc("theirs"),
            "other.tex": "O, edited here",
          });
          expect((yield* w.connection).markers).toEqual([
            { path: "main.tex", overleafPaths: ["main.tex"] },
          ]);
        }),
      );
    });

    it.live("keeps the marks recorded through recovery of an interrupted apply", () => {
      let crash = true;
      return run(
        Effect.gen(function* () {
          // The process dies after the applier ran, before its result was adopted.
          const w = yield* heldWorld((point) =>
            crash && point === "applied" ? Effect.die(new Error("process died")) : Effect.void,
          );
          expect(Exit.isFailure(yield* Effect.exit(syncChoosing(w.coordinator, "markers")))).toBe(
            true,
          );
          crash = false;
          expect((yield* w.connection).activeApply).not.toBeNull();
          const restarted = yield* w.coordinatorWith(w.store);
          expect(yield* restarted.recover({ connectionId: CONNECTION })).toMatchObject({
            _tag: "recovered",
            adopted: { outcome: "attention", markerPaths: ["main.tex"] },
          });
          expect((yield* w.connection).markers).toEqual([
            { path: "main.tex", overleafPaths: ["main.tex"] },
          ]);
          const next = yield* syncChoosing(restarted, "mine", { requestId: "request-2" });
          expect(next.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
          expect(next.result).toMatchObject({ publication: { _tag: "accepted" } });
          expect((yield* w.overleafNow).contents).toEqual({
            "main.tex": doc("theirs"),
            "other.tex": "O, edited here",
          });
        }),
      );
    });

    it.live("blocks the send when a unit was not done, even with only marks to report", () =>
      run(
        Effect.gen(function* () {
          const w = yield* world({
            overleaf: "git",
            synced: { "main.tex": doc("one"), "other.tex": "O" },
            remote: { "main.tex": doc("theirs"), "other.tex": "O" },
            applier: (real) => ({
              apply: (input) =>
                Effect.map(real.apply(input), (result) => ({ ...result, unitsDone: false })),
            }),
          });
          yield* write(w.folder, { "main.tex": doc("mine"), "other.tex": "O, edited here" });
          const first = yield* syncChoosing(w.coordinator, "markers");
          expect(first.result).toMatchObject({
            publication: { _tag: "blocked", reason: "attention" },
          });
          expect(w.pushes).toHaveLength(0);
        }),
      ),
    );

    it.live("still verifies every other file while one is held", () => {
      let folder = "";
      return run(
        Effect.gen(function* () {
          // Another file changes after the apply: the next review sends it.
          const w = yield* heldWorld((point) =>
            point === "adopted"
              ? write(folder, { "other.tex": "edited after the apply" })
              : Effect.void,
          );
          folder = w.folder;
          const first = yield* syncChoosing(w.coordinator, "markers");
          expect(first.result).toMatchObject({ publication: { _tag: "not-verified" } });
          expect(w.pushes).toHaveLength(0);
        }),
      );
    });

    it.live("does not compare a held file at verification: it is work in progress", () => {
      let folder = "";
      return run(
        Effect.gen(function* () {
          // The user starts settling the marks right after the apply.
          const w = yield* heldWorld((point) =>
            point === "adopted" ? write(folder, { "main.tex": doc("half merged") }) : Effect.void,
          );
          folder = w.folder;
          const first = yield* syncChoosing(w.coordinator, "markers");
          expect(first.result).toMatchObject({ publication: { _tag: "accepted" } });
          expect((yield* w.overleafNow).contents).toEqual({
            "main.tex": doc("theirs"),
            "other.tex": "O, edited here",
          });
          expect(yield* read(w.folder, "main.tex")).toBe(doc("half merged"));
        }),
      );
    });
  },
);
