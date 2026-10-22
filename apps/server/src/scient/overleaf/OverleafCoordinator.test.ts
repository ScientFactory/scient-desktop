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
import { bytesRevision, type MutationPoint } from "../workspace/RetainedFileMutation.ts";

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
  /** Files only in the folder, recorded as local-only. */
  readonly localOnly?: Record<string, string>;
  /** Paths recorded as holding Scient conflict material. */
  readonly markerPaths?: ReadonlyArray<string>;
  readonly at?: (point: Point) => Effect.Effect<void>;
  /** Runs at the native publication hooks of every step the applier takes. */
  readonly native?: (point: MutationPoint, folder: string, stateRoot: string) => Promise<void>;
  /** Wraps the real applier, to shape what it reports. */
  readonly applier?: (real: WorkspaceApplier["Service"]) => WorkspaceApplier["Service"];
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
    yield* write(folder, input.localOnly ?? {});

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
      retainedHooks: { at: async (point) => input.native?.(point, folder, stateRoot) },
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
      localOnlyPaths: Object.keys(input.localOnly ?? {}),
      markerPaths: [...(input.markerPaths ?? [])],
      retention: { vaultIdentity: retention.identity, copies: [] },
    });

    const coordinatorWith = (stateStore: OverleafStateStore.OverleafStateStore["Service"]) =>
      OverleafCoordinator.make({
        stateRoot,
        exchangeHelper,
        fetchRemote,
        volumeUuid,
        registry,
      }).pipe(
        Effect.provideService(OverleafStateStore.OverleafStateStore, stateStore),
        Effect.provideService(OverleafRepository.OverleafRepository, repos),
        Effect.provideService(WorkspaceApplier, applier),
        Effect.provideService(CheckoutBarrier, makeCheckoutBarrier()),
      );
    const coordinator = yield* OverleafCoordinator.make({
      stateRoot,
      exchangeHelper,
      fetchRemote,
      volumeUuid,
      registry,
      hooks: { at: (point) => input.at?.(point) ?? Effect.void },
    }).pipe(
      Effect.provideService(OverleafStateStore.OverleafStateStore, store),
      Effect.provideService(OverleafRepository.OverleafRepository, repos),
      Effect.provideService(WorkspaceApplier, input.applier?.(applier) ?? applier),
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
          at: (point) =>
            crash && point === "applied" ? Effect.die(new Error("process died")) : Effect.void,
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
          at: (point) =>
            crash && point === "linked" ? Effect.die(new Error("process died")) : Effect.void,
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
          at: (point) =>
            point === "linked" && coordinator
              ? coordinator.prepare({ connectionId: CONNECTION }).pipe(
                  Effect.exit,
                  Effect.map((exit) => {
                    competing = exit;
                  }),
                )
              : Effect.void,
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
          at: (point) =>
            Effect.gen(function* () {
              order.push(point);
              if (point !== "linked" || !barrier) return;
              bulk = yield* barrier
                .bulk(
                  checkout,
                  Effect.sync(() => {
                    order.push("bulk");
                  }),
                )
                .pipe(Effect.forkDetach);
              yield* Effect.sleep("100 millis");
            }),
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
          at: (point) =>
            crash && point === "applied" ? Effect.die(new Error("process died")) : Effect.void,
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
        // Managed paths are the reviewed result's; old.tex stays in the base instead.
        expect(after.managedPaths).toEqual(["main.tex", "new.tex"]);
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

  /** Syncs `main.tex` from A to B, then lists the copy of A that the sync kept. */
  const syncedThenListed = (at?: (point: Point) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const w = yield* world({
        synced: { "main.tex": "A" },
        remote: { "main.tex": "B" },
        ...(at ? { at } : {}),
      });
      expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
      const [copy] = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
      return { w, copy: copy! };
    });

  it.live("restores a kept copy, keeping what it replaces and leaving the base", () =>
    run(
      Effect.gen(function* () {
        const { w, copy } = yield* syncedThenListed();
        expect(copy).toMatchObject({ relativePath: "main.tex", state: "releasable" });
        expect(copy.keptRevision).toBe(copy.revision);
        expect(copy.currentRevision).not.toBe(copy.revision);
        const before = yield* w.connection;
        const restored = yield* w.coordinator.restoreKept({
          connectionId: CONNECTION,
          requestId: "restore-1",
          applyId: copy.applyId,
          kept: copy.kept,
          keptRevision: copy.keptRevision!,
          currentRevision: copy.currentRevision,
        });
        expect(restored).toMatchObject({ _tag: "restored", adopted: { outcome: "complete" } });
        expect(yield* read(w.folder, "main.tex")).toBe("A");
        const after = yield* w.connection;
        expect(after.base).toEqual(before.base);
        expect(after.completedSyncCount).toBe(before.completedSyncCount);
        expect(after.activeApply).toBeNull();
        // The file the restore replaced is kept too, never released automatically.
        const listed = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        expect(listed.map((entry) => entry.state).sort()).toEqual(["kept", "releasable"]);
        // The restored bytes are a local change for the next review to send.
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        expect(next.review.outgoing.map((change) => change.kind)).toEqual(["modified"]);
      }),
    ),
  );

  it.live("refuses a restore when the folder's file changed after listing", () =>
    run(
      Effect.gen(function* () {
        const { w, copy } = yield* syncedThenListed();
        yield* write(w.folder, { "main.tex": "edited after listing" });
        const before = yield* w.connection;
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: copy.currentRevision,
          }),
        ).toEqual({ _tag: "stale" });
        expect(yield* read(w.folder, "main.tex")).toBe("edited after listing");
        expect((yield* w.connection).revision).toBe(before.revision);
      }),
    ),
  );

  it.live("recovers a restore interrupted after the applier ran, leaving the base", () => {
    let crash = false;
    return run(
      Effect.gen(function* () {
        const { w, copy } = yield* syncedThenListed((point) =>
          crash && point === "applied" ? Effect.die(new Error("process died")) : Effect.void,
        );
        const before = yield* w.connection;
        crash = true;
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              w.coordinator.restoreKept({
                connectionId: CONNECTION,
                requestId: "restore-1",
                applyId: copy.applyId,
                kept: copy.kept,
                keptRevision: copy.keptRevision!,
                currentRevision: copy.currentRevision,
              }),
            ),
          ),
        ).toBe(true);
        crash = false;
        expect(yield* w.coordinator.recover({ connectionId: CONNECTION })).toMatchObject({
          _tag: "recovered",
          adopted: { outcome: "complete" },
        });
        const after = yield* w.connection;
        expect(after.base).toEqual(before.base);
        expect(after.activeApply).toBeNull();
        expect(yield* read(w.folder, "main.tex")).toBe("A");
      }),
    );
  });

  // Interference in the native layer can leave more than one version of one path
  // (a staged and a provisional copy, say); every one stays listed and restorable,
  // under one record per path.
  it.live("lists every version a step kept of one file", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          applier: (real) =>
            WorkspaceApplier.of({
              apply: (input) =>
                real.apply(input).pipe(
                  Effect.flatMap((result) => {
                    const [first] = result.retained;
                    if (first === undefined) return Effect.succeed(result);
                    const provisional = NodePath.join(
                      NodePath.dirname(first.retainedPath!),
                      "provisional",
                    );
                    return Effect.promise(async () => {
                      await NodeFSP.writeFile(provisional, "D");
                      return {
                        ...result,
                        retained: [
                          ...result.retained,
                          {
                            ...first,
                            retainedPath: provisional,
                            retainedRevision: bytesRevision(new TextEncoder().encode("D")),
                            changed: true,
                          },
                        ],
                      };
                    });
                  }),
                ),
            }),
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).retention.copies).toMatchObject([
          { relativePath: "main.tex", state: "changed" },
        ]);
        const listed = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        expect(listed.map((copy) => copy.kept.split("/").pop()).sort()).toEqual([
          "provisional",
          "slot",
        ]);
        // The extra version restores like the main one.
        const extra = listed.find((copy) => copy.kept.endsWith("/provisional"))!;
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: extra.applyId,
            kept: extra.kept,
            keptRevision: extra.keptRevision!,
            currentRevision: extra.currentRevision,
          }),
        ).toMatchObject({ _tag: "restored" });
        expect(yield* read(w.folder, "main.tex")).toBe("D");
      }),
    ),
  );

  it.live("refuses a bulk change while a connection record cannot be read", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "A" }, remote: { "main.tex": "A" } });
        const records = NodePath.join(w.stateRoot, "connections");
        const [file] = (yield* Effect.promise(() => NodeFSP.readdir(records))).filter((name) =>
          name.endsWith(".json"),
        );
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(records, file!), "{ broken"));
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

  it.live("refuses a restore with no room left to keep what it replaces", () =>
    run(
      Effect.gen(function* () {
        const { w, copy } = yield* syncedThenListed();
        const current = yield* w.connection;
        const filler = Array.from({ length: 4_096 - current.retention.copies.length }, (_, n) => ({
          ...current.retention.copies[0]!,
          relativePath: `filler-${n}.tex`,
        }));
        yield* w.store.replaceConnection({
          expectedRevision: current.revision,
          next: {
            ...current,
            revision: current.revision + 1,
            retention: {
              ...current.retention,
              copies: [...current.retention.copies, ...filler],
            },
            updatedAt: "2026-10-22T12:00:00.000Z",
          },
        });
        const refused = yield* Effect.exit(
          w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: copy.currentRevision,
          }),
        );
        expect(String(refused)).toContain("OverleafRetainedLimitError");
        expect(yield* read(w.folder, "main.tex")).toBe("B");
        expect((yield* w.connection).activeApply).toBeNull();
      }),
    ),
  );

  it.live("makes a restored file that a sync deleted part of the next review", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "M", "old.tex": "kept text" },
          remote: { "main.tex": "M" },
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        expect(yield* read(w.folder, "old.tex")).toBeNull();
        const copy = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).find(
          (entry) => entry.relativePath === "old.tex",
        )!;
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: null,
          }),
        ).toMatchObject({ _tag: "restored" });
        const next = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (next._tag !== "review") return yield* Effect.die(next);
        expect(next.review.outgoing).toContainEqual(
          expect.objectContaining({ kind: "added", path: "old.tex" }),
        );
      }),
    ),
  );

  it.live("adopts the local-only set the review counted, without a collision it read in", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "M" },
          remote: { "main.tex": "M", "notes.tex": "theirs" },
          localOnly: { "notes.tex": "mine", "scratch.tex": "S" },
        });
        const first = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (first._tag !== "review") return yield* Effect.die(first);
        expect(first.review.binding.collisionPaths).toEqual(["notes.tex"]);
        const choices = new Map(
          first.review.conflicts.map((conflict) => [conflict.key, conflict.allowed[0]!] as const),
        );
        const chosen = yield* w.coordinator.prepare({
          connectionId: CONNECTION,
          selections: {
            selectedAdditions: [],
            collisionPaths: first.review.binding.collisionPaths,
            choices,
          },
        });
        if (chosen._tag !== "review") return yield* Effect.die(chosen);
        expect(
          yield* w.coordinator.confirm({
            connectionId: CONNECTION,
            requestId: "request-1",
            reviewId: chosen.review.id,
            digest: chosen.review.digest,
            acknowledgements: chosen.review.binding.acknowledgements,
          }),
        ).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).localOnlyPaths).toEqual(["scratch.tex"]);
      }),
    ),
  );

  it.live("marks an older kept copy changed when a later sync finds it rewritten", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "A" }, remote: { "main.tex": "B" } });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        const [copy] = (yield* w.connection).retention.copies;
        expect(copy!.state).toBe("releasable");
        const vault = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION }))[0]!;
        yield* Effect.promise(async () => {
          const found = (await NodeFSP.readdir(w.stateRoot, { recursive: true })).find((path) =>
            path.endsWith(vault.kept),
          );
          await NodeFSP.writeFile(NodePath.join(w.stateRoot, found!), "late write");
        });
        w.setRemote({ "main.tex": "B", "other.tex": "O" });
        expect(yield* w.sync("request-2")).toMatchObject({ _tag: "applied" });
        expect(
          (yield* w.connection).retention.copies.find((entry) => entry.applyId === copy!.applyId)!
            .state,
        ).toBe("changed");
      }),
    ),
  );

  it.live("tracks restored conflict material as unresolved again", () =>
    run(
      Effect.gen(function* () {
        const marked = "<<<<<<< mine\nours\n=======\ntheirs\n>>>>>>> theirs\n";
        const w = yield* world({
          synced: { "main.tex": marked, "other.tex": "O" },
          remote: { "main.tex": "resolved", "other.tex": "O" },
          markerPaths: ["main.tex"],
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        // A later sync finds the material gone and stops tracking it.
        w.setRemote({ "main.tex": "resolved", "other.tex": "O2" });
        expect(yield* w.sync("request-2")).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).markerPaths).toEqual([]);
        const copy = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).find(
          (entry) => entry.relativePath === "main.tex",
        )!;
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: copy.currentRevision,
          }),
        ).toMatchObject({ _tag: "restored" });
        expect((yield* w.connection).markerPaths).toEqual(["main.tex"]);
      }),
    ),
  );

  it.live("keeps a restored local-only file local-only", () =>
    run(
      Effect.gen(function* () {
        const { w, copy } = yield* syncedThenListed();
        const current = yield* w.connection;
        yield* w.store.replaceConnection({
          expectedRevision: current.revision,
          next: {
            ...current,
            revision: current.revision + 1,
            managedPaths: current.managedPaths.filter((path) => path !== "main.tex"),
            localOnlyPaths: ["main.tex"],
            updatedAt: "2026-10-22T12:00:00.000Z",
          },
        });
        expect(
          yield* w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: copy.currentRevision,
          }),
        ).toMatchObject({ _tag: "restored" });
        const after = yield* w.connection;
        expect(after.localOnlyPaths).toEqual(["main.tex"]);
        expect(after.managedPaths).not.toContain("main.tex");
      }),
    ),
  );

  it.live("refuses to bring a file back beyond the managed-path limit", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "M", "old.tex": "kept text" },
          remote: { "main.tex": "M" },
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        const copy = (yield* w.coordinator.keptCopies({ connectionId: CONNECTION })).find(
          (entry) => entry.relativePath === "old.tex",
        )!;
        const current = yield* w.connection;
        yield* w.store.replaceConnection({
          expectedRevision: current.revision,
          next: {
            ...current,
            revision: current.revision + 1,
            managedPaths: Array.from({ length: 2_000 }, (_, n) => `file-${n}.tex`),
            updatedAt: "2026-10-22T12:00:00.000Z",
          },
        });
        const refused = yield* Effect.exit(
          w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: copy.applyId,
            kept: copy.kept,
            keptRevision: copy.keptRevision!,
            currentRevision: null,
          }),
        );
        expect(refused).toMatchObject(
          Exit.fail(
            expect.objectContaining({ _tag: "OverleafRetainedLimitError", limit: "managed-paths" }),
          ),
        );
        expect(yield* read(w.folder, "old.tex")).toBeNull();
        expect((yield* w.connection).activeApply).toBeNull();
      }),
    ),
  );

  /** Wraps the applier to report one more version of the first kept path, written to disk. */
  const withExtraVersion =
    (changed: boolean) =>
    (real: WorkspaceApplier["Service"]): WorkspaceApplier["Service"] =>
      WorkspaceApplier.of({
        apply: (input) =>
          real.apply(input).pipe(
            Effect.flatMap((result) => {
              const [first] = result.retained;
              if (first === undefined) return Effect.succeed(result);
              const provisional = NodePath.join(
                NodePath.dirname(first.retainedPath!),
                "provisional",
              );
              return Effect.promise(async () => {
                await NodeFSP.writeFile(provisional, "D");
                return {
                  ...result,
                  retained: [
                    ...result.retained,
                    {
                      ...first,
                      retainedPath: provisional,
                      retainedRevision: bytesRevision(new TextEncoder().encode("D")),
                      changed,
                    },
                  ],
                };
              });
            }),
          ),
      });

  it.live("never marks a record with another version releasable, even unchanged", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          applier: withExtraVersion(false),
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        expect((yield* w.connection).retention.copies).toMatchObject([
          { relativePath: "main.tex", state: "ambiguous" },
        ]);
      }),
    ),
  );

  it.live("keeps listing every version when the applier's step record is damaged", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          applier: withExtraVersion(true),
        });
        expect(yield* w.sync()).toMatchObject({ _tag: "applied" });
        yield* Effect.promise(async () => {
          const record = (await NodeFSP.readdir(w.stateRoot, { recursive: true })).find((path) =>
            path.endsWith("/step-0/record.json"),
          );
          await NodeFSP.writeFile(NodePath.join(w.stateRoot, record!), "{ damaged");
        });
        const listed = yield* w.coordinator.keptCopies({ connectionId: CONNECTION });
        expect(listed).toHaveLength(2);
        // A damaged record is unknown authority to the file layer: the file waits for
        // explicit review before anything, a restore included, writes to it.
        const extra = listed.find((copy) => copy.kept.endsWith("/provisional"))!;
        const refused = yield* Effect.exit(
          w.coordinator.restoreKept({
            connectionId: CONNECTION,
            requestId: "restore-1",
            applyId: extra.applyId,
            kept: extra.kept,
            keptRevision: extra.keptRevision!,
            currentRevision: extra.currentRevision,
          }),
        );
        expect(String(refused)).toContain("needs explicit review");
        expect(yield* read(w.folder, "main.tex")).toBe("B");
      }),
    ),
  );

  it.live("refuses to prepare without this process's writable lease", () =>
    run(
      Effect.gen(function* () {
        const w = yield* world({ synced: { "main.tex": "A" }, remote: { "main.tex": "B" } });
        // Another store on the same state folder cannot take the lease this one holds.
        const other = yield* OverleafStateStore.make({
          root: w.stateRoot,
          volumeUuid: w.volumeUuid,
        });
        const blocked = yield* w.coordinatorWith(other);
        const refused = yield* Effect.exit(blocked.prepare({ connectionId: CONNECTION }));
        expect(String(refused)).toContain("OverleafStateLockedError");
      }),
    ),
  );
});
