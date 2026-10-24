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
import { overleafConflictKey } from "./OverleafReview.ts";
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

/**
 * Prepares, chooses `choice` for every conflict, and confirms the review as offered.
 * Conflicts `known` in advance are chosen by key in the first review.
 */
const syncChoosing = (
  coordinator: OverleafCoordinator["Service"],
  choice: ConflictChoice,
  options: {
    readonly requestId?: string;
    readonly select?: ReadonlyArray<string>;
    readonly known?: ReadonlyArray<ReadonlyArray<string>>;
  } = {},
) =>
  Effect.gen(function* () {
    const selections = (choices: ReadonlyMap<string, ConflictChoice>) => ({
      selectedAdditions: options.select ?? [],
      collisionPaths: [],
      choices,
    });
    const open = yield* coordinator.prepare({
      connectionId: CONNECTION,
      selections: selections(
        new Map((options.known ?? []).map((paths) => [overleafConflictKey(paths), choice])),
      ),
    });
    if (open._tag !== "review") return yield* Effect.die(open);
    const prepared = open.review.conflicts.every((conflict) => conflict.chosen !== null)
      ? open
      : yield* coordinator.prepare({
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

/** With the scripted Overleaf: the files of the last commit sent. */
const lastSent = (w: World) =>
  Effect.gen(function* () {
    const tree = yield* w.repos.treeOf({ repo: w.repo, commit: w.pushes.at(-1)! });
    const contents: Record<string, string> = {};
    for (const entry of yield* w.repos.readTree({ repo: w.repo, tree }))
      contents[entry.path] = new TextDecoder().decode(
        yield* w.repos.readBlob({ repo: w.repo, oid: entry.oid, maxBytes: 1024 * 1024 }),
      );
    return contents;
  });

/**
 * main.tex already recorded with Scient's marks, Overleaf's version in the base,
 * other.tex edited, and an Overleaf that will next hold `remote`.
 */
const recordedWorld = (remote: Record<string, string>) =>
  Effect.gen(function* () {
    const w = yield* world({
      overleaf: "git",
      synced: { "main.tex": doc("theirs"), "other.tex": "O" },
      remote,
      markerPaths: ["main.tex"],
    });
    yield* write(w.folder, { "main.tex": scientMarks, "other.tex": "O, again" });
    return w;
  });

/** The first sync's conflict, on main.tex, chosen up front. */
const MAIN = { known: [["main.tex"]] };

/** Conflict marks as Scient's merge writes them, inside a long file. */
const scientMarks = doc("<<<<<<< Scient\nmine\n=======\ntheirs\n>>>>>>> Overleaf");

/**
 * The first sync of each case: main.tex conflicts and is merged in the editor
 * (conflict marks written), while other.tex has an edit to send.
 */
const heldWorld = (at?: Parameters<typeof world>[0]["at"], overleaf: "git" | "scripted" = "git") =>
  Effect.gen(function* () {
    const w = yield* world({
      overleaf,
      synced: { "main.tex": doc("one"), "other.tex": "O" },
      remote: { "main.tex": doc("theirs"), "other.tex": "O" },
      ...(at ? { at } : {}),
    });
    yield* write(w.folder, { "main.tex": doc("mine"), "other.tex": "O, edited here" });
    return w;
  });

describe.skipIf(!canApply)("OverleafCoordinator, holding back a file with conflict marks", () => {
  it.live("sends everything but the marked file, across syncs, until its marks are gone", () =>
    run(
      Effect.gen(function* () {
        const w = yield* heldWorld();
        const first = yield* syncChoosing(w.coordinator, "markers", MAIN);
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
        expect(connection.markers).toEqual([
          { path: "main.tex", folderPaths: [], overleafPaths: ["main.tex"] },
        ]);
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
        const carried = yield* syncChoosing(w.coordinator, "mine", { requestId: "request-2" });
        expect(carried.review.unresolvedMarkers).toEqual(["main.tex"]);
        expect(carried.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
        expect(carried.result).toMatchObject({
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
          { path: "main.tex", folderPaths: [], overleafPaths: ["main.tex"] },
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
        const first = yield* syncChoosing(w.coordinator, "markers", MAIN);
        expect(first.review.binding.heldPaths).toEqual(["main.tex"]);
        expect(first.result).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({
          "main.tex": doc("theirs"),
          "notes.md": heading,
        });
        // Only the file Scient wrote marks into is recorded.
        expect((yield* w.connection).markers).toEqual([
          { path: "main.tex", folderPaths: [], overleafPaths: ["main.tex"] },
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
          yield* syncChoosing(w.coordinator, "markers", MAIN);
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
            { path: "chapter.tex", folderPaths: [], overleafPaths: ["main.tex"] },
          ]);
          expect(yield* marked(w, "chapter.tex")).toBe(true);
          expect(yield* read(w.folder, "main.tex")).toBeNull();

          // Settled: the rename and the merge reach Overleaf together.
          yield* write(w.folder, { "chapter.tex": doc("merged") });
          const settled = yield* syncChoosing(w.coordinator, "mine", { requestId: "request-3" });
          expect(settled.review.binding.heldPaths).toEqual([]);
          expect(settled.review.outgoing).toEqual([
            { kind: "renamed", from: "main.tex", to: "chapter.tex" },
          ]);
          expect(settled.result).toMatchObject({ publication: { _tag: "accepted" } });
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
        const w = yield* recordedWorld({ "chapter.tex": doc("theirs"), "other.tex": "O" });
        const followed = yield* syncChoosing(w.coordinator, "mine");
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
          { path: "chapter.tex", folderPaths: [], overleafPaths: ["chapter.tex"] },
        ]);

        yield* write(w.folder, { "chapter.tex": doc("merged") });
        expect(yield* w.sync("request-2")).toMatchObject({ publication: { _tag: "accepted" } });
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
        const w = yield* recordedWorld({ "theirs.tex": doc("theirs"), "other.tex": "O" });
        yield* Effect.promise(() =>
          NodeFSP.rename(NodePath.join(w.folder, "main.tex"), NodePath.join(w.folder, "mine.tex")),
        );
        const both = yield* syncChoosing(w.coordinator, "mine", {
          select: ["mine.tex"],
          known: [["main.tex", "mine.tex", "theirs.tex"]],
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
          { path: "mine.tex", folderPaths: [], overleafPaths: ["theirs.tex"] },
        ]);

        yield* write(w.folder, { "mine.tex": doc("merged") });
        expect(yield* w.sync("request-2")).toMatchObject({ publication: { _tag: "accepted" } });
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
        const w = yield* recordedWorld({ "other.tex": "O" });
        const kept = yield* syncChoosing(w.coordinator, "mine", MAIN);
        expect(kept.conflicts.map((conflict) => conflict.paths)).toEqual([["main.tex"]]);
        expect(kept.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
        expect(kept.result).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({ "other.tex": "O, again" });
        expect(yield* marked(w, "main.tex")).toBe(true);
        expect((yield* w.connection).markers).toEqual([
          { path: "main.tex", folderPaths: [], overleafPaths: [] },
        ]);

        // Still held at the next sync, though Overleaf has no such file to keep.
        yield* write(w.folder, { "other.tex": "O, third" });
        const later = yield* syncChoosing(w.coordinator, "mine", { requestId: "request-2" });
        expect(later.review.binding.heldPaths).toEqual(["main.tex"]);
        expect(later.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
        expect(later.result).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({ "other.tex": "O, third" });

        yield* write(w.folder, { "main.tex": doc("merged") });
        expect(yield* w.sync("request-3")).toMatchObject({ publication: { _tag: "accepted" } });
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
        const w = yield* heldWorld(
          (point) =>
            crash && point === "adopted" ? Effect.die(new Error("process died")) : Effect.void,
          "scripted",
        );
        expect(
          Exit.isFailure(yield* Effect.exit(syncChoosing(w.coordinator, "markers", MAIN))),
        ).toBe(true);
        crash = false;
        const adopted = yield* w.connection;
        expect(adopted.activeApply).toBeNull();
        expect(adopted.attempts).toEqual([]);
        expect(adopted.markers).toEqual([
          { path: "main.tex", folderPaths: [], overleafPaths: ["main.tex"] },
        ]);
        expect(w.pushes).toHaveLength(0);
        // A new server process: nothing in memory survives, the record does.
        const restarted = yield* w.coordinatorWith(w.store);
        const next = yield* syncChoosing(restarted, "mine", { requestId: "request-2" });
        expect(next.review.unresolvedMarkers).toEqual(["main.tex"]);
        expect(next.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
        expect(next.result).toMatchObject({ publication: { _tag: "accepted" } });
        expect(yield* lastSent(w)).toEqual({
          "main.tex": doc("theirs"),
          "other.tex": "O, edited here",
        });
        expect((yield* w.connection).markers).toEqual([
          { path: "main.tex", folderPaths: [], overleafPaths: ["main.tex"] },
        ]);
      }),
    );
  });

  it.live("keeps the marks recorded through recovery of an interrupted apply", () => {
    let crash = true;
    return run(
      Effect.gen(function* () {
        // The process dies after the applier ran, before its result was adopted.
        const w = yield* heldWorld(
          (point) =>
            crash && point === "applied" ? Effect.die(new Error("process died")) : Effect.void,
          "scripted",
        );
        expect(
          Exit.isFailure(yield* Effect.exit(syncChoosing(w.coordinator, "markers", MAIN))),
        ).toBe(true);
        crash = false;
        expect((yield* w.connection).activeApply).not.toBeNull();
        const restarted = yield* w.coordinatorWith(w.store);
        expect(yield* restarted.recover({ connectionId: CONNECTION })).toMatchObject({
          _tag: "recovered",
          adopted: { outcome: "attention", markerPaths: ["main.tex"] },
        });
        expect((yield* w.connection).markers).toEqual([
          { path: "main.tex", folderPaths: [], overleafPaths: ["main.tex"] },
        ]);
        const next = yield* syncChoosing(restarted, "mine", { requestId: "request-2" });
        expect(next.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
        expect(next.result).toMatchObject({ publication: { _tag: "accepted" } });
        expect(yield* lastSent(w)).toEqual({
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
          synced: { "main.tex": doc("one"), "other.tex": "O" },
          remote: { "main.tex": doc("theirs"), "other.tex": "O" },
          applier: (real) => ({
            apply: (input) =>
              Effect.map(real.apply(input), (result) => ({ ...result, unitsDone: false })),
          }),
        });
        yield* write(w.folder, { "main.tex": doc("mine"), "other.tex": "O, edited here" });
        const first = yield* syncChoosing(w.coordinator, "markers", MAIN);
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
        const w = yield* heldWorld(
          (point) =>
            point === "adopted"
              ? write(folder, { "other.tex": "edited after the apply" })
              : Effect.void,
          "scripted",
        );
        folder = w.folder;
        const first = yield* syncChoosing(w.coordinator, "markers", MAIN);
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
        const w = yield* heldWorld(
          (point) =>
            point === "adopted" ? write(folder, { "main.tex": doc("half merged") }) : Effect.void,
          "scripted",
        );
        folder = w.folder;
        const first = yield* syncChoosing(w.coordinator, "markers", MAIN);
        expect(first.result).toMatchObject({ publication: { _tag: "accepted" } });
        expect(yield* lastSent(w)).toEqual({
          "main.tex": doc("theirs"),
          "other.tex": "O, edited here",
        });
        expect(yield* read(w.folder, "main.tex")).toBe(doc("half merged"));
      }),
    );
  });

  it.live("keeps a file held where an unfinished rename left it", () => {
    let race = true;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "old.tex": doc("theirs"), "other.tex": "O" },
          // Overleaf renamed the file while it had marks in the folder.
          remote: { "new.tex": doc("theirs"), "other.tex": "O" },
          markerPaths: ["old.tex"],
          // A late edit to old.tex as the rename is about to happen: the unit is skipped.
          native: async (point, folder) => {
            if (point !== "prepared" || !race) return;
            race = false;
            await NodeFSP.appendFile(NodePath.join(folder, "old.tex"), "late local edit\n");
          },
        });
        yield* write(w.folder, { "old.tex": scientMarks, "other.tex": "O2" });
        const first = yield* syncChoosing(w.coordinator, "mine");
        expect(first.result).toMatchObject({
          publication: { _tag: "blocked", reason: "attention" },
        });
        expect(yield* marked(w, "old.tex")).toBe(true);
        // The record names where the file should be and where it still is.
        expect((yield* w.connection).markers).toEqual([
          { path: "new.tex", folderPaths: ["old.tex"], overleafPaths: ["new.tex"] },
        ]);
        const second = yield* syncChoosing(w.coordinator, "mine", { requestId: "request-2" });
        expect(second.review.binding.heldPaths).toEqual(["new.tex", "old.tex"]);
        expect(second.result).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({
          "new.tex": doc("theirs"),
          "other.tex": "O2",
        });
      }),
    );
  });

  it.live("holds a marked file renamed after Overleaf deleted it, found by its marks", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": doc("theirs"), "other.tex": "O" },
          remote: { "other.tex": "O" },
          markerPaths: ["main.tex"],
        });
        yield* write(w.folder, { "main.tex": scientMarks, "other.tex": "O2" });
        // Overleaf's deletion and the folder's marked file: keep mine.
        yield* syncChoosing(w.coordinator, "mine");
        expect((yield* w.connection).markers).toEqual([
          { path: "main.tex", folderPaths: [], overleafPaths: [] },
        ]);
        // The base has no main.tex, so Git sees no rename: renamed and edited at once.
        yield* Effect.promise(async () => {
          await NodeFSP.rename(
            NodePath.join(w.folder, "main.tex"),
            NodePath.join(w.folder, "renamed.tex"),
          );
          await NodeFSP.appendFile(NodePath.join(w.folder, "renamed.tex"), "more\n");
        });
        yield* write(w.folder, { "other.tex": "O3" });
        const second = yield* syncChoosing(w.coordinator, "mine", {
          requestId: "request-2",
          select: ["renamed.tex"],
        });
        expect(second.review.binding.heldPaths).toEqual(["main.tex", "renamed.tex"]);
        expect(second.review.outgoing).toEqual([{ kind: "modified", path: "other.tex" }]);
        expect(second.result).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({ "other.tex": "O3" });
        expect((yield* w.connection).markers).toEqual([
          { path: "renamed.tex", folderPaths: [], overleafPaths: [] },
        ]);
      }),
    ),
  );

  it.live("places a version 1 pending apply's record where the apply put the file", () => {
    let crash = true;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "old.tex": doc("theirs"), "other.tex": "O" },
          remote: { "new.tex": doc("theirs"), "other.tex": "O" },
          markerPaths: ["old.tex"],
          at: (point) =>
            crash && point === "applied" ? Effect.die(new Error("process died")) : Effect.void,
        });
        yield* write(w.folder, { "old.tex": scientMarks, "other.tex": "O2" });
        expect(Exit.isFailure(yield* Effect.exit(syncChoosing(w.coordinator, "mine")))).toBe(true);
        crash = false;
        // The pending apply as version 1 recorded it: folder paths from before the apply.
        yield* Effect.promise(async () => {
          const file = NodePath.join(
            w.stateRoot,
            (await NodeFSP.readdir(w.stateRoot, { recursive: true })).find((path) =>
              path.endsWith("connections/connection-1.json"),
            )!,
          );
          const document = JSON.parse(await NodeFSP.readFile(file, "utf8"));
          document.schemaVersion = 1;
          document.markerPaths = document.markers.map((record: { path: string }) => record.path);
          delete document.markers;
          document.activeApply.priorMarkers = document.activeApply.priorMarkers.map(
            (held: { path: string }) => held.path,
          );
          delete document.activeApply.markers;
          for (const copy of document.retention.copies) delete copy.markerLinks;
          await NodeFSP.writeFile(file, JSON.stringify(document));
        });
        const restarted = yield* w.coordinatorWith(w.store);
        yield* restarted.recover({ connectionId: CONNECTION });
        expect(yield* marked(w, "new.tex")).toBe(true);
        expect((yield* w.connection).markers).toEqual([
          { path: "new.tex", folderPaths: [], overleafPaths: ["new.tex", "old.tex"] },
        ]);
        const next = yield* syncChoosing(restarted, "mine", { requestId: "request-2" });
        expect(next.review.binding.heldPaths).toContain("new.tex");
        expect(next.result).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({
          "new.tex": doc("theirs"),
          "other.tex": "O2",
        });
      }),
    );
  });

  it.live("holds a restored marked copy at the Overleaf name its file had", () =>
    run(
      Effect.gen(function* () {
        // Short files: the marked text is too unlike Overleaf's for Git to see a rename.
        const shortMarks = "<<<<<<< Scient\nmine\n=======\ntheirs\n>>>>>>> Overleaf\n";
        const w = yield* world({
          overleaf: "git",
          synced: { "old.tex": "theirs\n", "other.tex": "O" },
          remote: { "new.tex": "theirs\n", "other.tex": "O" },
          markerPaths: ["old.tex"],
        });
        yield* write(w.folder, { "old.tex": shortMarks, "other.tex": "O2" });
        // Overleaf's rename moves the marked file to new.tex; old.tex's bytes are kept.
        yield* syncChoosing(w.coordinator, "mine");
        expect(yield* marked(w, "new.tex")).toBe(true);
        expect((yield* w.connection).retention.copies).toContainEqual(
          expect.objectContaining({
            relativePath: "old.tex",
            markers: true,
            markerLinks: ["new.tex"],
          }),
        );
        // The marked copy comes back at old.tex, and new.tex is deleted as a rename back.
        const copy = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).find(
          (entry) => entry.relativePath === "old.tex",
        )!;
        yield* w.coordinator.restoreKept({
          connectionId: CONNECTION,
          requestId: "restore-1",
          applyId: copy.applyId,
          kept: copy.kept,
          keptRevision: copy.keptRevision!,
          currentRevision: copy.currentRevision,
        });
        expect((yield* w.connection).markers).toContainEqual({
          path: "old.tex",
          folderPaths: [],
          overleafPaths: ["new.tex", "old.tex"],
        });
        yield* Effect.promise(() => NodeFSP.unlink(NodePath.join(w.folder, "new.tex")));
        const next = yield* syncChoosing(w.coordinator, "mine", { requestId: "request-2" });
        expect(next.review.binding.heldPaths).toEqual(["new.tex", "old.tex"]);
        expect(next.review.outgoing).toEqual([]);
        expect((yield* w.overleafNow).contents).toEqual({
          "new.tex": "theirs\n",
          "other.tex": "O2",
        });
      }),
    ),
  );
});
