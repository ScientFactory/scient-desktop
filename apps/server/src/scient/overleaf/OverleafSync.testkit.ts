import * as HostProcess from "@t3tools/shared/HostProcess";
import { ensureNativePrivateRetentionDirectory } from "../workspace/NativeFilePublication.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * The step-5 service over a real local bare repository standing in for
 * Overleaf, shared by the service tests and the agent-tool tests: two
 * checkouts of one host project (`main` and a worktree), a third project, an
 * Overleaf per project ID with a collaborator clone, and a fake secret store.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import { WorkspaceBindingResolver } from "../projectScope/WorkspaceBindingResolver.ts";
import { WorkspaceBindingStore } from "../projectScope/WorkspaceBindingStore.ts";
import { filePublicationTestHelper } from "../workspace/fileExchange.testkit.ts";
import { OverleafEditorSave, type OverleafEditorSaveResult } from "./OverleafEditorSave.ts";
import * as OverleafGitExecutor from "./OverleafGitExecutor.ts";
import * as OverleafRepository from "./OverleafRepository.ts";
import * as OverleafStateStore from "./OverleafStateStore.ts";
import { makeOverleafSync, type OverleafCaller } from "./OverleafSync.ts";
import { make as makeApplier, WorkspaceApplier } from "./WorkspaceApplier.ts";
import { makeApplierFiles } from "./WorkspaceApplier.files.testkit.ts";

const VOLUME = "0A1B2C3D-0000-4000-8000-000000000001";
export const PROJECT = "0123456789abcdef01234567";
export const OTHER_PROJECT = "fedcba9876543210fedcba98";
export const TOKEN = "test-token";

export const write = (folder: string, files: Record<string, string>) =>
  Effect.promise(async () => {
    for (const [path, content] of Object.entries(files)) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(folder, path)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(folder, path), content);
    }
  });
export const read = (folder: string, path: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(folder, path), "utf8").catch(() => null));

export type OverleafTestThread = {
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
export const overleafSyncWorld = (input?: {
  readonly overleaf?: Record<string, Record<string, string>>;
  readonly at?: (point: string) => Effect.Effect<void>;
  /** Runs just before the applier writes `path` into `folder` (the main copy's `paper`). */
  readonly beforeStep?: (path: string, folder: string) => Promise<void>;
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
      if (HostProcess.Platform.defaultValue() === "win32")
        await ensureNativePrivateRetentionDirectory(
          (await filePublicationTestHelper())!,
          stateRoot,
        );
      else await NodeFSP.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    });

    const git = yield* OverleafGitExecutor.make({
      runtimeRoot: NodePath.join(root, "runtime"),
      allowLocalProtocols: true,
    });
    const repos = yield* OverleafRepository.make.pipe(
      Effect.provideService(OverleafGitExecutor.OverleafGitExecutor, git),
    );
    const helper = yield* Effect.promise(() => filePublicationTestHelper());
    const store = yield* OverleafStateStore.make({
      root: stateRoot,
      publicationHelper: helper,
      volumeUuid: async () => VOLUME,
    });
    const publicationHelper = helper ?? null;
    const files = yield* makeApplierFiles({ root, helper, retainedHooks: {} });
    const applier = yield* makeApplier({
      at: async (point, path) => {
        if (point === "before-step" && path !== undefined)
          await input?.beforeStep?.(path, NodePath.join(main, "paper"));
      },
    }).pipe(Effect.provideService(WorkspaceFileSystem, files));

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

    // The editor-save request: every window saves, unless a test says otherwise.
    let editorResult: OverleafEditorSaveResult = { _tag: "saved" };
    let whileSaving: Effect.Effect<void> = Effect.void;
    const editorSaves: Array<{ readonly checkoutRoot: string; readonly folder: string }> = [];
    const editors = OverleafEditorSave.of({
      saveFolder: (input) =>
        Effect.suspend(() => {
          editorSaves.push({ checkoutRoot: input.checkoutRoot, folder: input.folder });
          return Effect.as(whileSaving, editorResult);
        }),
    });

    let threads: ReadonlyArray<OverleafTestThread> | null = [];
    let onActivity: () => Effect.Effect<void> = () => Effect.void;
    const service = yield* makeOverleafSync({
      stateRoot,
      environmentId: "environment-1",
      publicationHelper,
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
      Effect.provideService(OverleafEditorSave, editors),
    );
    const at = (workspaceRoot: string): OverleafCaller => ({ _tag: "workspace", workspaceRoot });
    return {
      service,
      store,
      stateRoot,
      main,
      worktree,
      elsewhere,
      at,
      collaborate,
      overleafNow,
      overleafFor,
      bindings,
      threadRoots,
      /** Each folder whose open editors the service asked every window to save, in order. */
      editorSaves,
      /** What the next requests to save editors answer, and what runs while they save. */
      setEditorSave: (
        next: OverleafEditorSaveResult,
        during: Effect.Effect<void> = Effect.void,
      ) => {
        editorResult = next;
        whileSaving = during;
      },
      setThreads: (next: ReadonlyArray<OverleafTestThread> | null) => {
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

export const runOverleafSync = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.scoped, Effect.provide(NodeServices.layer));
