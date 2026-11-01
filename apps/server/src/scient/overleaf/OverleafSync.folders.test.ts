// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * What a link does when its physical folder is deleted, moved, replaced or emptied.
 * These depend on the disk, so they also run in the Overleaf Windows job; the rest of
 * a link's bookkeeping is in OverleafSync.stuck.test.ts and runs on Linux and macOS.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { canApply } from "./OverleafCoordinator.testkit.ts";
import {
  linkedPaper as linked,
  OTHER_PROJECT,
  overleafSyncWorld as world,
  PROJECT,
  read,
  runOverleafSync as run,
  write,
} from "./OverleafSync.testkit.ts";

describe.skipIf(!canApply)("a link and its folder", () => {
  it.live("can be unlinked after its folder was deleted", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const id = yield* linked(w);
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(w.main, "paper"), { recursive: true }),
        );
        expect(yield* w.service.status({ caller: w.at(w.main), connectionId: id })).toMatchObject({
          availability: "unavailable",
          reasons: ["folder-changed"],
        });
        expect(
          yield* w.service.disconnect({ caller: w.at(w.main), connectionId: id, requestId: "d1" }),
        ).toMatchObject({ _tag: "done" });
      }),
    ),
  );

  it.live("can be unlinked when an interrupted sync can no longer finish", () =>
    run(
      Effect.gen(function* () {
        let crash = false;
        const w = yield* world({
          at: (point) => (point === "applied" && crash ? Effect.die("stopped") : Effect.void),
        });
        const id = yield* linked(w);
        yield* w.collaborate(PROJECT, { "main.tex": "newer" });
        crash = true;
        yield* Effect.exit(
          w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s2" }),
        );
        crash = false;
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(w.main, "paper"), { recursive: true }),
        );
        expect(
          yield* w.service.disconnect({ caller: w.at(w.main), connectionId: id, requestId: "d1" }),
        ).toMatchObject({ _tag: "done" });
      }),
    ),
  );

  it.live("goes on with its folder when it comes back, edited or not", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const connectionId = yield* linked(w);
        const caller = w.at(w.main);
        const paper = NodePath.join(w.main, "paper");
        const away = `${paper}-away`;
        yield* write(paper, { "notes.tex": "notes", "refs.bib": "refs" });
        yield* w.service.sync({ caller, connectionId, requestId: "s2" });
        // A copy put back is a new folder at the same place, as a cloud drive leaves it.
        yield* Effect.promise(async () => {
          await NodeFSP.rename(paper, away);
          await NodeFSP.cp(away, paper, { recursive: true });
          await NodeFSP.rm(away, { recursive: true });
        });
        expect(yield* w.service.status({ caller, connectionId })).toMatchObject({
          availability: "ready",
          reasons: [],
        });
        yield* write(paper, { "main.tex": "after the restore" });
        expect(yield* w.service.sync({ caller, connectionId, requestId: "s3" })).toMatchObject({
          _tag: "synced",
        });
        expect(yield* w.overleafNow(PROJECT)).toEqual({
          "main.tex": "after the restore",
          "notes.tex": "notes",
          "refs.bib": "refs",
        });
      }),
    ),
  );

  it.live("won't take a different folder at its place for its own", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const connectionId = yield* linked(w);
        const caller = w.at(w.main);
        const paper = NodePath.join(w.main, "paper");
        yield* write(paper, { "refs.bib": "the shared template's references" });
        yield* w.service.sync({ caller, connectionId, requestId: "s2" });
        yield* Effect.promise(() => NodeFSP.rm(paper, { recursive: true }));
        // The same names and one shared file, as two papers from a template have.
        yield* write(paper, {
          "main.tex": "someone else's work",
          "refs.bib": "the shared template's references",
        });
        expect(yield* w.service.status({ caller, connectionId })).toMatchObject({
          availability: "unavailable",
          reasons: ["folder-changed"],
        });
        expect(
          yield* Effect.flip(w.service.sync({ caller, connectionId, requestId: "s3" })),
        ).toMatchObject({ _tag: "OverleafConnectionNotReadyError", reason: "folder-changed" });
        expect(yield* w.overleafNow(PROJECT)).toEqual({
          "main.tex": "from Overleaf",
          "refs.bib": "the shared template's references",
        });
      }),
    ),
  );

  it.live("brings the project in again after its folder was deleted", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        yield* linked(w);
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(w.main, "paper"), { recursive: true }),
        );
        const again = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "c2",
        });
        if (again._tag !== "connected") return yield* Effect.die(again);
        // A connected link has to work: its first sync fills the new folder.
        expect(
          yield* w.service.sync({
            caller: w.at(w.main),
            connectionId: again.connection.connectionId,
            requestId: "s2",
          }),
        ).toMatchObject({ _tag: "synced" });
        expect(yield* read(NodePath.join(w.main, "paper"), "main.tex")).toBe("from Overleaf");
        // The dead link's base was not inherited: Overleaf lost nothing to an empty folder.
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "from Overleaf" });
      }),
    ),
  );

  it.live("brings the project into a new folder after the old one was deleted", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        yield* linked(w);
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(w.main, "paper"), { recursive: true }),
        );
        const again = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper-again",
          create: true,
          project: PROJECT,
          requestId: "c2",
        });
        if (again._tag !== "connected") return yield* Effect.die(again);
        expect((yield* w.service.list(w.at(w.main))).map((link) => link.connectionId)).toEqual([
          again.connection.connectionId,
        ]);
        yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: again.connection.connectionId,
          requestId: "s2",
        });
        expect(yield* read(NodePath.join(w.main, "paper-again"), "main.tex")).toBe("from Overleaf");
      }),
    ),
  );

  it.live("finishes an interrupted sync on the way out when the folder is still there", () =>
    run(
      Effect.gen(function* () {
        let crash = false;
        const w = yield* world({
          at: (point) => (point === "applied" && crash ? Effect.die("stopped") : Effect.void),
        });
        const id = yield* linked(w);
        yield* w.collaborate(PROJECT, { "main.tex": "newer" });
        crash = true;
        yield* Effect.exit(
          w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s2" }),
        );
        crash = false;
        expect(
          yield* w.service.disconnect({ caller: w.at(w.main), connectionId: id, requestId: "d1" }),
        ).toMatchObject({ _tag: "done" });
        const archived = yield* w.store.readConnection(id);
        if (archived._tag !== "ready") return yield* Effect.die(archived);
        expect(archived.document).toMatchObject({ state: "archived", activeApply: null });
        expect(yield* read(NodePath.join(w.main, "paper"), "main.tex")).toBe("newer");
      }),
    ),
  );

  it.live("takes its history along when a moved folder is linked at its new place", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const id = yield* linked(w);
        yield* Effect.promise(() =>
          NodeFSP.rename(NodePath.join(w.main, "paper"), NodePath.join(w.main, "moved")),
        );
        expect(
          yield* w.service.connect({
            caller: w.at(w.main),
            folder: "moved",
            create: false,
            project: PROJECT,
            requestId: "c2",
          }),
        ).toMatchObject({
          _tag: "connected",
          reconnected: true,
          connection: { connectionId: id, folder: "moved" },
        });
        expect(
          yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s2" }),
        ).toMatchObject({ _tag: "synced", review: { upToDate: true } });
      }),
    ),
  );

  it.live("lets a new folder at a dead link's path take another Overleaf project", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: { [PROJECT]: { "main.tex": "A" }, [OTHER_PROJECT]: { "main.tex": "B" } },
        });
        yield* linked(w);
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(w.main, "paper"), { recursive: true }),
        );
        const other = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: true,
          project: OTHER_PROJECT,
          requestId: "c2",
        });
        if (other._tag !== "connected") return yield* Effect.die(other);
        yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: other.connection.connectionId,
          requestId: "s2",
        });
        expect(yield* read(NodePath.join(w.main, "paper"), "main.tex")).toBe("B");
      }),
    ),
  );

  it.live("never deletes everything on Overleaf because a folder was emptied", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: { [PROJECT]: { "main.tex": "A", "refs.bib": "B" } },
        });
        const id = yield* linked(w);
        const folder = NodePath.join(w.main, "paper");
        for (const name of ["main.tex", "refs.bib"])
          yield* Effect.promise(() => NodeFSP.rm(NodePath.join(folder, name)));
        expect(
          yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s2" }),
        ).toMatchObject({ _tag: "refused", refusal: { reason: "would-empty-overleaf" } });
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "A", "refs.bib": "B" });
      }),
    ),
  );

  it.live("isn't fooled by a stray file left in an emptied folder", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: { [PROJECT]: { "main.tex": "A", "refs.bib": "B" } },
        });
        const id = yield* linked(w);
        const folder = NodePath.join(w.main, "paper");
        for (const name of ["main.tex", "refs.bib"])
          yield* Effect.promise(() => NodeFSP.rm(NodePath.join(folder, name)));
        yield* write(folder, { "desktop.ini": "[.ShellClassInfo]" });
        expect(
          yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s2" }),
        ).toMatchObject({ _tag: "refused", refusal: { reason: "would-empty-overleaf" } });
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "A", "refs.bib": "B" });
      }),
    ),
  );
});
