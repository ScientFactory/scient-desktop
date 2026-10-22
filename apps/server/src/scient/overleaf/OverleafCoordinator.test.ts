// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * The coordinator's local half on real folders, a real private repository, the
 * real applier and a scripted Overleaf. A throwing hook stands in for a crash
 * between the coordinator's durable steps: nothing at this level compensates.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import {
  CheckoutBarrier,
  type CheckoutLookupError,
  type CheckoutRecoveryRequiredError,
  makeCheckoutBarrier,
} from "../workspace/CheckoutBarrier.ts";
import {
  fileExchangeTestHelper,
  filePublicationTestHelper,
  nativePublicationHost,
} from "../workspace/fileExchange.testkit.ts";
import * as OverleafCoordinator from "./OverleafCoordinator.ts";
import { overleafConnectionFixture } from "./OverleafConnectionState.testkit.ts";
import * as OverleafGitExecutor from "./OverleafGitExecutor.ts";
import * as OverleafRepository from "./OverleafRepository.ts";
import { makeOverleafReviewRegistry } from "./OverleafReviewRegistry.ts";
import * as OverleafStateStore from "./OverleafStateStore.ts";
import { make as makeApplier, WorkspaceApplier } from "./WorkspaceApplier.ts";
import { makeApplierFiles } from "./WorkspaceApplier.files.testkit.ts";
import type { MutationPoint } from "../workspace/RetainedFileMutation.ts";

const canApply = await nativePublicationHost();
const VOLUME = "0A1B2C3D-0000-4000-8000-000000000001";
const volumeUuid = async () => VOLUME;
const CONNECTION = "connection-1";
type Point = "linked" | "applied" | "adopted";

const write = (folder: string, files: Record<string, string>) =>
  Effect.promise(async () => {
    for (const [path, content] of Object.entries(files)) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(folder, path)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(folder, path), content);
    }
  });
const read = (folder: string, path: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(folder, path), "utf8").catch(() => null));

/**
 * A connected folder whose last sync left `synced` on both sides, and an
 * Overleaf that will next hold `remote`. Hooks run at the coordinator's points.
 */
