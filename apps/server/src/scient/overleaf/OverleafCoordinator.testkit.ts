import * as HostProcess from "@t3tools/shared/HostProcess";
import { platformFileIdentity } from "../workspace/PlatformFileIdentity.ts";
import { ensureNativePrivateRetentionDirectory } from "../workspace/NativeFilePublication.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * A connected folder for coordinator tests: real folders, a real private
 * repository, the real applier and an Overleaf that is either scripted or a
 * real local bare repository reached by real fetch and push.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import {
  CheckoutBarrier,
  type CheckoutBarrierShape,
  makeCheckoutBarrier,
} from "../workspace/CheckoutBarrier.ts";
import {
  filePublicationTestHelper,
  nativePublicationHost,
} from "../workspace/fileExchange.testkit.ts";
import { bytesRevision, type MutationPoint } from "../workspace/RetainedFileMutation.ts";
import * as OverleafCoordinator from "./OverleafCoordinator.ts";
import { overleafConnectionFixture } from "./OverleafConnectionState.testkit.ts";
import * as OverleafGitExecutor from "./OverleafGitExecutor.ts";
import * as OverleafRepository from "./OverleafRepository.ts";
import { makeOverleafReviewRegistry } from "./OverleafReviewRegistry.ts";
import * as OverleafStateStore from "./OverleafStateStore.ts";
import { make as makeApplier, WorkspaceApplier } from "./WorkspaceApplier.ts";
import { makeApplierFiles } from "./WorkspaceApplier.files.testkit.ts";

export const canApply = await nativePublicationHost();
const VOLUME = "0A1B2C3D-0000-4000-8000-000000000001";
const volumeUuid = async (path: string) =>
  HostProcess.Platform.defaultValue() === "win32" ? platformFileIdentity.volume(path) : VOLUME;
export const CONNECTION = "connection-1";
const TOKEN = new TextEncoder().encode("test-token");
export type Point = "linked" | "applied" | "adopted" | "recorded" | "admitting" | "sent";
type Push = Effect.Effect<
  OverleafRepository.PushOutcome,
  OverleafRepository.OverleafRepositoryError | OverleafGitExecutor.OverleafGitError
>;

export const write = (folder: string, files: Record<string, string>) =>
  Effect.promise(async () => {
    for (const [path, content] of Object.entries(files)) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(folder, path)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(folder, path), content);
    }
  });
export const read = (folder: string, path: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(folder, path), "utf8").catch(() => null));
export const revision = (text: string) => bytesRevision(new TextEncoder().encode(text));
/** The kept copy of the plan's first step, wherever the vault placed it. */
export const firstKept = (stateRoot: string) =>
  NodeFSP.readdir(stateRoot, { recursive: true }).then((paths) =>
    NodePath.join(
      stateRoot,
      paths.find((path) =>
        /\/step-0\/(?:slot|retained)$/u.test(path.replaceAll(NodePath.sep, "/")),
      )!,
    ),
  );

/**
 * A connected folder whose last sync left `synced` on both sides, and an
 * Overleaf that will next hold `remote`. Hooks run at the coordinator's points.
 */
