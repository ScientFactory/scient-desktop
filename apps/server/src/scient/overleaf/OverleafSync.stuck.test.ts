// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * A link can never trap a person: whatever happened to the project or the folder,
 * it can be seen, unlinked and made again. Field report, Windows, 2026-10-31.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { canApply } from "./OverleafCoordinator.testkit.ts";
import {
  OTHER_PROJECT,
  overleafSyncWorld as world,
  PROJECT,
  read,
  runOverleafSync as run,
  write,
} from "./OverleafSync.testkit.ts";

const linked = Effect.fnUntraced(function* (w: Effect.Success<ReturnType<typeof world>>) {
  const connected = yield* w.service.connect({
    caller: w.at(w.main),
    folder: "paper",
    create: true,
    project: PROJECT,
    requestId: "c1",
  });
  if (connected._tag !== "connected") return yield* Effect.die(connected);
  const id = connected.connection.connectionId;
  yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s1" });
  return id;
});

describe.skipIf(!canApply)("a link never traps anyone", () => {
  it.live("keeps working when the project is removed and added again on the same folder", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const id = yield* linked(w);
        // What the binding store does for the same physical folder under a new project.
        w.bindings.set(w.main, {
          bindingId: "binding-main",
          hostProjectId: "project-readded",
          generation: 2,
        });
        expect(yield* w.service.list(w.at(w.main))).toMatchObject([{ connectionId: id }]);
        expect(yield* w.service.status({ caller: w.at(w.main), connectionId: id })).toMatchObject({
          availability: "ready",
        });
        expect(
          yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s2" }),
        ).toMatchObject({ _tag: "synced" });
      }),
    ),
  );

  it.live("keeps working when the folder only gained a Git repository", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const id = yield* linked(w);
        // A new repository changes the authority evidence: same folder, same project.
        w.bindings.set(w.main, {
          bindingId: "binding-main",
          hostProjectId: "project-1",
          generation: 2,
        });
        expect(
          yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s2" }),
        ).toMatchObject({ _tag: "synced" });
      }),
    ),
  );

  it.live("can always be unlinked after the project changed", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const id = yield* linked(w);
        w.bindings.set(w.main, {
          bindingId: "binding-main",
          hostProjectId: "project-readded",
          generation: 2,
        });
        expect(
          yield* w.service.disconnect({ caller: w.at(w.main), connectionId: id, requestId: "d1" }),
        ).toMatchObject({ _tag: "done", connection: { state: "archived" } });
      }),
    ),
  );

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

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
    "doesn't take a folder it can't read for a gone one",
    () =>
      run(
        Effect.gen(function* () {
          const w = yield* world();
          const sub = NodePath.join(w.main, "sub");
          yield* Effect.promise(() => NodeFSP.mkdir(sub));
          const connected = yield* w.service.connect({
            caller: w.at(w.main),
            folder: "sub/paper",
            create: true,
            project: PROJECT,
            requestId: "c1",
          });
          if (connected._tag !== "connected") return yield* Effect.die(connected);
          const id = connected.connection.connectionId;
          // A permission problem, not a deleted folder: the link stays, and still blocks.
          yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.chmod(sub, 0o000)),
            () => Effect.promise(() => NodeFSP.chmod(sub, 0o700)),
          );
          expect(
            yield* w.service.connect({
              caller: w.at(w.main),
              folder: "second",
              create: true,
              project: PROJECT,
              requestId: "c2",
            }),
          ).toMatchObject({ _tag: "refused", reason: "project-already-linked" });
          const kept = yield* w.store.readConnection(id);
          if (kept._tag !== "ready") return yield* Effect.die(kept);
          expect(kept.document.state).toBe("active");
        }),
      ),
  );

  it.live("won't unlink when the link's checkout left the caller's project meanwhile", () =>
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
        // The unlink finishes the interrupted sync first; that waits on the windows' saves.
        w.setEditorSave(
          { _tag: "saved" },
          Effect.sync(() =>
            w.bindings.set(w.main, {
              bindingId: "binding-main",
              hostProjectId: "project-2",
              generation: 2,
            }),
          ),
        );
        expect(
          yield* w.service.disconnect({
            caller: w.at(w.worktree),
            connectionId: id,
            requestId: "d1",
          }),
        ).toMatchObject({ _tag: "refused", reason: "authority-changed" });
      }),
    ),
  );

  it.live("still refuses a second link of a project whose first folder stands", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const id = yield* linked(w);
        yield* write(NodePath.join(w.main, "paper"), { "notes.tex": "mine" });
        expect(
          yield* w.service.connect({
            caller: w.at(w.main),
            folder: "second",
            create: true,
            project: PROJECT,
            requestId: "c2",
          }),
        ).toMatchObject({ _tag: "refused", reason: "project-already-linked" });
        expect(yield* w.service.list(w.at(w.main))).toMatchObject([{ connectionId: id }]);
      }),
    ),
  );

  it.live("leaves a dead link that is not in the way as it is", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: { [PROJECT]: { "main.tex": "A" }, [OTHER_PROJECT]: { "main.tex": "B" } },
        });
        const id = yield* linked(w);
        yield* Effect.promise(() =>
          NodeFSP.rm(NodePath.join(w.main, "paper"), { recursive: true }),
        );
        yield* w.service.connect({
          caller: w.at(w.main),
          folder: "elsewhere",
          create: true,
          project: OTHER_PROJECT,
          requestId: "c2",
        });
        const untouched = yield* w.store.readConnection(id);
        if (untouched._tag !== "ready") return yield* Effect.die(untouched);
        expect(untouched.document.state).toBe("active");
      }),
    ),
  );

  it.live("never lets another project see or unlink a link", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const id = yield* linked(w);
        expect(
          yield* Effect.flip(
            w.service.disconnect({ caller: w.at(w.elsewhere), connectionId: id, requestId: "d1" }),
          ),
        ).toMatchObject({ reason: "workspace-not-authorized" });
        expect(yield* w.service.list(w.at(w.elsewhere))).toEqual([]);
      }),
    ),
  );

  it.live("says when Overleaf holds changes, by asking Overleaf", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const id = yield* linked(w);
        const asked = w.service.remoteState({ caller: w.at(w.main), connectionId: id });
        expect(yield* asked).toEqual({ state: "same" });
        yield* w.collaborate(PROJECT, { "main.tex": "edited on Overleaf" });
        expect(yield* asked).toEqual({ state: "changed" });
        // Asking changes nothing here: the folder waits for a sync.
        expect(yield* read(NodePath.join(w.main, "paper"), "main.tex")).toBe("from Overleaf");
        yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s2" });
        expect(yield* asked).toEqual({ state: "same" });
      }),
    ),
  );

  it.live("doesn't call a new Overleaf commit a change when its files are the same", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const id = yield* linked(w);
        yield* w.collaborate(PROJECT, { "main.tex": "from Overleaf" });
        const asked = w.service.remoteState({ caller: w.at(w.main), connectionId: id });
        expect(yield* asked).toEqual({ state: "same" });
        expect(yield* asked).toEqual({ state: "same" });
      }),
    ),
  );

  it.live("answers unknown for a link that never synced", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const connected = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "c1",
        });
        if (connected._tag !== "connected") return yield* Effect.die(connected);
        expect(
          yield* w.service.remoteState({
            caller: w.at(w.main),
            connectionId: connected.connection.connectionId,
          }),
        ).toEqual({ state: "unknown" });
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

  it.live("still sends a deletion that leaves the project some files", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: { [PROJECT]: { "main.tex": "A", "refs.bib": "B" } },
        });
        const id = yield* linked(w);
        yield* Effect.promise(() => NodeFSP.rm(NodePath.join(w.main, "paper", "refs.bib")));
        expect(
          yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s2" }),
        ).toMatchObject({ _tag: "synced" });
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "A" });
      }),
    ),
  );

  it.live("links one Overleaf project into two different Scient projects", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        yield* linked(w);
        expect(
          yield* w.service.connect({
            caller: w.at(w.elsewhere),
            folder: "paper",
            create: true,
            project: PROJECT,
            requestId: "c2",
          }),
        ).toMatchObject({ _tag: "connected" });
      }),
    ),
  );
});