const world = (input: {
  readonly synced: Record<string, string>;
  readonly remote: Record<string, string>;
  readonly at?: (point: Point) => Promise<void>;
  /** Runs at the native publication hooks of every step the applier takes. */
  readonly native?: (point: MutationPoint, folder: string) => Promise<void>;
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
    const folder = NodePath.join(checkout, "paper");
    const stateRoot = NodePath.join(root, "state");
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(NodePath.join(checkout, ".git"), { recursive: true });
      await NodeFSP.mkdir(folder);
      await NodeFSP.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    });
    yield* write(folder, input.synced);

    const helper = yield* Effect.promise(() => filePublicationTestHelper());
    // The retention probe runs the exchange helper; the applier publishes through the other.
    const exchangeHelper = (yield* Effect.promise(() => fileExchangeTestHelper())) ?? null;
    const git = yield* OverleafGitExecutor.make({
      runtimeRoot: NodePath.join(root, "runtime"),
      allowLocalProtocols: true,
    });
    const repos = yield* OverleafRepository.make.pipe(
      Effect.provideService(OverleafGitExecutor.OverleafGitExecutor, git),
    );
    const store = yield* OverleafStateStore.make({ root: stateRoot, volumeUuid });
    const files = yield* makeApplierFiles({
      root,
      helper,
      retainedHooks: { at: async (point) => input.native?.(point, folder) },
    });
    const applier = yield* makeApplier().pipe(Effect.provideService(WorkspaceFileSystem, files));
    const barrier = makeCheckoutBarrier();
    const registry = makeOverleafReviewRegistry();

    const repo = NodePath.join(stateRoot, "repositories", `${CONNECTION}.git`);
    yield* repos.initialize({ repo, gitUrl: "https://git.overleaf.com/0123456789abcdef01234567" });
    const tree = Effect.fnUntraced(function* (contents: Record<string, string>) {
      const entries = [];
      for (const [path, content] of Object.entries(contents))
        entries.push({
          path,
          oid: yield* repos.writeBlob({ repo, bytes: new TextEncoder().encode(content) }),
        });
      return yield* repos.writeTree({ repo, entries });
    });
    const syncedTree = yield* tree(input.synced);
    const syncedCommit = yield* repos.commit({
      repo,
      tree: syncedTree,
      parents: [],
      message: "synced",
    });
    let remote = input.remote;
    // Overleaf's head stays the same commit until its content changes.
    let head: { commit: string; tree: string } | undefined;
    const fetchRemote = () =>
      Effect.gen(function* () {
        const remoteTree = yield* tree(remote);
        if (head?.tree !== remoteTree)
          head = {
            commit: yield* repos.commit({
              repo,
              tree: remoteTree,
              parents: [syncedCommit],
              message: "remote",
            }),
            tree: remoteTree,
          };
        return head;
      });

    const retention = yield* store.prepareRetention({
      environmentId: "environment-1",
      connectionId: CONNECTION,
      checkoutRoot: checkout,
      exchangeHelper,
      expected: null,
    });
    const fileId = (path: string) =>
      Effect.promise(async () => String((await NodeFSP.stat(path, { bigint: true })).ino));
    yield* store.createConnection({
      ...overleafConnectionFixture(CONNECTION),
      checkout: {
        canonicalRoot: checkout,
        identity: { volume: VOLUME, fileId: yield* fileId(checkout) },
      },
      folder: {
        relativePath: "paper",
        identity: { volume: VOLUME, fileId: yield* fileId(folder) },
      },
      base: { commit: syncedCommit, tree: syncedTree, generation: 1 },
      completedSyncCount: 1,
      managedPaths: Object.keys(input.synced),
      retention: { vaultIdentity: retention.identity, copies: [] },
    });

    const coordinator = yield* OverleafCoordinator.make({
      stateRoot,
      exchangeHelper,
      fetchRemote,
      volumeUuid,
      registry,
      hooks: { at: async (point) => input.at?.(point) },
    }).pipe(
      Effect.provideService(OverleafStateStore.OverleafStateStore, store),
      Effect.provideService(OverleafRepository.OverleafRepository, repos),
      Effect.provideService(WorkspaceApplier, applier),
      Effect.provideService(CheckoutBarrier, barrier),
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
    return {
      store,
      checkout,
      folder,
      repo,
      repos,
      coordinator,
      barrier,
      registry,
      connection,
      sync,
      setRemote: (next: Record<string, string>) => {
        remote = next;
      },
    };
  });