export const world = (input: {
  readonly synced: Record<string, string>;
  readonly remote: Record<string, string>;
  /** Files only in the folder, recorded as local-only. */
  readonly localOnly?: Record<string, string>;
  /** Paths recorded as holding Scient conflict material. */
  readonly markerPaths?: ReadonlyArray<string>;
  /** The linked folder is the checkout's top instead of its `paper` folder. */
  readonly atCheckoutTop?: boolean;
  readonly at?: (point: Point) => Effect.Effect<void>;
  /** Runs at the native publication hooks of every step the applier takes. */
  readonly native?: (point: MutationPoint, folder: string, stateRoot: string) => Promise<void>;
  /** Runs just before the applier takes each step, with the step's path. */
  readonly beforeStep?: (path: string, folder: string) => Promise<void>;
  /** Wraps the real applier, to shape what it reports. */
  readonly applier?: (real: WorkspaceApplier["Service"]) => WorkspaceApplier["Service"];
  readonly limits?: OverleafCoordinator.OverleafCoordinatorOptions["limits"];
  /**
   * `git`: Overleaf is a local bare repository, reached by real fetch and push.
   * Otherwise a scripted head that accepts every push.
   */
  readonly overleaf?: "scripted" | "git";
  /** With `git`, stands between the coordinator and the real push, to shape what it reports. */
  readonly push?: (send: Push, commit: string) => Push;
  readonly credentialEpoch?: () => number;
  /** Wraps the checkout barrier the coordinator uses, to act inside its sections. */
  readonly barrier?: (real: CheckoutBarrierShape) => CheckoutBarrierShape;
}) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(async () =>
        NodeFSP.realpath(
          await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-coordinator-")),
        ),
      ),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const checkout = NodePath.join(root, "workspace");
    const folder = input.atCheckoutTop ? checkout : NodePath.join(checkout, "paper");
    const stateRoot = NodePath.join(root, "state");
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(NodePath.join(checkout, ".git"), { recursive: true });
      await NodeFSP.mkdir(folder, { recursive: true });
      if (HostProcess.Platform.defaultValue() === "win32")
        await ensureNativePrivateRetentionDirectory(
          (await filePublicationTestHelper())!,
          stateRoot,
        );
      else await NodeFSP.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    });
    yield* write(folder, input.synced);
    yield* write(folder, input.localOnly ?? {});

    const helper = yield* Effect.promise(() => filePublicationTestHelper());
    const publicationHelper = helper ?? null;
    const git = yield* OverleafGitExecutor.make({
      runtimeRoot: NodePath.join(root, "runtime"),
      allowLocalProtocols: true,
    });
    const repos = yield* OverleafRepository.make.pipe(
      Effect.provideService(OverleafGitExecutor.OverleafGitExecutor, git),
    );
    // The store has a scope of its own, so a restart can release its lease.
    let storeScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(storeScope, Exit.void));
    const store = yield* OverleafStateStore.make({ root: stateRoot, volumeUuid }).pipe(
      Scope.provide(storeScope),
    );
    const files = yield* makeApplierFiles({
      root,
      helper,
      retainedHooks: { at: async (point) => input.native?.(point, folder, stateRoot) },
    });
    const applier = yield* makeApplier({
      at: async (point, path) => {
        if (point === "before-step" && path !== undefined) await input.beforeStep?.(path, folder);
      },
    }).pipe(Effect.provideService(WorkspaceFileSystem, files));
    const barrier = makeCheckoutBarrier();
    const registry = makeOverleafReviewRegistry();

    const real = input.overleaf === "git";
    const overleaf = NodePath.join(root, "overleaf.git");
    const gitUrl = real ? overleaf : "https://git.overleaf.com/0123456789abcdef01234567";
    const repo = NodePath.join(stateRoot, "repositories", `${CONNECTION}.git`);
    yield* repos.initialize({ repo, gitUrl });
    const tree = Effect.fnUntraced(function* (at: string, contents: Record<string, string>) {
      const entries = [];
      for (const [path, content] of Object.entries(contents))
        entries.push({
          path,
          oid: yield* repos.writeBlob({ repo: at, bytes: new TextEncoder().encode(content) }),
        });
      return yield* repos.writeTree({ repo: at, entries });
    });

    // A collaborator's own clone of the real Overleaf, for changes made there.
    const collaborator = NodePath.join(root, "collaborator.git");
    /** Commits `contents` on Overleaf's current head (or as its first commit) and pushes it. */
    const collaborate = Effect.fnUntraced(function* (contents: Record<string, string>) {
      const current = yield* repos
        .fetch({ repo: collaborator, branch: "main", token: TOKEN })
        .pipe(Effect.option);
      const commit = yield* repos.commit({
        repo: collaborator,
        tree: yield* tree(collaborator, contents),
        parents: Option.isSome(current) ? [current.value.commit] : [],
        message: "collaborator",
      });
      const pushed = yield* repos.push({
        repo: collaborator,
        commit,
        branch: "main",
        token: TOKEN,
      });
      if (pushed._tag !== "accepted") return yield* Effect.die(pushed);
      return commit;
    });

    let synced: { commit: string; tree: string };
    if (real) {
      yield* git.execute({ cwd: root, args: ["init", "-q", "--bare", "-b", "main", overleaf] });
      yield* repos.initialize({ repo: collaborator, gitUrl: overleaf });
      yield* collaborate(input.synced);
      synced = yield* repos.fetch({ repo, branch: "main", token: TOKEN });
      const same =
        Object.keys(input.remote).length === Object.keys(input.synced).length &&
        Object.entries(input.remote).every(([path, content]) => input.synced[path] === content);
      if (!same) yield* collaborate(input.remote);
    } else {
      const syncedTree = yield* tree(repo, input.synced);
      synced = {
        tree: syncedTree,
        commit: yield* repos.commit({
          repo,
          tree: syncedTree,
          parents: [],
          message: "synced",
        }),
      };
    }

    let remote = input.remote;
    // Overleaf's head stays the same commit until its content changes, or a push
    // makes the pushed commit its head.
    let head: { commit: string; tree: string } | undefined;
    let pushedHead = false;
    const pushes: string[] = [];
    const scriptedFetch = () =>
      Effect.gen(function* () {
        if (pushedHead && head) return head;
        const remoteTree = yield* tree(repo, remote);
        if (head?.tree !== remoteTree)
          head = {
            commit: yield* repos.commit({
              repo,
              tree: remoteTree,
              parents: [synced.commit],
              message: "remote",
            }),
            tree: remoteTree,
          };
        return head;
      });
    /** How many times the coordinator fetched Overleaf. */
    const fetches = { count: 0 };
    const fetchRemote: OverleafCoordinator.OverleafCoordinatorOptions["fetchRemote"] = (fetch) =>
      Effect.suspend(() => {
        fetches.count += 1;
        return real
          ? repos.fetch({ repo: fetch.repo, branch: "main", token: TOKEN })
          : scriptedFetch();
      });
    const remoteHead: OverleafCoordinator.OverleafCoordinatorOptions["remoteHead"] = (head) =>
      real
        ? repos.remoteHead({ repo: head.repo, branch: "main", token: TOKEN })
        : scriptedFetch().pipe(Effect.map((found) => found.commit));
    const pushRemote: OverleafCoordinator.OverleafCoordinatorOptions["pushRemote"] = (push) =>
      Effect.gen(function* () {
        pushes.push(push.commit);
        if (real) {
          const send = repos.push({
            repo: push.repo,
            commit: push.commit,
            branch: "main",
            token: TOKEN,
          });
          return yield* input.push ? input.push(send, push.commit) : send;
        }
        // The scripted Overleaf accepts every push: the commit becomes its head.
        head = { commit: push.commit, tree: yield* repos.treeOf({ repo, commit: push.commit }) };
        pushedHead = true;
        return { _tag: "accepted" as const };
      });

    const retention = yield* store.prepareRetention({
      environmentId: "environment-1",
      connectionId: CONNECTION,
      checkoutRoot: checkout,
      publicationHelper,
      expected: null,
    });
    const identity = (path: string) =>
      Effect.promise(async () =>
        HostProcess.Platform.defaultValue() === "win32"
          ? (await platformFileIdentity.directory(path))!
          : { volume: VOLUME, fileId: String((await NodeFSP.stat(path, { bigint: true })).ino) },
      );
    yield* store.createConnection({
      ...overleafConnectionFixture(CONNECTION),
      checkout: {
        canonicalRoot: checkout,
        identity: yield* identity(checkout),
      },
      folder: {
        relativePath: input.atCheckoutTop ? "" : "paper",
        identity: yield* identity(folder),
      },
      base: { commit: synced.commit, tree: synced.tree, generation: 1 },
      completedSyncCount: 1,
      managedPaths: Object.keys(input.synced),
      localOnlyPaths: Object.keys(input.localOnly ?? {}),
      markers: (input.markerPaths ?? []).map((path) => ({
        path,
        folderPaths: [],
        overleafPaths: [path],
      })),
      retention: { vaultIdentity: retention.identity, copies: [] },
    });

    const options = {
      stateRoot,
      publicationHelper,
      fetchRemote,
      remoteHead,
      pushRemote,
      gitUrl: () => gitUrl,
      volumeUuid,
      registry,
      ...(input.credentialEpoch ? { credentialEpoch: input.credentialEpoch } : {}),
    } satisfies OverleafCoordinator.OverleafCoordinatorOptions;
    const coordinatorWith = (stateStore: OverleafStateStore.OverleafStateStore["Service"]) =>
      OverleafCoordinator.make(options).pipe(
        Effect.provideService(OverleafStateStore.OverleafStateStore, stateStore),
        Effect.provideService(OverleafRepository.OverleafRepository, repos),
        Effect.provideService(WorkspaceApplier, applier),
        Effect.provideService(CheckoutBarrier, makeCheckoutBarrier()),
      );
    const coordinator = yield* OverleafCoordinator.make({
      ...options,
      hooks: { at: (point) => input.at?.(point) ?? Effect.void },
      ...(input.limits ? { limits: input.limits } : {}),
    }).pipe(
      Effect.provideService(OverleafStateStore.OverleafStateStore, store),
      Effect.provideService(OverleafRepository.OverleafRepository, repos),
      Effect.provideService(WorkspaceApplier, input.applier?.(applier) ?? applier),
      Effect.provideService(CheckoutBarrier, input.barrier?.(barrier) ?? barrier),
    );
    const connection = Effect.gen(function* () {
      const found = yield* store.readConnection(CONNECTION);
      if (found._tag !== "ready") return yield* Effect.die(found._tag);
      return found.document;
    });
    /** Prepares a review and confirms it exactly as offered. */
    const sync = (requestId = "request-1") =>
      Effect.gen(function* () {
        const prepared = yield* coordinator.prepare({ connectionId: CONNECTION });
        if (prepared._tag !== "review") return yield* Effect.die(prepared);
        return yield* coordinator.confirm({
          connectionId: CONNECTION,
          requestId,
          reviewId: prepared.review.id,
          digest: prepared.review.digest,
          acknowledgements: prepared.review.binding.acknowledgements,
        });
      });
    /** With `git`: Overleaf's head and its files. */
    const overleafNow = Effect.gen(function* () {
      const now = yield* repos.fetch({ repo: collaborator, branch: "main", token: TOKEN });
      const contents: Record<string, string> = {};
      for (const entry of yield* repos.readTree({ repo: collaborator, tree: now.tree }))
        contents[entry.path] = new TextDecoder().decode(
          yield* repos.readBlob({ repo: collaborator, oid: entry.oid, maxBytes: 1024 * 1024 }),
        );
      return { ...now, contents };
    });
    return {
      store,
      coordinatorWith,
      volumeUuid,
      stateRoot,
      checkout,
      folder,
      repo,
      repos,
      coordinator,
      barrier,
      registry,
      connection,
      sync,
      pushes,
      fetches,
      overleafNow,
      /** Scripted: Overleaf's next head. */
      setRemote: (next: Record<string, string>) => {
        remote = next;
        pushedHead = false;
      },
      /** With `git`: a collaborator's commit of `contents` on Overleaf's head. */
      collaborate,
      /**
       * A server restart: the store's lease is released and a new store and coordinator,
       * with nothing in memory, take over the same state folder.
       */
      restart: Effect.fnUntraced(function* () {
        yield* Scope.close(storeScope, Exit.void);
        storeScope = yield* Scope.make();
        const next = yield* OverleafStateStore.make({ root: stateRoot, volumeUuid }).pipe(
          Scope.provide(storeScope),
        );
        // Reviews live in memory: none survives a restart.
        const coordinator = yield* OverleafCoordinator.make({
          ...options,
          registry: makeOverleafReviewRegistry(),
        }).pipe(
          Effect.provideService(OverleafStateStore.OverleafStateStore, next),
          Effect.provideService(OverleafRepository.OverleafRepository, repos),
          Effect.provideService(WorkspaceApplier, applier),
          Effect.provideService(CheckoutBarrier, makeCheckoutBarrier()),
        );
        return { store: next, coordinator };
      }),
      /** Drops every object of the private repository that no ref reaches. */
      collectGarbage: Effect.gen(function* () {
        yield* git.execute({ cwd: repo, args: ["reflog", "expire", "--expire=now", "--all"] });
        yield* git.execute({ cwd: repo, args: ["gc", "-q", "--prune=now"] });
      }),
      /** With `git`: replaces Overleaf's history with commits of `chain`, oldest first (forced). */
      rewriteHistory: Effect.fnUntraced(function* (chain: ReadonlyArray<Record<string, string>>) {
        let last: string | undefined;
        for (const contents of chain)
          last = yield* repos.commit({
            repo: collaborator,
            tree: yield* tree(collaborator, contents),
            parents: last === undefined ? [] : [last],
            message: "rewritten",
          });
        yield* git.execute({
          cwd: root,
          args: [
            "--git-dir",
            collaborator,
            "push",
            "-q",
            "--force",
            overleaf,
            `${last}:refs/heads/main`,
          ],
        });
      }),
    };
  });

export const run = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.scoped, Effect.provide(NodeServices.layer));
