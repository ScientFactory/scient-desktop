// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as CheckpointService from "../../orchestration-v2/CheckpointService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  CheckoutBarrier,
  CheckoutRecoveryRequiredError,
  makeCheckoutBarrier,
  type CheckoutSection,
} from "./CheckoutBarrier.ts";

/** A temporary folder holding `repo` (a checkout: it has `.git`) and `other`. */
const folders = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-checkout-barrier-")),
    );
    for (const folder of ["repo/.git", "repo/paper/figures", "other/.git"])
      await NodeFSP.mkdir(NodePath.join(root, folder), { recursive: true });
    await NodeFSP.symlink(NodePath.join(root, "repo"), NodePath.join(root, "alias"));
    return {
      root,
      repo: NodePath.join(root, "repo"),
      paper: NodePath.join(root, "repo/paper"),
      alias: NodePath.join(root, "alias"),
      other: NodePath.join(root, "other"),
    };
  }),
  ({ root }) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);

/** Forks `body` inside an application section and returns once it is inside. */
const holdApplication = (
  barrier: ReturnType<typeof makeCheckoutBarrier>,
  path: string,
  release: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const inside = yield* Deferred.make<void>();
    const fiber = yield* barrier
      .application(path, () =>
        Deferred.succeed(inside, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(inside);
    return fiber;
  });

/** Forks a bulk change of `path` and returns once it runs, with its section's epoch. */
const holdBulk = (
  barrier: ReturnType<typeof makeCheckoutBarrier>,
  path: string,
  release: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const inside = yield* Deferred.make<void>();
    const fiber = yield* barrier
      .bulk(path, Deferred.succeed(inside, undefined).pipe(Effect.andThen(Deferred.await(release))))
      .pipe(Effect.forkChild);
    yield* Deferred.await(inside);
    return fiber;
  });

describe("CheckoutBarrier", () => {
  it.effect("refuses an application while a bulk change runs, and admits one after", () =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const barrier = makeCheckoutBarrier();
      const release = yield* Deferred.make<void>();
      const bulk = yield* holdBulk(barrier, repo, release);
      const refused = yield* Effect.exit(barrier.application(repo, () => Effect.void));
      assert.isTrue(Exit.isFailure(refused));
      assert.include(String(refused), "CheckoutSuspendedError");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(bulk);
      assert.equal(yield* barrier.application(repo, () => Effect.succeed("applied")), "applied");
    }).pipe(Effect.scoped),
  );

  it.effect("closes admission at once and waits for a running application to settle", () =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const barrier = makeCheckoutBarrier();
      const release = yield* Deferred.make<void>();
      const application = yield* holdApplication(barrier, repo, release);
      let mutated = false;
      const bulk = yield* barrier
        .bulk(
          repo,
          Effect.sync(() => {
            mutated = true;
          }),
        )
        .pipe(Effect.forkChild);
      for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
      assert.isFalse(mutated);
      // The waiting bulk change already refuses a new application.
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(barrier.application(repo, () => Effect.void))),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(application);
      yield* Fiber.join(bulk);
      assert.isTrue(mutated);
    }).pipe(Effect.scoped),
  );

  it.effect("advances the epoch as a bulk change starts and ends, even when it fails", () =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const barrier = makeCheckoutBarrier();
      assert.equal((yield* barrier.current(repo)).epoch, 0);
      const during = yield* Effect.exit(
        barrier.bulk(
          repo,
          Effect.flatMap(barrier.current(repo), (section) => Effect.fail(section.epoch)),
        ),
      );
      assert.deepEqual(during, Exit.fail(1));
      assert.equal((yield* barrier.current(repo)).epoch, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("treats every path into one checkout as that checkout", () =>
    Effect.gen(function* () {
      const { repo, paper, alias, other } = yield* folders;
      const barrier = makeCheckoutBarrier();
      const section = yield* barrier.current(paper);
      assert.equal(section.root, repo);
      assert.equal((yield* barrier.current(alias)).key, section.key);
      assert.equal((yield* barrier.current(NodePath.join(paper, "not-yet"))).key, section.key);
      assert.notEqual((yield* barrier.current(other)).key, section.key);
      const release = yield* Deferred.make<void>();
      const bulk = yield* holdBulk(barrier, alias, release);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(barrier.application(paper, () => Effect.void))),
      );
      // Another checkout is not suspended.
      yield* barrier.application(other, () => Effect.void);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(bulk);
    }).pipe(Effect.scoped),
  );

  it.effect("runs bulk changes of one checkout side by side, nested ones included", () =>
    Effect.gen(function* () {
      const { repo, paper } = yield* folders;
      const barrier = makeCheckoutBarrier();
      const release = yield* Deferred.make<void>();
      const outer = yield* holdBulk(barrier, repo, release);
      assert.equal(
        yield* barrier.bulk(paper, barrier.bulk(repo, Effect.succeed("nested"))),
        "nested",
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(outer);
    }).pipe(Effect.scoped),
  );

  it.effect("reopens admission when a waiting bulk change is interrupted", () =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const barrier = makeCheckoutBarrier();
      const release = yield* Deferred.make<void>();
      const application = yield* holdApplication(barrier, repo, release);
      const bulk = yield* barrier.bulk(repo, Effect.void).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(bulk);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(application);
      yield* barrier.application(repo, () => Effect.void);
    }).pipe(Effect.scoped),
  );

  it.effect("runs a removed path's change outside the barrier only when told to", () =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const barrier = makeCheckoutBarrier();
      const gone = NodePath.join(repo, "removed-worktree");
      yield* barrier.bulk(gone, Effect.void, { missing: "skip" });
      assert.equal((yield* barrier.current(repo)).epoch, 0);
      yield* barrier.bulk(gone, Effect.void);
      assert.equal((yield* barrier.current(repo)).epoch, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("settles unfinished work before a bulk change, inside its section, or refuses it", () =>
    Effect.gen(function* () {
      const { repo, paper } = yield* folders;
      const barrier = makeCheckoutBarrier();
      const seen: Array<string> = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* barrier.settleBeforeBulk((section: CheckoutSection) =>
            Effect.gen(function* () {
              // Only its own section admits the settling application.
              const outside = yield* Effect.exit(barrier.application(paper, () => Effect.void));
              seen.push(Exit.isFailure(outside) ? "outside refused" : "outside admitted");
              yield* barrier
                .application(paper, () => Effect.sync(() => seen.push("settled")), {
                  within: section,
                })
                .pipe(Effect.orDie);
            }),
          );
          yield* barrier.bulk(
            repo,
            Effect.sync(() => seen.push("mutated")),
          );
        }),
      );
      assert.deepEqual(seen, ["outside refused", "settled", "mutated"]);

      // A settler that cannot finish the work refuses the change; the epoch still moves.
      let mutated = false;
      const refused = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* barrier.settleBeforeBulk((section) =>
            Effect.fail(new CheckoutRecoveryRequiredError({ checkout: section.root })),
          );
          return yield* Effect.exit(
            barrier.bulk(
              repo,
              Effect.sync(() => {
                mutated = true;
              }),
            ),
          );
        }),
      );
      assert.isFalse(mutated);
      assert.include(String(refused), "CheckoutRecoveryRequiredError");
      assert.equal((yield* barrier.current(repo)).epoch, 4);
      // The settler left with its scope.
      yield* barrier.bulk(repo, Effect.void);
    }).pipe(Effect.scoped),
  );
});