const run = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe.skipIf(!canApply)("OverleafCoordinator, local half", () => {
  it.live("applies a confirmed review and adopts the result once", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A", "other.tex": "O" },
          remote: { "main.tex": "B", "other.tex": "O" },
        });
        const before = yield* w.connection;
        const prepared = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (prepared._tag !== "review") return yield* Effect.die(prepared);
        const request = {
          connectionId: CONNECTION,
          requestId: "request-1",
          reviewId: prepared.review.id,
          digest: prepared.review.digest,
          acknowledgements: prepared.review.binding.acknowledgements,
        };
        const confirmed = yield* w.coordinator.confirm(request);
        expect(confirmed).toMatchObject({ _tag: "applied", adopted: { outcome: "complete" } });
        expect(yield* read(w.folder, "main.tex")).toBe("B");
        const after = yield* w.connection;
        expect(after.activeApply).toBeNull();
        expect(after.base.generation).toBe(before.base.generation + 1);
        expect(after.priorBases[0]).toEqual(before.base);
        expect(after.completedSyncCount).toBe(before.completedSyncCount + 1);
        expect(after.localSnapshots).toHaveLength(1);
        expect(after.retention.copies).toMatchObject([
          { relativePath: "main.tex", state: "releasable" },
        ]);
        // The new base is pinned; the finished apply's intent pin is gone.
        expect(
          yield* w.repos.readRef({ repo: w.repo, name: `base/${after.base.generation}/tree` }),
        ).toBe(after.base.tree);
        if (confirmed._tag !== "applied") return;
        expect(
          yield* w.repos.readRef({
            repo: w.repo,
            name: `apply/${confirmed.adopted.applyId}/target`,
          }),
        ).toBeNull();
        // The same request again returns its receipt and changes nothing; the same ID
        // for a different request is refused.
        expect(yield* w.coordinator.confirm(request)).toMatchObject({
          _tag: "duplicate",
          receipt: { status: "completed", resultCategory: "applied-complete" },
        });
        expect(
          String(yield* Effect.exit(w.coordinator.confirm({ ...request, digest: "other" }))),
        ).toContain("OverleafRequestReusedError");
        expect((yield* w.connection).revision).toBe(after.revision);
      }),
    ),
  );

  it.live("refuses a review the folder no longer matches and offers a fresh one", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
        });
        const prepared = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (prepared._tag !== "review") return yield* Effect.die(prepared);
        yield* write(w.folder, { "main.tex": "edited here" });
        const before = yield* w.connection;
        const confirmed = yield* w.coordinator.confirm({
          connectionId: CONNECTION,
          requestId: "request-1",
          reviewId: prepared.review.id,
          digest: prepared.review.digest,
          acknowledgements: prepared.review.binding.acknowledgements,
        });
        expect(confirmed).toMatchObject({ _tag: "stale", reason: "capture" });
        expect(yield* read(w.folder, "main.tex")).toBe("edited here");
        expect((yield* w.connection).revision).toBe(before.revision);
        if (confirmed._tag !== "stale") return;
        expect(w.registry.current(CONNECTION, yield* Clock.currentTimeMillis)?.id).toBe(
          confirmed.review.id,
        );
      }),
    ),
  );

  it.live("recovers an apply interrupted after the applier ran, adopting it once", () => {
    let crash = true;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          at: async (point) => {
            if (crash && point === "applied") throw new Error("process died");
          },
        });
        const before = yield* w.connection;
        expect(Exit.isFailure(yield* Effect.exit(w.sync()))).toBe(true);
        expect(yield* read(w.folder, "main.tex")).toBe("B");
        expect((yield* w.connection).activeApply).not.toBeNull();
        crash = false;
        const recovered = yield* w.coordinator.recover({ connectionId: CONNECTION });
        expect(recovered).toMatchObject({ _tag: "recovered", adopted: { outcome: "complete" } });
        const after = yield* w.connection;
        expect(after.activeApply).toBeNull();
        expect(after.base.generation).toBe(before.base.generation + 1);
        expect(yield* w.coordinator.recover({ connectionId: CONNECTION })).toEqual({
          _tag: "none",
        });
        expect((yield* w.connection).base.generation).toBe(after.base.generation);
      }),
    );
  });

  it.live("clears an apply linked just before a crash, with nothing written", () => {
    let crash = true;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          at: async (point) => {
            if (crash && point === "linked") throw new Error("process died");
          },
        });
        const before = yield* w.connection;
        expect(Exit.isFailure(yield* Effect.exit(w.sync()))).toBe(true);
        expect((yield* w.connection).activeApply).not.toBeNull();
        crash = false;
        expect(yield* w.coordinator.recover({ connectionId: CONNECTION })).toMatchObject({
          _tag: "recovered",
          adopted: { outcome: "replan" },
        });
        const after = yield* w.connection;
        expect(after.activeApply).toBeNull();
        expect(after.base).toEqual(before.base);
        expect(yield* read(w.folder, "main.tex")).toBe("A");
        // A new review applies normally afterwards.
        expect(yield* w.sync("request-2")).toMatchObject({ _tag: "applied" });
        expect(yield* read(w.folder, "main.tex")).toBe("B");
      }),
    );
  });

  it.live("refuses a second operation on the connection instead of queuing it", () => {
    let competing: Exit.Exit<unknown, OverleafCoordinator.OverleafCoordinatorError> | undefined;
    let coordinator: OverleafCoordinator.OverleafCoordinator["Service"] | undefined;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          at: async (point) => {
            if (point === "linked" && coordinator)
              competing = await Effect.runPromiseExit(
                coordinator.prepare({ connectionId: CONNECTION }),
              );
          },
        });
        coordinator = w.coordinator;
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        expect(String(competing)).toContain("OverleafOperationActiveError");
      }),
    );
  });

  it.live("makes a bulk change of the checkout wait until the apply is adopted", () => {
    const order: string[] = [];
    let bulk: Fiber.Fiber<void, CheckoutRecoveryRequiredError | CheckoutLookupError> | undefined;
    let barrier: ReturnType<typeof makeCheckoutBarrier> | undefined;
    let checkout = "";
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          at: async (point) => {
            order.push(point);
            if (point === "linked" && barrier) {
              bulk = Effect.runFork(
                barrier.bulk(
                  checkout,
                  Effect.sync(() => {
                    order.push("bulk");
                  }),
                ),
              );
              await Effect.runPromise(Effect.sleep("100 millis"));
            }
          },
        });
        barrier = w.barrier;
        checkout = w.checkout;
        // The bulk change starts while the apply runs; its epoch move makes the next
        // review stale, but this apply was admitted first and finishes.
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        yield* Fiber.join(bulk!);
        expect(order).toEqual(["linked", "applied", "adopted", "bulk"]);
      }),
    );
  });

  it.live("recovers a pending apply inline before a bulk change of its checkout", () => {
    let crash = true;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          at: async (point) => {
            if (crash && point === "applied") throw new Error("process died");
          },
        });
        const before = yield* w.connection;
        expect(Exit.isFailure(yield* Effect.exit(w.sync()))).toBe(true);
        crash = false;
        let mutated = false;
        yield* w.barrier.bulk(
          NodePath.join(w.checkout, "paper"),
          Effect.sync(() => {
            mutated = true;
          }),
        );
        expect(mutated).toBe(true);
        const after = yield* w.connection;
        expect(after.activeApply).toBeNull();
        expect(after.base.generation).toBe(before.base.generation + 1);
      }),
    );
  });

  it.live("refuses a bulk change while structural copies sit in the folder", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "A" }, remote: { "main.tex": "A" } });
        const current = yield* w.connection;
        yield* w.store.replaceConnection({
          expectedRevision: current.revision,
          next: {
            ...current,
            revision: current.revision + 1,
            stagingPaths: [".scient-overleaf-apply-earlier-1"],
            updatedAt: "2026-10-22T12:00:00.000Z",
          },
        });
        let mutated = false;
        const refused = yield* Effect.exit(
          w.barrier.bulk(
            w.checkout,
            Effect.sync(() => {
              mutated = true;
            }),
          ),
        );
        expect(String(refused)).toContain("CheckoutRecoveryRequiredError");
        expect(mutated).toBe(false);
      }),
    ),
  );

  it.live("keeps a group interrupted partway as a forced conflict for the next review", () => {
    let prepared = 0;
    return run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "old.tex": "chapter text that moves", "main.tex": "M" },
          remote: { "new.tex": "chapter text that moves", "main.tex": "M" },
          // The rename's second step removes old.tex; it changes just before.
          native: async (point, folder) => {
            if (point === "prepared" && ++prepared === 2)
              await NodeFSP.writeFile(NodePath.join(folder, "old.tex"), "edited meanwhile");
          },
        });
        const confirmed = yield* w.sync();
        expect(confirmed).toMatchObject({ _tag: "applied", adopted: { outcome: "attention" } });
        const after = yield* w.connection;
        expect(after.forcedConflicts).toEqual([["new.tex", "old.tex"]]);
        expect(after.completedSyncCount).toBe(1);
        expect(yield* read(w.folder, "old.tex")).toBe("edited meanwhile");
        // The next review shows the group as a conflict to decide.
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        expect(next.review.conflicts.map((conflict) => [...conflict.paths].sort())).toContainEqual([
          "new.tex",
          "old.tex",
        ]);
      }),
    );
  });
});
