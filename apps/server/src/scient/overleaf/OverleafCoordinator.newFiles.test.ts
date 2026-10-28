// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/** New-file rule: reviews select new files by default, rules skip some without
 * remembering them, and only a deliberate deselection stays local-only; a
 * local-only file can still be sent. Real folders, applier and bare repo. */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { OverleafSelections } from "./OverleafCoordinator.ts";
import { CONNECTION, canApply, read, run, world, write } from "./OverleafCoordinator.testkit.ts";

type World = Effect.Success<ReturnType<typeof world>>;

const prepared = (w: World, selections?: OverleafSelections) =>
  Effect.gen(function* () {
    const result = yield* w.coordinator.prepare({
      connectionId: CONNECTION,
      ...(selections ? { selections } : {}),
    });
    if (result._tag !== "review") return yield* Effect.die(result);
    return result.review;
  });
const confirmed = (
  w: World,
  review: Effect.Success<ReturnType<typeof prepared>>,
  requestId = "request-1",
) =>
  w.coordinator.confirm({
    connectionId: CONNECTION,
    requestId,
    reviewId: review.id,
    digest: review.digest,
    acknowledgements: review.binding.acknowledgements,
  });
const skipped = (review: Effect.Success<ReturnType<typeof prepared>>) =>
  review.additions
    .filter((addition) => !addition.selected)
    .map((addition) => [addition.path, addition.uncheckedReason]);