// Real consumers: the Git driver's bulk methods and checkpoint restoration.
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const repository = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-checkout-barrier-git-")),
    );
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    await NodeFSP.writeFile(NodePath.join(root, "main.tex"), "base");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    git(root, "branch", "other");
    return root;
  }),
  (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
);
const driverWith = (barrier: ReturnType<typeof makeCheckoutBarrier>) =>
  GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "scient-checkout-barrier-" })),
    Layer.provide(Layer.succeed(CheckoutBarrier, barrier)),
    Layer.provideMerge(NodeServices.layer),
  );

describe("CheckoutBarrier consumers", () => {
  it.live("a branch switch waits for an application of the same checkout", () => {
    const barrier = makeCheckoutBarrier();
    return Effect.gen(function* () {
      const root = yield* repository;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const release = yield* Deferred.make<void>();
      const application = yield* holdApplication(barrier, root, release);
      const switching = yield* driver
        .switchRef({ cwd: root, refName: "other" })
        .pipe(Effect.forkChild);
      yield* Effect.sleep("200 millis");
      assert.equal(git(root, "branch", "--show-current"), "main");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(application);
      yield* Fiber.join(switching);
      assert.equal(git(root, "branch", "--show-current"), "other");
      assert.equal((yield* barrier.current(root)).epoch, 2);
    }).pipe(Effect.scoped, Effect.provide(driverWith(barrier)));
  });

  it.live("a refused settlement stops a branch switch before Git runs", () => {
    const barrier = makeCheckoutBarrier();
    return Effect.gen(function* () {
      const root = yield* repository;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* barrier.settleBeforeBulk((section) =>
        Effect.fail(new CheckoutRecoveryRequiredError({ checkout: section.root })),
      );
      const refused = yield* Effect.exit(driver.switchRef({ cwd: root, refName: "other" }));
      assert.include(String(refused), "GitCommandError");
      assert.include(String(refused), "Overleaf sync");
      assert.equal(git(root, "branch", "--show-current"), "main");
    }).pipe(Effect.scoped, Effect.provide(driverWith(barrier)));
  });

  it.live("a checkpoint restore waits for an application of the same checkout", () => {
    const barrier = makeCheckoutBarrier();
    const restored: string[] = [];
    const layer = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.succeed(CheckoutBarrier, barrier),
          Layer.mock(CheckpointStore.CheckpointStore)({
            restoreCheckpoint: (input) =>
              Effect.sync(() => {
                restored.push(input.cwd);
                return true;
              }),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );
    return Effect.gen(function* () {
      const root = yield* repository;
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:barrier"),
        threadId: ThreadId.make("thread:barrier"),
        runId: RunId.make("run:barrier:1"),
        nodeId: NodeId.make("node:barrier:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:barrier"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: root,
        createdAt: DateTime.makeUnsafe("2026-10-22T00:00:00.000Z"),
      };
      const release = yield* Deferred.make<void>();
      const application = yield* holdApplication(barrier, NodePath.join(root, "paper"), release);
      const restoring = yield* checkpoints
        .restore({
          scope,
          checkpoint: {
            id: CheckpointId.make("checkpoint:barrier"),
            scopeId: scope.id,
            ordinalWithinScope: 1,
            ref: CheckpointRef.make("refs/scient/checkpoints/barrier"),
            status: "ready",
          } as never,
        })
        .pipe(Effect.forkChild);
      yield* Effect.sleep("100 millis");
      assert.deepEqual(restored, []);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(application);
      yield* Fiber.join(restoring);
      assert.deepEqual(restored, [root]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
