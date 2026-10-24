// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * The step-5 service against a real local bare repository standing in for
 * Overleaf: connecting, the "only a conflict stops" sync, authority across
 * worktrees, the other-agents line, offline status, disconnect and relink.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";
import { WorkspaceBindingStore } from "../projectScope/WorkspaceBindingStore.ts";
import {
  fileExchangeTestHelper,
  filePublicationTestHelper,
} from "../workspace/fileExchange.testkit.ts";
import { canApply } from "./OverleafCoordinator.testkit.ts";
import * as OverleafGitExecutor from "./OverleafGitExecutor.ts";
import * as OverleafRepository from "./OverleafRepository.ts";
import * as OverleafStateStore from "./OverleafStateStore.ts";
import { makeOverleafSync, type OverleafCaller } from "./OverleafSync.ts";
import { make as makeApplier, WorkspaceApplier } from "./WorkspaceApplier.ts";
import { makeApplierFiles } from "./WorkspaceApplier.files.testkit.ts";

const VOLUME = "0A1B2C3D-0000-4000-8000-000000000001";
const PROJECT = "0123456789abcdef01234567";
const OTHER_PROJECT = "fedcba9876543210fedcba98";
const TOKEN = "test-token";

const write = (folder: string, files: Record<string, string>) =>
  Effect.promise(async () => {
    for (const [path, content] of Object.entries(files)) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(folder, path)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(folder, path), content);
    }
  });
const read = (folder: string, path: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(folder, path), "utf8").catch(() => null));

type Thread = {
  readonly threadId: string;
  readonly title: string;
  readonly checkoutPath: string;
  readonly parentThreadId: string | null;
  readonly subagent: boolean;
};

/**
 * Two registered checkouts of one host project (`main` and a worktree), a third
 * project, an Overleaf per project ID, and the service over all of it.
 */