describe.skipIf(!canApply)("OverleafCoordinator, new files", () => {
  it.live("sends new files by default and skips the rule's files without remembering them", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "M" },
          remote: { "main.tex": "M" },
        });
        yield* write(w.folder, {
          "fig.tex": "F",
          ".env": "SECRET=1",
          "main.aux": "aux",
          ".cache/x.txt": "x",
          // Below the checkout's top, Scient's own file names are ordinary files.
          "AGENTS.md": "agents",
        });
        const first = yield* prepared(w);
        expect(first.binding.selectedAdditions).toEqual(["AGENTS.md", "fig.tex"]);
        expect(first.binding.newLocalOnly).toEqual([]);
        expect(skipped(first)).toEqual([
          [".cache/x.txt", "hidden"],
          [".env", "hidden"],
          ["main.aux", "build-output"],
        ]);
        expect(yield* confirmed(w, first)).toMatchObject({
          publication: { _tag: "accepted" },
        });
        expect((yield* w.overleafNow).contents).toEqual({
          "main.tex": "M",
          "fig.tex": "F",
          "AGENTS.md": "agents",
        });
        const after = yield* w.connection;
        expect(after.localOnlyPaths).toEqual([]);
        expect([...after.managedPaths].sort()).toEqual(["AGENTS.md", "fig.tex", "main.tex"]);
        // Offered again at the next sync, still skipped by the rule.
        const next = yield* prepared(w);
        expect(next.upToDate).toBe(true);
        expect(skipped(next)).toEqual(skipped(first));
      }),
    ),
  );

  it.live("skips Scient's own project files when the folder is the checkout's top", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          atCheckoutTop: true,
          synced: { "main.tex": "M" },
          remote: { "main.tex": "M" },
        });
        // Another letter case names the same file on a disk that ignores it.
        yield* write(w.folder, { "AGENTS.md": "a", "project.md": "p", "fig.tex": "F" });
        const review = yield* prepared(w);
        expect(review.binding.selectedAdditions).toEqual(["fig.tex"]);
        expect(skipped(review)).toEqual([
          ["AGENTS.md", "scient-project-file"],
          ["project.md", "scient-project-file"],
        ]);
        expect(yield* confirmed(w, review)).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).localOnlyPaths).toEqual([]);
      }),
    ),
  );

  it.live("selects the defaults when choices are given without additions", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
        });
        yield* write(w.folder, { "main.tex": "C", "fig.tex": "F", "main.log": "log" });
        const first = yield* prepared(w);
        expect(first.confirmable).toBe(false);
        const choices = new Map(first.conflicts.map((conflict) => [conflict.key, "mine" as const]));
        const chosen = yield* prepared(w, { collisionPaths: [], choices });
        expect(chosen.confirmable).toBe(true);
        expect(chosen.binding.selectedAdditions).toEqual(["fig.tex"]);
        expect(chosen.binding.newLocalOnly).toEqual([]);
        // An explicit list, even an empty one, is used exactly as given.
        const none = yield* prepared(w, { selectedAdditions: [], collisionPaths: [], choices });
        expect(none.binding.selectedAdditions).toEqual([]);
        expect(none.binding.newLocalOnly).toEqual(["fig.tex"]);
      }),
    ),
  );

  it.live("remembers a deselected default file, and only that one", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "M" }, remote: { "main.tex": "M" } });
        yield* write(w.folder, { "notes.tex": "mine", "fig.tex": "F", "main.log": "log" });
        const review = yield* prepared(w, {
          selectedAdditions: ["fig.tex"],
          collisionPaths: [],
          choices: new Map(),
        });
        expect(review.binding.newLocalOnly).toEqual(["notes.tex"]);
        expect(yield* confirmed(w, review)).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).localOnlyPaths).toEqual(["notes.tex"]);
        // Kept here from now on; the build log is judged again and stays an addition.
        const next = yield* prepared(w);
        expect(next.localOnly).toEqual(["notes.tex"]);
        expect(next.binding.selectedAdditions).toEqual([]);
        expect(skipped(next)).toEqual([["main.log", "build-output"]]);
      }),
    ),
  );

  it.live("rebuilds a stale review with the same rule: a file that appeared is sent", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "M" },
          remote: { "main.tex": "M" },
          localOnly: { "local.tex": "only here" },
        });
        yield* write(w.folder, { "keep.tex": "K", "fig.tex": "F", "notes.tex": "N" });
        // Deselects keep.tex, and sends the file kept only here.
        const review = yield* prepared(w, {
          selectedAdditions: ["fig.tex", "notes.tex"],
          sendLocalOnly: ["local.tex"],
          collisionPaths: [],
          choices: new Map(),
        });
        yield* write(w.folder, { "late.tex": "L" });
        const stale = yield* confirmed(w, review);
        if (stale._tag !== "stale") return yield* Effect.die(stale);
        expect(stale.review.binding.selectedAdditions).toEqual([
          "fig.tex",
          "late.tex",
          "notes.tex",
        ]);
        expect(stale.review.binding.newLocalOnly).toEqual(["keep.tex"]);
        expect(stale.review.binding.sentLocalOnly).toEqual(["local.tex"]);
        // A selected file that is gone is left out, not refused.
        yield* Effect.promise(() => NodeFSP.rm(NodePath.join(w.folder, "notes.tex")));
        const again = yield* confirmed(w, stale.review, "request-2");
        if (again._tag !== "stale") return yield* Effect.die(again);
        expect(again.review.binding.selectedAdditions).toEqual(["fig.tex", "late.tex"]);
        expect(yield* confirmed(w, again.review, "request-3")).toMatchObject({
          _tag: "applied",
        });
        const after = yield* w.connection;
        expect(after.localOnlyPaths).toEqual(["keep.tex"]);
        expect([...after.managedPaths].sort()).toEqual([
          "fig.tex",
          "late.tex",
          "local.tex",
          "main.tex",
        ]);
      }),
    ),
  );

  it.live("keeps a deselected file only here even if it grows too large before confirm", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "M" },
          remote: { "main.tex": "M" },
        });
        yield* write(w.folder, { "notes.txt": "mine" });
        const review = yield* prepared(w, {
          selectedAdditions: [],
          collisionPaths: [],
          choices: new Map(),
        });
        expect(review.binding.newLocalOnly).toEqual(["notes.txt"]);
        // Sparse: too large for Overleaf, so the rule now skips it as well. The edit
        // to main.tex makes the review stale, so confirm offers a replacement.
        yield* Effect.promise(() =>
          NodeFSP.truncate(NodePath.join(w.folder, "notes.txt"), 50_000_001),
        );
        yield* write(w.folder, { "main.tex": "M2" });
        const stale = yield* confirmed(w, review);
        if (stale._tag !== "stale") return yield* Effect.die(stale);
        expect(stale.review.binding.newLocalOnly).toEqual(["notes.txt"]);
        expect(yield* confirmed(w, stale.review, "request-2")).toMatchObject({
          publication: { _tag: "accepted" },
        });
        expect((yield* w.connection).localOnlyPaths).toEqual(["notes.txt"]);
        // Small again, it stays on this computer.
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(w.folder, "notes.txt"), "n2"));
        yield* write(w.folder, { "main.tex": "M3" });
        expect(yield* w.sync("request-3")).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": "M3" });
      }),
    ),
  );

  it.live("keeps a file asked to stay here through a disappearance and return", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "M" }, remote: { "main.tex": "M" } });
        const kept = NodePath.join(w.folder, "k.tex");
        yield* write(w.folder, { "k.tex": "mine" });
        const review = yield* prepared(w, {
          keepOnlyHere: ["k.tex"],
          collisionPaths: [],
          choices: new Map(),
        });
        expect(review.binding.newLocalOnly).toEqual(["k.tex"]);
        yield* Effect.promise(() => NodeFSP.rm(kept));
        const gone = yield* confirmed(w, review);
        if (gone._tag !== "stale") return yield* Effect.die(gone);
        expect(gone.review.binding.newLocalOnly).toEqual([]);
        expect(gone.review.binding.keepOnlyHere).toEqual(["k.tex"]);
        // Back before the replacement is confirmed: still the file asked to stay here.
        yield* Effect.promise(() => NodeFSP.writeFile(kept, "mine again"));
        const back = yield* confirmed(w, gone.review, "request-2");
        if (back._tag !== "stale") return yield* Effect.die(back);
        expect(back.review.binding.selectedAdditions).toEqual([]);
        expect(back.review.binding.newLocalOnly).toEqual(["k.tex"]);
        expect(yield* confirmed(w, back.review, "request-3")).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).localOnlyPaths).toEqual(["k.tex"]);
      }),
    ),
  );

  it.live("keeps a file asked to stay here that the rule skips, after it shrinks", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "M" }, remote: { "main.tex": "M" } });
        const big = NodePath.join(w.folder, "data.bin");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(big, "");
          await NodeFSP.truncate(big, 50_000_001);
        });
        const review = yield* prepared(w, {
          keepOnlyHere: ["data.bin"],
          collisionPaths: [],
          choices: new Map(),
        });
        expect(review.binding.newLocalOnly).toEqual(["data.bin"]);
        yield* Effect.promise(() => NodeFSP.writeFile(big, "small"));
        expect(yield* confirmed(w, review)).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).localOnlyPaths).toEqual(["data.bin"]);
        expect((yield* prepared(w)).upToDate).toBe(true);
      }),
    ),
  );

  it.live(
    "carries requests to keep and send through a rebuild; new files follow the defaults",
    () =>
      run(
        Effect.gen(function* () {
          const w = yield* world({ synced: { "main.tex": "M" }, remote: { "main.tex": "M" } });
          yield* write(w.folder, { "k.tex": "K", ".env": "E", "fig.tex": "F" });
          const review = yield* prepared(w, {
            keepOnlyHere: ["k.tex"],
            send: [".env"],
            collisionPaths: [],
            choices: new Map(),
          });
          expect(review.binding.selectedAdditions).toEqual([".env", "fig.tex"]);
          yield* write(w.folder, { "late.tex": "L" });
          const stale = yield* confirmed(w, review);
          if (stale._tag !== "stale") return yield* Effect.die(stale);
          expect(stale.review.binding).toMatchObject({
            selectedAdditions: [".env", "fig.tex", "late.tex"],
            newLocalOnly: ["k.tex"],
            keepOnlyHere: ["k.tex"],
            send: [".env"],
          });
          expect(yield* confirmed(w, stale.review, "request-2")).toMatchObject({
            _tag: "applied",
          });
          const after = yield* w.connection;
          expect(after.localOnlyPaths).toEqual(["k.tex"]);
          expect([...after.managedPaths].sort()).toEqual([
            ".env",
            "fig.tex",
            "late.tex",
            "main.tex",
          ]);
        }),
      ),
  );

  it.live("sends a rule-skipped file on request, and a repeated request is satisfied", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "M" },
          remote: { "main.tex": "M" },
        });
        yield* write(w.folder, { ".latexmkrc": "rc" });
        const selections = { send: [".latexmkrc"], collisionPaths: [], choices: new Map() };
        const review = yield* prepared(w, selections);
        expect(review.binding.selectedAdditions).toEqual([".latexmkrc"]);
        expect(yield* confirmed(w, review)).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": "M", ".latexmkrc": "rc" });
        // A retry after it was applied: already synced, nothing more to do.
        const again = yield* prepared(w, selections);
        expect(again.upToDate).toBe(true);
      }),
    ),
  );

  it.live("keeps a file an explicit list left out through a disappearance and return", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "M" },
          remote: { "main.tex": "M" },
        });
        const kept = NodePath.join(w.folder, "private.tex");
        yield* write(w.folder, { "private.tex": "mine" });
        const review = yield* prepared(w, {
          selectedAdditions: [],
          collisionPaths: [],
          choices: new Map(),
        });
        expect(review.binding.keepOnlyHere).toEqual(["private.tex"]);
        yield* Effect.promise(() => NodeFSP.rm(kept));
        const gone = yield* confirmed(w, review);
        if (gone._tag !== "stale") return yield* Effect.die(gone);
        expect(gone.review.binding.keepOnlyHere).toEqual(["private.tex"]);
        yield* Effect.promise(() => NodeFSP.writeFile(kept, "mine again"));
        const back = yield* confirmed(w, gone.review, "request-2");
        if (back._tag !== "stale") return yield* Effect.die(back);
        expect(back.review.binding.selectedAdditions).toEqual([]);
        expect(yield* confirmed(w, back.review, "request-3")).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).localOnlyPaths).toEqual(["private.tex"]);
        yield* write(w.folder, { "main.tex": "M2" });
        expect(yield* w.sync("request-4")).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": "M2" });
      }),
    ),
  );

  it.live("makes a local-only file sent where Overleaf has one a reviewed collision", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "M" },
          remote: { "main.tex": "M", "notes.tex": "remote" },
          localOnly: { "notes.tex": "" },
        });
        for (const selections of [
          { send: ["notes.tex"], collisionPaths: [], choices: new Map() },
          { sendLocalOnly: ["notes.tex"], collisionPaths: [], choices: new Map() },
        ]) {
          const review = yield* prepared(w, selections);
          expect(review.collisions).toEqual(["notes.tex"]);
          expect(review.confirmable).toBe(false);
          expect(review.conflicts.map((conflict) => conflict.paths)).toEqual([["notes.tex"]]);
        }
        const first = yield* prepared(w, {
          send: ["notes.tex"],
          collisionPaths: [],
          choices: new Map(),
        });
        const chosen = yield* prepared(w, {
          send: ["notes.tex"],
          collisionPaths: first.binding.collisionPaths,
          choices: new Map(first.conflicts.map((conflict) => [conflict.key, "mine" as const])),
        });
        expect(yield* confirmed(w, chosen)).toMatchObject({ publication: { _tag: "accepted" } });
        // Kept mine: the local bytes stay and are what Overleaf now has.
        expect(yield* read(w.folder, "notes.tex")).toBe("");
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": "M", "notes.tex": "" });
        expect((yield* w.connection).localOnlyPaths).toEqual([]);
      }),
    ),
  );

  it.live("still sends a local-only file when the collision it met is gone by confirm", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "M" },
          remote: { "main.tex": "M", "notes.tex": "remote" },
          localOnly: { "notes.tex": "mine" },
        });
        const first = yield* prepared(w, {
          sendLocalOnly: ["notes.tex"],
          collisionPaths: [],
          choices: new Map(),
        });
        const chosen = yield* prepared(w, {
          sendLocalOnly: ["notes.tex"],
          collisionPaths: first.binding.collisionPaths,
          choices: new Map(first.conflicts.map((conflict) => [conflict.key, "mine" as const])),
        });
        expect(chosen.binding.send).toEqual(["notes.tex"]);
        // A collaborator deletes Overleaf's file before the confirmation.
        yield* w.collaborate({ "main.tex": "M" });
        const stale = yield* confirmed(w, chosen);
        if (stale._tag !== "stale") return yield* Effect.die(stale);
        expect(stale.review.collisions).toEqual([]);
        expect(stale.review.binding.sentLocalOnly).toEqual(["notes.tex"]);
        expect(yield* confirmed(w, stale.review, "request-2")).toMatchObject({
          publication: { _tag: "accepted" },
        });
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": "M", "notes.tex": "mine" });
        const after = yield* w.connection;
        expect(after.localOnlyPaths).toEqual([]);
        expect([...after.managedPaths].sort()).toEqual(["main.tex", "notes.tex"]);
      }),
    ),
  );

  it.live("never reads or sends a new file over Overleaf's limit, and refuses selecting it", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "M" }, remote: { "main.tex": "M" } });
        const huge = NodePath.join(w.folder, "data.bin");
        // Sparse: as large as Overleaf refuses, without writing its bytes.
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(huge, "");
          await NodeFSP.truncate(huge, 50_000_001);
        });
        const review = yield* prepared(w);
        expect(skipped(review)).toEqual([["data.bin", "too-large"]]);
        expect(review.upToDate).toBe(true);
        expect(yield* confirmed(w, review)).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).localOnlyPaths).toEqual([]);
        expect(
          yield* w.coordinator.prepare({
            connectionId: CONNECTION,
            selections: { selectedAdditions: ["data.bin"], collisionPaths: [], choices: new Map() },
          }),
        ).toEqual({ _tag: "refused", refusal: { reason: "file-too-large", path: "data.bin" } });
        // Once it fits, it is sent like any other new file.
        yield* Effect.promise(() => NodeFSP.truncate(huge, 10));
        expect((yield* prepared(w)).binding.selectedAdditions).toEqual(["data.bin"]);
      }),
    ),
  );

  it.live("sends a file kept only here, which stays managed afterwards", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "M" },
          remote: { "main.tex": "M" },
          localOnly: { "notes.tex": "N", "keep.tex": "K", "gone.tex": "G" },
        });
        yield* Effect.promise(() => NodeFSP.rm(NodePath.join(w.folder, "gone.tex")));
        const refused = (path: string) =>
          w.coordinator.prepare({
            connectionId: CONNECTION,
            selections: { sendLocalOnly: [path], collisionPaths: [], choices: new Map() },
          });
        expect(yield* refused("main.tex")).toEqual({
          _tag: "refused",
          refusal: { reason: "not-local-only", path: "main.tex" },
        });
        expect(yield* refused("gone.tex")).toEqual({
          _tag: "refused",
          refusal: { reason: "not-selectable", path: "gone.tex" },
        });
        const review = yield* prepared(w, {
          sendLocalOnly: ["notes.tex"],
          collisionPaths: [],
          choices: new Map(),
        });
        expect(review.outgoing).toEqual([{ kind: "added", path: "notes.tex" }]);
        expect(review.localOnly).toEqual(["keep.tex"]);
        expect(yield* confirmed(w, review)).toMatchObject({
          publication: { _tag: "accepted" },
        });
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": "M", "notes.tex": "N" });
        const after = yield* w.connection;
        expect([...after.localOnlyPaths].sort()).toEqual(["gone.tex", "keep.tex"]);
        expect([...after.managedPaths].sort()).toEqual(["main.tex", "notes.tex"]);
        // Managed now: an edit goes with the next ordinary sync.
        yield* write(w.folder, { "notes.tex": "N2" });
        expect(yield* w.sync("request-2")).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toEqual({ "main.tex": "M", "notes.tex": "N2" });
      }),
    ),
  );

  it.live("syncs a file the rule would skip once Overleaf has it", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: "git",
          synced: { "main.tex": "M", "refs.bbl": "B1", ".latexmkrc": "R1" },
          remote: { "main.tex": "M", "refs.bbl": "B1", ".latexmkrc": "R2", "new.bbl": "N" },
        });
        yield* write(w.folder, { "refs.bbl": "B2" });
        expect(yield* w.sync()).toMatchObject({ publication: { _tag: "accepted" } });
        expect(yield* read(w.folder, ".latexmkrc")).toBe("R2");
        expect(yield* read(w.folder, "new.bbl")).toBe("N");
        expect((yield* w.overleafNow).contents).toMatchObject({ "refs.bbl": "B2" });
        // A file that came from Overleaf is managed, whatever its name.
        yield* write(w.folder, { "new.bbl": "N2" });
        expect(yield* w.sync("request-2")).toMatchObject({ publication: { _tag: "accepted" } });
        expect((yield* w.overleafNow).contents).toMatchObject({ "new.bbl": "N2" });
        expect((yield* w.connection).localOnlyPaths).toEqual([]);
      }),
    ),
  );
});
