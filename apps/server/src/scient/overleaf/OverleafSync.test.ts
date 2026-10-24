// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * The step-5 service against a real local bare repository standing in for
 * Overleaf: connecting, the "only a conflict stops" sync, authority across
 * worktrees, the other-agents line, offline status, disconnect and relink.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

import { OverleafReservationOwner } from "./OverleafCoordinator.ts";
import { canApply } from "./OverleafCoordinator.testkit.ts";
import {
  OTHER_PROJECT,
  overleafSyncWorld as world,
  PROJECT,
  read,
  runOverleafSync as run,
  TOKEN,
  write,
} from "./OverleafSync.testkit.ts";

describe.skipIf(!canApply)("OverleafSync", () => {
  it.live(
    "brings a project in as a new folder, then the first sync fills it and sends nothing",
    () =>
      run(
        Effect.gen(function* () {
          const w = yield* world();
          const connected = yield* w.service.connect({
            caller: w.at(w.main),
            folder: "paper",
            create: true,
            project: `https://www.overleaf.com/project/${PROJECT}`,
            requestId: "connect-1",
          });
          if (connected._tag !== "connected") return yield* Effect.die(connected);
          expect(connected.connection).toMatchObject({
            folder: "paper",
            projectId: PROJECT,
            branch: "master",
          });
          const id = connected.connection.connectionId;
          // Connecting writes no manuscript file.
          expect(
            yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(w.main, "paper"))),
          ).toEqual([]);

          const synced = yield* w.service.sync({
            caller: w.at(w.main),
            connectionId: id,
            requestId: "s1",
          });
          expect(synced).toMatchObject({
            _tag: "synced",
            publication: { _tag: "none" },
            retried: false,
          });
          expect(yield* read(NodePath.join(w.main, "paper"), "main.tex")).toBe("from Overleaf");
          const status = yield* w.service.status({ caller: w.at(w.main), connectionId: id });
          expect(status).toMatchObject({
            availability: "ready",
            local: { _tag: "read", changed: 0, deleted: 0, added: 0 },
            linkedElsewhere: false,
          });
          // A repeated connect request names the same connection.
          const again = yield* w.service.connect({
            caller: w.at(w.main),
            folder: "paper",
            create: true,
            project: PROJECT,
            requestId: "connect-1",
          });
          expect(again).toMatchObject({ _tag: "connected", connection: { connectionId: id } });
        }),
      ),
  );

  it.live("syncs both ways without a question, and reports local changes offline", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ overleaf: { [PROJECT]: { "main.tex": "A", "other.tex": "O" } } });
        const connected = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "connect-1",
        });
        if (connected._tag !== "connected") return yield* Effect.die(connected);
        const id = connected.connection.connectionId;
        const folder = NodePath.join(w.main, "paper");
        yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s1" });

        yield* write(folder, { "main.tex": "A, edited here" });
        yield* Effect.promise(() => NodeFSP.rm(NodePath.join(folder, "other.tex")));
        expect(yield* w.service.status({ caller: w.at(w.main), connectionId: id })).toMatchObject({
          local: { _tag: "read", changed: 1, deleted: 1 },
        });

        yield* w.collaborate(PROJECT, { "main.tex": "A", "other.tex": "O", "new.tex": "N" });
        const synced = yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s2",
        });
        expect(synced).toMatchObject({ _tag: "synced", publication: { _tag: "accepted" } });
        expect(yield* w.overleafNow(PROJECT)).toEqual({
          "main.tex": "A, edited here",
          "new.tex": "N",
        });
        expect(yield* read(folder, "new.tex")).toBe("N");
      }),
    ),
  );

  it.live("stops only for a conflict, and nothing is applied until it is decided", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ overleaf: { [PROJECT]: { "main.tex": "line\n" } } });
        const connected = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "connect-1",
        });
        if (connected._tag !== "connected") return yield* Effect.die(connected);
        const id = connected.connection.connectionId;
        const folder = NodePath.join(w.main, "paper");
        yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s1" });
        yield* write(folder, { "main.tex": "mine\n" });
        yield* w.collaborate(PROJECT, { "main.tex": "theirs\n" });

        const stopped = yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s2",
        });
        if (stopped._tag !== "needs-decision") return yield* Effect.die(stopped);
        expect(stopped.review.needsDecision).toBe(true);
        expect(yield* read(folder, "main.tex")).toBe("mine\n");
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "theirs\n" });

        const key = stopped.review.conflicts[0]!.key;
        const decided = yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s3",
          choices: new Map([[key, "mine"]]),
        });
        expect(decided).toMatchObject({ _tag: "synced", publication: { _tag: "accepted" } });
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "mine\n" });
      }),
    ),
  );

  it.live("starts one new sync when Overleaf moves during the send", () =>
    run(
      Effect.gen(function* () {
        let collaborated = false;
        let moveOverleaf: Effect.Effect<void> = Effect.void;
        const w = yield* world({
          overleaf: { [PROJECT]: { "main.tex": "A", "other.tex": "O" } },
          at: (point) =>
            point === "admitting" && !collaborated
              ? Effect.suspend(() => {
                  collaborated = true;
                  return moveOverleaf;
                })
              : Effect.void,
        });
        moveOverleaf = Effect.orDie(w.collaborate(PROJECT, { "main.tex": "A", "other.tex": "O2" }));
        const connected = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "connect-1",
        });
        if (connected._tag !== "connected") return yield* Effect.die(connected);
        const id = connected.connection.connectionId;
        const folder = NodePath.join(w.main, "paper");
        // The first sync has something to send (a new file), and Overleaf moves just
        // before it is sent: one sync covers the whole case.
        yield* write(folder, { "notes.tex": "N" });
        const synced = yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s1",
        });
        expect(synced).toMatchObject({
          _tag: "synced",
          publication: { _tag: "accepted" },
          retried: true,
        });
        expect(yield* w.overleafNow(PROJECT)).toEqual({
          "main.tex": "A",
          "notes.tex": "N",
          "other.tex": "O2",
        });
        expect(yield* read(folder, "other.tex")).toBe("O2");
      }),
    ),
  );

  it.live("refuses overlapping folders, a second link of one project, and a busy new folder", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: { [PROJECT]: { "main.tex": "A" }, [OTHER_PROJECT]: { "b.tex": "B" } },
        });
        const connect = (folder: string, project: string, create: boolean, requestId: string) =>
          w.service.connect({ caller: w.at(w.main), folder, create, project, requestId });
        expect(yield* connect("papers/one", PROJECT, true, "c1")).toMatchObject({
          _tag: "refused",
          reason: "folder-missing",
        });
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(w.main, "papers")));
        expect(yield* connect("papers/one", PROJECT, true, "c2")).toMatchObject({
          _tag: "connected",
        });
        expect(yield* connect("papers", OTHER_PROJECT, false, "c3")).toMatchObject({
          _tag: "refused",
          reason: "folder-overlaps",
        });
        expect(yield* connect("papers/one/inner", OTHER_PROJECT, true, "c4")).toMatchObject({
          _tag: "refused",
          reason: "folder-overlaps",
        });
        expect(yield* connect("papers/two", PROJECT, true, "c5")).toMatchObject({
          _tag: "refused",
          reason: "project-already-linked",
        });
        yield* write(NodePath.join(w.main, "notes"), { "a.txt": "x" });
        expect(yield* connect("notes", OTHER_PROJECT, true, "c6")).toMatchObject({
          _tag: "refused",
          reason: "folder-not-empty",
        });
        // A refused new folder is not left behind.
        expect(
          yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(w.main, "papers"))),
        ).toEqual(["one"]);
        expect(yield* connect("papers/two", OTHER_PROJECT, true, "c7")).toMatchObject({
          _tag: "connected",
        });
        // Another checkout of the same project may link the same Overleaf project.
        const elsewhere = yield* w.service.connect({
          caller: w.at(w.worktree),
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "c8",
        });
        expect(elsewhere).toMatchObject({ _tag: "connected" });
        // Not an Overleaf project: a recorded refusal, never a connection.
        expect(
          yield* w.service.connect({
            caller: w.at(w.main),
            folder: "x",
            create: true,
            project: "https://evil.example/project/1",
            requestId: "c9",
          }),
        ).toMatchObject({ _tag: "refused", reason: "project-invalid" });
      }),
    ),
  );

  it.live("needs a saved token to connect or sync", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ withToken: false });
        const refused = yield* Effect.flip(
          w.service.connect({
            caller: w.at(w.main),
            folder: "paper",
            create: true,
            project: PROJECT,
            requestId: "c1",
          }),
        );
        expect(refused).toMatchObject({
          _tag: "OverleafSyncRefusedError",
          reason: "token-missing",
        });
        expect(yield* w.service.tokenStatus).toEqual({ saved: false });
        yield* w.service.saveToken(` ${TOKEN} `);
        expect(yield* w.service.tokenStatus).toEqual({ saved: true });
        expect(
          yield* w.service.connect({
            caller: w.at(w.main),
            folder: "paper",
            create: true,
            project: PROJECT,
            requestId: "c1",
          }),
        ).toMatchObject({ _tag: "connected" });
      }),
    ),
  );

  it.live("acts on the linked copy from another worktree, and refuses another project", () =>
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
        const id = connected.connection.connectionId;
        const fromWorktree = yield* w.service.sync({
          caller: w.at(w.worktree),
          connectionId: id,
          requestId: "s1",
        });
        expect(fromWorktree).toMatchObject({ _tag: "synced", linkedElsewhere: true });
        expect(yield* read(NodePath.join(w.main, "paper"), "main.tex")).toBe("from Overleaf");
        expect(yield* w.service.list(w.at(w.worktree))).toMatchObject([
          { connectionId: id, linkedHere: false },
        ]);
        expect(yield* w.service.list(w.at(w.elsewhere))).toEqual([]);
        expect(
          yield* Effect.flip(
            w.service.sync({ caller: w.at(w.elsewhere), connectionId: id, requestId: "s2" }),
          ),
        ).toMatchObject({ reason: "workspace-not-authorized" });
        // A checkout re-registered under a new binding needs relinking first.
        w.bindings.set(w.main, {
          bindingId: "binding-main-2",
          hostProjectId: "project-1",
          generation: 1,
        });
        expect(
          yield* Effect.flip(
            w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s3" }),
          ),
        ).toMatchObject({ reason: "relink-needed" });
        expect(
          yield* w.service.relink({
            caller: w.at(w.main),
            connectionId: id,
            folder: "paper",
            requestId: "m1",
          }),
        ).toMatchObject({
          _tag: "done",
        });
        const after = yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s4",
        });
        expect(after).toMatchObject({ _tag: "synced" });
      }),
    ),
  );

  it.live("reports other agents in the copy, not the caller or its subagents", () =>
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
        const id = connected.connection.connectionId;
        w.threadRoots.set("me", w.main);
        w.setThreads([
          {
            threadId: "me",
            title: "Me",
            checkoutPath: w.main,
            parentThreadId: null,
            subagent: false,
          },
          {
            threadId: "helper",
            title: "Helper",
            checkoutPath: w.main,
            parentThreadId: "me",
            subagent: true,
          },
          {
            threadId: "other",
            title: "Other",
            checkoutPath: w.main,
            parentThreadId: null,
            subagent: false,
          },
          {
            threadId: "far",
            title: "Far",
            checkoutPath: w.worktree,
            parentThreadId: null,
            subagent: false,
          },
        ]);
        const synced = yield* w.service.sync({
          caller: { _tag: "thread", threadId: "me" },
          connectionId: id,
          requestId: "s1",
        });
        expect(synced).toMatchObject({
          _tag: "synced",
          activity: [{ threadId: "other", title: "Other" }],
        });
        w.setThreads(null);
        const unknown = yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s2",
        });
        expect(unknown).toMatchObject({ _tag: "synced", activity: null });
      }),
    ),
  );

  it.live("disconnects into an archive, and reconnecting the folder keeps its history", () =>
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
        const id = connected.connection.connectionId;
        yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s1" });
        const before = yield* w.store.readConnection(id);
        if (before._tag !== "ready") return yield* Effect.die(before);
        expect(
          yield* w.service.disconnect({ caller: w.at(w.main), connectionId: id, requestId: "m4" }),
        ).toMatchObject({
          _tag: "done",
          connection: { state: "archived" },
        });
        expect(yield* w.service.status({ caller: w.at(w.main), connectionId: id })).toMatchObject({
          availability: "disconnected",
        });
        expect(
          yield* Effect.flip(
            w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s2" }),
          ),
        ).toMatchObject({
          _tag: "OverleafConnectionNotReadyError",
          reason: "archived",
        });
        const again = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: false,
          project: PROJECT,
          requestId: "c2",
        });
        expect(again).toMatchObject({
          _tag: "connected",
          reconnected: true,
          connection: { connectionId: id },
        });
        const after = yield* w.store.readConnection(id);
        if (after._tag !== "ready") return yield* Effect.die(after);
        expect(after.document.base).toEqual(before.document.base);
        expect(
          yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s3" }),
        ).toMatchObject({
          _tag: "synced",
          review: { upToDate: true },
        });
      }),
    ),
  );
  it.live("relink belongs to the owning project only, even when its old checkout is gone", () =>
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
        const id = connected.connection.connectionId;
        // The old checkout no longer resolves; another project tries to take the link.
        w.bindings.delete(w.main);
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(w.elsewhere, "paper")));
        expect(
          yield* Effect.flip(
            w.service.relink({
              caller: w.at(w.elsewhere),
              connectionId: id,
              folder: "paper",
              requestId: "m2",
            }),
          ),
        ).toMatchObject({ reason: "workspace-not-authorized" });
        // The owning project's other checkout may take it.
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(w.worktree, "paper")));
        expect(
          yield* w.service.relink({
            caller: w.at(w.worktree),
            connectionId: id,
            folder: "paper",
            requestId: "m3",
          }),
        ).toMatchObject({
          _tag: "done",
          connection: { checkoutRoot: w.worktree },
        });
      }),
    ),
  );

  it.live("sends nothing when the workspace's authority changes just before the send", () =>
    run(
      Effect.gen(function* () {
        let change: () => void = () => undefined;
        const w = yield* world({
          overleaf: { [PROJECT]: { "main.tex": "A" } },
          at: (point) => (point === "admitting" ? Effect.sync(() => change()) : Effect.void),
        });
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
        yield* write(NodePath.join(w.main, "paper"), { "main.tex": "A, edited here" });
        change = () =>
          w.bindings.set(w.main, {
            bindingId: "binding-main",
            hostProjectId: "project-1",
            generation: 2,
          });
        const synced = yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s2",
        });
        expect(synced).toMatchObject({ _tag: "synced", publication: { _tag: "not-sent" } });
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "A" });
      }),
    ),
  );

  it.live("refuses a nested folder spelled with other letter case", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: { [PROJECT]: { "a.tex": "A" }, [OTHER_PROJECT]: { "b.tex": "B" } },
        });
        expect(
          yield* w.service.connect({
            caller: w.at(w.main),
            folder: "Papers",
            create: true,
            project: PROJECT,
            requestId: "c1",
          }),
        ).toMatchObject({ _tag: "connected" });
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(w.main, "Papers", "child")));
        expect(
          yield* w.service.connect({
            caller: w.at(w.main),
            folder: "papers/child",
            create: false,
            project: OTHER_PROJECT,
            requestId: "c2",
          }),
        ).toMatchObject({ _tag: "refused", reason: "folder-overlaps" });
      }),
    ),
  );

  it.live(
    "answers a repeated request with its receipt, and refuses its reuse by another caller",
    () =>
      run(
        Effect.gen(function* () {
          const w = yield* world({
            overleaf: { [PROJECT]: { "a.tex": "A" }, [OTHER_PROJECT]: { "b.tex": "B" } },
          });
          const connected = yield* w.service.connect({
            caller: w.at(w.main),
            folder: "paper",
            create: true,
            project: PROJECT,
            requestId: "c1",
          });
          if (connected._tag !== "connected") return yield* Effect.die(connected);
          const id = connected.connection.connectionId;
          const reused = yield* Effect.flip(
            w.service.connect({
              caller: w.at(w.elsewhere),
              folder: "other",
              create: true,
              project: OTHER_PROJECT,
              requestId: "c1",
            }),
          );
          expect(reused).toMatchObject({ _tag: "OverleafRequestReusedError" });
          expect(yield* Effect.promise(() => NodeFSP.readdir(w.elsewhere))).toEqual([".git"]);
          const first = yield* w.service.sync({
            caller: w.at(w.main),
            connectionId: id,
            requestId: "s1",
          });
          expect(first).toMatchObject({ _tag: "synced" });
          expect(
            yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s1" }),
          ).toMatchObject({
            _tag: "duplicate",
            receipt: { status: "completed", resultCategory: "synced-none" },
          });
        }),
      ),
  );

  it.live("reports Git failures as fixed reasons, never as internal errors", () =>
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
        yield* Effect.promise(() =>
          NodeFSP.rm(w.overleafFor(PROJECT), { recursive: true, force: true }),
        );
        const failed = yield* Effect.flip(
          w.service.sync({
            caller: w.at(w.main),
            connectionId: connected.connection.connectionId,
            requestId: "s1",
          }),
        );
        expect(failed).toMatchObject({ _tag: "OverleafSyncRefusedError" });
        expect(["project-not-found", "unreachable", "git-failed", "access-denied"]).toContain(
          (failed as { reason: string }).reason,
        );
      }),
    ),
  );
  it.live("never reactivates another project's archive of the same folder", () =>
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
        yield* w.service.disconnect({
          caller: w.at(w.main),
          connectionId: connected.connection.connectionId,
          requestId: "d1",
        });
        // The same checkout is registered again, under another host project.
        w.bindings.set(w.main, {
          bindingId: "binding-main-2",
          hostProjectId: "project-2",
          generation: 1,
        });
        const again = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: false,
          project: PROJECT,
          requestId: "c2",
        });
        if (again._tag !== "connected") return yield* Effect.die(again);
        expect(again.reconnected).toBe(false);
        expect(again.connection.connectionId).not.toBe(connected.connection.connectionId);
      }),
    ),
  );

  it.live("rechecks authority before connect creates a folder or disconnect archives", () =>
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
        w.revoke();
        expect(
          yield* w.service.connect({
            caller: w.at(w.main),
            folder: "other",
            create: true,
            project: OTHER_PROJECT,
            requestId: "c2",
          }),
        ).toMatchObject({ _tag: "refused", reason: "authority-changed" });
        expect(yield* Effect.promise(() => NodeFSP.readdir(w.main))).not.toContain("other");
        expect(
          yield* w.service.disconnect({
            caller: w.at(w.main),
            connectionId: connected.connection.connectionId,
            requestId: "d1",
          }),
        ).toMatchObject({ _tag: "refused", reason: "authority-changed" });
        const still = yield* w.store.readConnection(connected.connection.connectionId);
        expect(still).toMatchObject({ _tag: "ready", document: { state: "active" } });
      }),
    ),
  );

  it.live("answers repeated requests with their recorded results", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const first = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "papers/one",
          create: true,
          project: PROJECT,
          requestId: "c1",
        });
        expect(first).toMatchObject({ _tag: "refused", reason: "folder-missing" });
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(w.main, "papers")));
        expect(
          yield* w.service.connect({
            caller: w.at(w.main),
            folder: "papers/one",
            create: true,
            project: PROJECT,
            requestId: "c1",
          }),
        ).toMatchObject({ _tag: "refused", reason: "folder-missing" });
        const connected = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "papers/one",
          create: true,
          project: PROJECT,
          requestId: "c2",
        });
        if (connected._tag !== "connected") return yield* Effect.die(connected);
        const id = connected.connection.connectionId;
        // A client request ID can never be one the service made for itself.
        expect(
          yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s1" }),
        ).toMatchObject({ _tag: "synced" });
        expect(
          yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s1-0-0" }),
        ).toMatchObject({ _tag: "synced" });
        // A repeated disconnect after a reconnect does not archive again.
        yield* w.service.disconnect({ caller: w.at(w.main), connectionId: id, requestId: "d1" });
        yield* w.service.connect({
          caller: w.at(w.main),
          folder: "papers/one",
          create: false,
          project: PROJECT,
          requestId: "c3",
        });
        expect(
          yield* w.service.disconnect({ caller: w.at(w.main), connectionId: id, requestId: "d1" }),
        ).toMatchObject({
          _tag: "done",
          connection: { state: "active" },
        });
      }),
    ),
  );

  it.live("relink keeps one link per Overleaf project in a checkout", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world();
        const inMain = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "c1",
        });
        const inWorktree = yield* w.service.connect({
          caller: w.at(w.worktree),
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "c2",
        });
        if (inMain._tag !== "connected" || inWorktree._tag !== "connected")
          return yield* Effect.die("not connected");
        yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(w.main, "copy")));
        expect(
          yield* w.service.relink({
            caller: w.at(w.main),
            connectionId: inWorktree.connection.connectionId,
            folder: "copy",
            requestId: "r1",
          }),
        ).toMatchObject({ _tag: "refused", reason: "project-already-linked" });
      }),
    ),
  );

  it.live("cancels a sync at its next stage boundary", () =>
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
        const id = connected.connection.connectionId;
        expect(yield* w.service.cancel({ caller: w.at(w.main), connectionId: id })).toEqual({
          _tag: "nothing-running",
        });
        w.onActivity(() =>
          Effect.asVoid(Effect.orDie(w.service.cancel({ caller: w.at(w.main), connectionId: id }))),
        );
        expect(
          yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s1" }),
        ).toMatchObject({
          _tag: "cancelled",
          stage: "before-prepare",
        });
        expect(yield* read(NodePath.join(w.main, "paper"), "main.tex")).toBe(null);
      }),
    ),
  );
  it.live("never runs a management request again whose result was not recorded", () =>
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
        const id = connected.connection.connectionId;
        // A disconnect that began and stopped before recording its result.
        yield* w.store.admitWritable;
        yield* w.store.beginReceipt({
          schemaVersion: 1,
          connectionId: id,
          requestId: "d1",
          kind: "disconnect",
          payloadDigest: NodeCrypto.createHash("sha256")
            .update(["disconnect", "binding-main"].join("\0"))
            .digest("hex"),
          operationId: "op-1",
          status: "running",
          resultCategory: null,
          createdAt: "2026-10-24T00:00:00.000Z",
          updatedAt: "2026-10-24T00:00:00.000Z",
        });
        expect(
          yield* w.service.disconnect({ caller: w.at(w.main), connectionId: id, requestId: "d1" }),
        ).toMatchObject({
          _tag: "refused",
          reason: "request-incomplete",
        });
        expect(yield* w.store.readConnection(id)).toMatchObject({ document: { state: "active" } });
        // Refused input is recorded too: the same request ID cannot be reused for other input.
        expect(
          yield* w.service.connect({
            caller: w.at(w.main),
            folder: "../bad",
            create: true,
            project: PROJECT,
            requestId: "c9",
          }),
        ).toMatchObject({ _tag: "refused", reason: "folder-invalid" });
        expect(
          yield* Effect.flip(
            w.service.connect({
              caller: w.at(w.main),
              folder: "good",
              create: true,
              project: OTHER_PROJECT,
              requestId: "c9",
            }),
          ),
        ).toMatchObject({ _tag: "OverleafRequestReusedError" });
      }),
    ),
  );

  it.live("keeps a running sync cancellable when a competing sync is refused", () =>
    run(
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let pause = false;
        const w = yield* world({
          overleaf: { [PROJECT]: { "main.tex": "A" } },
          at: (point) =>
            point === "admitting" && pause
              ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
        });
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
        yield* write(NodePath.join(w.main, "paper"), { "main.tex": "A, edited" });
        pause = true;
        const first = yield* Effect.forkChild(
          w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s2" }),
        );
        yield* Deferred.await(reached);
        expect(
          yield* Effect.flip(
            w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s3" }),
          ),
        ).toMatchObject({ _tag: "OverleafOperationActiveError" });
        expect(yield* w.service.cancel({ caller: w.at(w.main), connectionId: id })).toMatchObject({
          _tag: "requested",
        });
        yield* Deferred.succeed(release, undefined);
        // Past its last boundary, the send finishes and stands.
        expect(yield* Fiber.join(first)).toMatchObject({
          _tag: "synced",
          publication: { _tag: "accepted" },
        });
      }),
    ),
  );

  it.live("refuses to link while a connection record cannot be read", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          overleaf: { [PROJECT]: { "a.tex": "A" }, [OTHER_PROJECT]: { "b.tex": "B" } },
        });
        const connected = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "c1",
        });
        if (connected._tag !== "connected") return yield* Effect.die(connected);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(w.stateRoot, "connections", `${connected.connection.connectionId}.json`),
            "{ not json",
          ),
        );
        expect(
          yield* w.service.connect({
            caller: w.at(w.main),
            folder: "paper",
            create: false,
            project: PROJECT,
            requestId: "c2",
          }),
        ).toMatchObject({ _tag: "refused", reason: "records-unreadable" });
      }),
    ),
  );

  it.live("lists a connection only for the project that owns its recorded binding", () =>
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
        expect(yield* w.service.list(w.at(w.main))).toMatchObject([
          { connectionId: connected.connection.connectionId, linkedHere: true },
        ]);
        // The same path registered again under another project does not inherit the link.
        w.bindings.set(w.main, {
          bindingId: "binding-main-b",
          hostProjectId: "project-2",
          generation: 1,
        });
        expect(yield* w.service.list(w.at(w.main))).toEqual([]);
      }),
    ),
  );
  it.live("asks again when Overleaf moved after the conflict was decided", () =>
    run(
      Effect.gen(function* () {
        let moveOverleaf: Effect.Effect<void> = Effect.void;
        let armed = false;
        const w = yield* world({
          overleaf: { [PROJECT]: { "main.tex": "line\n" } },
          at: (point) =>
            point === "admitting" && armed
              ? Effect.suspend(() => {
                  armed = false;
                  return moveOverleaf;
                })
              : Effect.void,
        });
        moveOverleaf = Effect.orDie(
          w.collaborate(PROJECT, { "main.tex": "theirs-v2-unreviewed\n" }),
        );
        const connected = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "c1",
        });
        if (connected._tag !== "connected") return yield* Effect.die(connected);
        const id = connected.connection.connectionId;
        const folder = NodePath.join(w.main, "paper");
        yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s1" });
        yield* write(folder, { "main.tex": "mine\n", "other.tex": "new" });
        yield* w.collaborate(PROJECT, { "main.tex": "theirs-v1\n" });
        const stopped = yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s2",
        });
        if (stopped._tag !== "needs-decision") return yield* Effect.die(stopped);
        // Overleaf moves again while the decided sync is sending.
        armed = true;
        const decided = yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s3",
          choices: new Map([[stopped.review.conflicts[0]!.key, "mine"]]),
          reviewedRemote: stopped.review.remoteTree,
        });
        expect(decided).toMatchObject({ _tag: "needs-decision", review: { needsDecision: true } });
        expect((yield* w.overleafNow(PROJECT))["main.tex"]).toBe("theirs-v2-unreviewed\n");
      }),
    ),
  );

  it.live("holds the connection for the whole sync, so a disconnect cannot slip in", () =>
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
        const id = connected.connection.connectionId;
        let refused: unknown = null;
        w.onActivity(() =>
          // Another request, in its own context: it does not hold the sync's reservation.
          Effect.flip(
            w.service
              .disconnect({ caller: w.at(w.main), connectionId: id, requestId: "d1" })
              .pipe(Effect.provideService(OverleafReservationOwner, null)),
          ).pipe(
            Effect.tap((error) => Effect.sync(() => (refused = error))),
            Effect.ignore,
          ),
        );
        expect(
          yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s1" }),
        ).toMatchObject({ _tag: "synced" });
        expect(refused).toMatchObject({ _tag: "OverleafOperationActiveError" });
        expect(yield* w.store.readConnection(id)).toMatchObject({ document: { state: "active" } });
        // A refused relink folder is recorded too.
        w.onActivity(() => Effect.void);
        expect(
          yield* w.service.relink({
            caller: w.at(w.main),
            connectionId: id,
            folder: "../bad",
            requestId: "r1",
          }),
        ).toMatchObject({ _tag: "refused", reason: "folder-invalid" });
        expect(
          yield* Effect.flip(
            w.service.relink({
              caller: w.at(w.main),
              connectionId: id,
              folder: "paper",
              requestId: "r1",
            }),
          ),
        ).toMatchObject({ _tag: "OverleafRequestReusedError" });
      }),
    ),
  );
  it.live("keeps a new file only here when asked, and lists what the rule skips", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ overleaf: { [PROJECT]: { "main.tex": "A" } } });
        const connected = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "c1",
        });
        if (connected._tag !== "connected") return yield* Effect.die(connected);
        const id = connected.connection.connectionId;
        yield* write(NodePath.join(w.main, "paper"), {
          "notes.txt": "mine",
          "fig.tex": "F",
          ".latexmkrc": "x",
        });
        const kept = yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s1",
          files: { keepOnlyHere: ["notes.txt"] },
        });
        if (kept._tag !== "synced") return yield* Effect.die(kept);
        expect(kept.publication).toMatchObject({ _tag: "accepted" });
        expect(Object.keys(yield* w.overleafNow(PROJECT)).sort()).toEqual(["fig.tex", "main.tex"]);
        expect(kept.review.additions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: ".latexmkrc",
              selected: false,
              skippedBecause: "hidden",
            }),
          ]),
        );
      }),
    ),
  );

  it.live("sends a file kept only here and a file the rule skips when asked", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ overleaf: { [PROJECT]: { "main.tex": "A" } } });
        const connected = yield* w.service.connect({
          caller: w.at(w.main),
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "c1",
        });
        if (connected._tag !== "connected") return yield* Effect.die(connected);
        const id = connected.connection.connectionId;
        yield* write(NodePath.join(w.main, "paper"), { "notes.txt": "mine", ".latexmkrc": "x" });
        yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s1",
          files: { keepOnlyHere: ["notes.txt"] },
        });
        const sent = yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s2",
          files: { send: ["notes.txt", ".latexmkrc"] },
        });
        expect(sent).toMatchObject({ _tag: "synced", publication: { _tag: "accepted" } });
        expect(Object.keys(yield* w.overleafNow(PROJECT)).sort()).toEqual([
          ".latexmkrc",
          "main.tex",
          "notes.txt",
        ]);
      }),
    ),
  );
  it.live("refuses to sync a folder other than the one whose editors were saved", () =>
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
        const id = connected.connection.connectionId;
        expect(
          yield* Effect.flip(
            w.service.sync({
              caller: w.at(w.main),
              connectionId: id,
              requestId: "s1",
              savedFolder: { checkoutRoot: w.main, folder: "other" },
            }),
          ),
        ).toMatchObject({ _tag: "OverleafSyncRefusedError", reason: "folder-changed" });
        expect(
          yield* w.service.sync({
            caller: w.at(w.main),
            connectionId: id,
            requestId: "s2",
            savedFolder: { checkoutRoot: w.main, folder: "paper" },
          }),
        ).toMatchObject({ _tag: "synced" });
      }),
    ),
  );
});
