// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * What a link does when its physical folder is deleted or comes back. These depend on the disk,
 * so they also run in the Overleaf Windows job; OverleafSync.folderMoves.test.ts holds moved,
 * replaced and emptied folders, and the rest of a link's bookkeeping is in
 * OverleafSync.stuck.test.ts, which runs on Linux and macOS.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { hasPrivateFoldersAndIdentity } from "./OverleafCoordinator.testkit.ts";
import {
  linkedPaper as linked,
  overleafSyncWorld as world,
  PROJECT,
  read,
  runOverleafSync as run,
  write,
} from "./OverleafSync.testkit.ts";

describe.skipIf(!hasPrivateFoldersAndIdentity)("a link and its folder", () => {
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
        // Seen once, the restore is the link's own: edits before the next sync are its changes.
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
        yield* write(paper, {
          "preamble.tex": "the shared template's preamble",
          "refs.bib": "the shared template's references",
        });
        yield* w.service.sync({ caller, connectionId, requestId: "s2" });
        yield* Effect.promise(() => NodeFSP.rm(paper, { recursive: true }));
        // The same names and every file but main.tex shared, as two papers from a template have.
        yield* write(paper, {
          "main.tex": "someone else's work",
          "preamble.tex": "the shared template's preamble",
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
          "preamble.tex": "the shared template's preamble",
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
});