const world = (input?: {
  readonly overleaf?: Record<string, Record<string, string>>;
  readonly at?: (point: string) => Effect.Effect<void>;
  readonly withToken?: boolean;
}) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(async () =>
        NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-sync-"))),
      ),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const main = NodePath.join(root, "main");
    const worktree = NodePath.join(root, "worktree");
    const elsewhere = NodePath.join(root, "elsewhere");
    const stateRoot = NodePath.join(root, "state");
    yield* Effect.promise(async () => {
      for (const checkout of [main, worktree, elsewhere])
        await NodeFSP.mkdir(NodePath.join(checkout, ".git"), { recursive: true });
      await NodeFSP.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    });

    const git = yield* OverleafGitExecutor.make({
      runtimeRoot: NodePath.join(root, "runtime"),
      allowLocalProtocols: true,
    });
    const repos = yield* OverleafRepository.make.pipe(
      Effect.provideService(OverleafGitExecutor.OverleafGitExecutor, git),
    );
    const store = yield* OverleafStateStore.make({
      root: stateRoot,
      volumeUuid: async () => VOLUME,
    });
    const helper = yield* Effect.promise(() => filePublicationTestHelper());
    const exchangeHelper = (yield* Effect.promise(() => fileExchangeTestHelper())) ?? null;
    const files = yield* makeApplierFiles({ root, helper, retainedHooks: {} });
    const applier = yield* makeApplier().pipe(Effect.provideService(WorkspaceFileSystem, files));

    // One bare repository per Overleaf project, with a collaborator clone to change it.
    const token = new TextEncoder().encode(TOKEN);
    const overleafFor = (projectId: string) => NodePath.join(root, `overleaf-${projectId}.git`);
    const collaboratorFor = (projectId: string) => NodePath.join(root, `collab-${projectId}.git`);
    const collaborate = Effect.fnUntraced(function* (
      projectId: string,
      contents: Record<string, string>,
    ) {
      const collaborator = collaboratorFor(projectId);
      const current = yield* repos
        .fetch({ repo: collaborator, branch: "master", token })
        .pipe(Effect.option);
      const entries = [];
      for (const [path, content] of Object.entries(contents))
        entries.push({
          path,
          oid: yield* repos.writeBlob({
            repo: collaborator,
            bytes: new TextEncoder().encode(content),
          }),
        });
      const commit = yield* repos.commit({
        repo: collaborator,
        tree: yield* repos.writeTree({ repo: collaborator, entries }),
        parents: Option.isSome(current) ? [current.value.commit] : [],
        message: "collaborator",
      });
      const pushed = yield* repos.push({ repo: collaborator, commit, branch: "master", token });
      if (pushed._tag !== "accepted") return yield* Effect.die(pushed);
    });
    const overleafNow = Effect.fnUntraced(function* (projectId: string) {
      const collaborator = collaboratorFor(projectId);
      const now = yield* repos.fetch({ repo: collaborator, branch: "master", token });
      const contents: Record<string, string> = {};
      for (const entry of yield* repos.readTree({ repo: collaborator, tree: now.tree }))
        contents[entry.path] = new TextDecoder().decode(
          yield* repos.readBlob({ repo: collaborator, oid: entry.oid, maxBytes: 1024 * 1024 }),
        );
      return contents;
    });
    for (const [projectId, contents] of Object.entries(
      input?.overleaf ?? { [PROJECT]: { "main.tex": "from Overleaf" } },
    )) {
      yield* git.execute({
        cwd: root,
        args: ["init", "-q", "--bare", "-b", "master", overleafFor(projectId)],
      });
      yield* repos.initialize({ repo: collaboratorFor(projectId), gitUrl: overleafFor(projectId) });
      yield* collaborate(projectId, contents);
    }

    // Workspace authority: `main` and `worktree` are one host project; `elsewhere` is another.
    const bindings = new Map([
      [main, { bindingId: "binding-main", hostProjectId: "project-1", generation: 1 }],
      [worktree, { bindingId: "binding-worktree", hostProjectId: "project-1", generation: 1 }],
      [elsewhere, { bindingId: "binding-elsewhere", hostProjectId: "project-2", generation: 1 }],
    ]);
    const threadRoots = new Map<string, string>();
    // Every binding ever issued, by ID, as the binding store keeps them.
    const issued = new Map<string, { hostProjectId: string }>();
    const record = (workspaceRoot: string) => {
      const binding = bindings.get(workspaceRoot);
      if (binding === undefined) return undefined;
      issued.set(binding.bindingId, { hostProjectId: binding.hostProjectId });
      return {
        bindingId: binding.bindingId,
        environmentId: "environment-1",
        hostProjectId: binding.hostProjectId,
        canonicalRoot: workspaceRoot,
        authorityGeneration: binding.generation,
      };
    };
    const resolve = (workspaceRoot: string) => {
      const found = record(workspaceRoot);
      if (found === undefined)
        return Effect.fail({ _tag: "WorkspaceBindingResolutionError" } as never);
      return Effect.succeed({
        binding: found,
        relation: "only-binding",
        relatedBindingCount: 0,
        scopeRevision: 1,
      } as never);
    };
    let revoked = false;
    const current = (input: {
      readonly workspaceRoot: string;
      readonly bindingId: string;
      readonly authorityGeneration: number;
    }) => {
      const found = record(input.workspaceRoot);
      return !revoked &&
        found !== undefined &&
        found.bindingId === input.bindingId &&
        found.authorityGeneration === input.authorityGeneration
        ? Effect.succeed(found as never)
        : Effect.fail({ _tag: "WorkspaceBindingStoreError" } as never);
    };
    const resolver = WorkspaceBindingResolver.of({
      resolveWorkspaceRoot: resolve,
      resolveThread: (threadId) => resolve(threadRoots.get(threadId) ?? ""),
      assertCurrentWorkspaceScope: (input) => current(input),
      resolveTrustedChild: () => Effect.die("unused"),
      assertCurrentThreadScope: (input) =>
        current({ ...input, workspaceRoot: threadRoots.get(input.threadId) ?? "" }),
      diagnosticsForThread: () => Effect.die("unused"),
    });
    for (const root of bindings.keys()) record(root);
    const bindingStore = {
      getById: (bindingId: string) =>
        Effect.sync(() => {
          const found = issued.get(bindingId);
          return found === undefined
            ? null
            : ({
                bindingId,
                environmentId: "environment-1",
                hostProjectId: found.hostProjectId,
              } as never);
        }),
    } as unknown as WorkspaceBindingStore["Service"];
    const secretValues = new Map<string, Uint8Array>();
    if (input?.withToken !== false) secretValues.set("token", new TextEncoder().encode(TOKEN));
    const secrets = ServerSecretStore.of({
      get: () => Effect.sync(() => Option.fromNullishOr(secretValues.get("token"))),
      set: (_name, value) => Effect.sync(() => void secretValues.set("token", value)),
      create: (_name, value) => Effect.sync(() => void secretValues.set("token", value)),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: () => Effect.sync(() => void secretValues.delete("token")),
    });

    let threads: ReadonlyArray<Thread> | null = [];
    let onActivity: () => Effect.Effect<void> = () => Effect.void;
    const service = yield* makeOverleafSync({
      stateRoot,
      environmentId: "environment-1",
      exchangeHelper,
      activeThreads: Effect.suspend(() => onActivity().pipe(Effect.map(() => threads))),
      gitUrl: overleafFor,
      volumeUuid: async () => VOLUME,
      hooks: { at: (point) => input?.at?.(point) ?? Effect.void },
    }).pipe(
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provideService(WorkspaceBindingResolver, resolver),
      Effect.provideService(WorkspaceBindingStore, bindingStore),
      Effect.provideService(OverleafStateStore.OverleafStateStore, store),
      Effect.provideService(OverleafRepository.OverleafRepository, repos),
      Effect.provideService(WorkspaceApplier, applier),
    );
    const at = (workspaceRoot: string): OverleafCaller => ({ _tag: "workspace", workspaceRoot });
    return {
      service,
      store,
      main,
      worktree,
      elsewhere,
      at,
      collaborate,
      overleafNow,
      overleafFor,
      bindings,
      threadRoots,
      setThreads: (next: ReadonlyArray<Thread> | null) => {
        threads = next;
      },
      /** Later authority checks fail, as if the binding were revoked after resolution. */
      revoke: () => {
        revoked = true;
      },
      onActivity: (next: () => Effect.Effect<void>) => {
        onActivity = next;
      },
    };
  });

const run = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

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
        collaborated = true;
        yield* w.service.sync({ caller: w.at(w.main), connectionId: id, requestId: "s1" });
        collaborated = false;
        yield* write(folder, { "main.tex": "A, edited here" });
        const synced = yield* w.service.sync({
          caller: w.at(w.main),
          connectionId: id,
          requestId: "s2",
        });
        expect(synced).toMatchObject({
          _tag: "synced",
          publication: { _tag: "accepted" },
          retried: true,
        });
        expect(yield* w.overleafNow(PROJECT)).toEqual({
          "main.tex": "A, edited here",
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
        const bad = yield* Effect.exit(
          w.service.connect({
            caller: w.at(w.main),
            folder: "x",
            create: true,
            project: "https://evil.example/project/1",
            requestId: "c9",
          }),
        );
        expect(Exit.isFailure(bad)).toBe(true);
        expect(
          yield* Effect.flip(
            w.service.connect({
              caller: w.at(w.main),
              folder: "x",
              create: true,
              project: "https://evil.example/project/1",
              requestId: "c10",
            }),
          ),
        ).toMatchObject({ reason: "project-invalid" });
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
});
