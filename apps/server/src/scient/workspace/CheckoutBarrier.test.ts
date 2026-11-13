// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
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
import { vi } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as CheckpointService from "../../orchestration-v2/CheckpointService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  CheckoutBarrier,
  type CheckoutBarrierShape,
  type CheckoutLookupError,
  CheckoutRecoveryRequiredError,
  makeCheckoutBarrier,
  type CheckoutSection,
} from "./CheckoutBarrier.ts";
import { platformFileIdentity } from "./PlatformFileIdentity.ts";

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
  barrier: CheckoutBarrierShape,
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
const holdBulk = (barrier: CheckoutBarrierShape, path: string, release: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const inside = yield* Deferred.make<void>();
    const fiber = yield* barrier
      .bulk(path, Deferred.succeed(inside, undefined).pipe(Effect.andThen(Deferred.await(release))))
      .pipe(Effect.forkChild);
    yield* Deferred.await(inside);
    return fiber;
  });

// Admission has no event; observe its public epoch without starting a second test runtime.
const waitForBulkAdmission = Effect.fn("test.CheckoutBarrier.waitForBulkAdmission")(function* (
  barrier: CheckoutBarrierShape,
  path: string,
) {
  yield* barrier.current(path).pipe(
    Effect.repeat({
      until: (section) => section.epoch > 0,
    }),
  );
});

/**
 * Waits until `path`'s checkout epoch exceeds `before` (a bulk change located the checkout and
 * announced itself, so it holds or waits for the checkout it found) or until `fiber` ended
 * without doing so. Locating reads the disk, so a fixed number of scheduler turns is not enough
 * on a slow runner.
 */
const waitForBulkAnnounced = (
  barrier: CheckoutBarrierShape,
  path: string,
  before: number,
  fiber: Fiber.Fiber<unknown, unknown>,
) =>
  Effect.raceFirst(
    barrier
      .current(path)
      .pipe(Effect.repeat({ until: (section) => section.epoch > before }), Effect.asVoid),
    Fiber.await(fiber).pipe(Effect.asVoid),
  );

/** Forks a bulk change of `path` and returns once it has announced itself (or ended). */
const forkBulk = <A, E>(
  barrier: CheckoutBarrierShape,
  path: string,
  effect: Effect.Effect<A, E>,
  options?: { readonly missing?: "nearest" | "skip"; readonly detach?: boolean },
) =>
  Effect.gen(function* () {
    const before = (yield* barrier.current(path)).epoch;
    const change = barrier.bulk(path, effect, options);
    const fiber = yield* options?.detach ? Effect.forkDetach(change) : Effect.forkChild(change);
    yield* waitForBulkAnnounced(barrier, path, before, fiber);
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
      const bulk = yield* forkBulk(
        barrier,
        repo,
        Effect.sync(() => {
          mutated = true;
        }),
      );
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
      const during = yield* barrier
        .bulk(
          repo,
          Effect.flatMap(barrier.current(repo), (section) => Effect.fail(section.epoch)),
        )
        .pipe(Effect.flip);
      assert.equal(during, 1);
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

  it.effect("runs bulk changes of one checkout one at a time, joining nested ones", () =>
    Effect.gen(function* () {
      const { repo, paper } = yield* folders;
      const barrier = makeCheckoutBarrier();
      const seen: string[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* barrier.settleBeforeBulk(() => Effect.sync(() => seen.push("settled")));
          const release = yield* Deferred.make<void>();
          const outer = yield* holdBulk(barrier, repo, release);
          // A nested change of the same checkout, from inside, joins the held section.
          const second = yield* forkBulk(
            barrier,
            paper,
            Effect.sync(() => seen.push("second")),
          );
          // The second waits its turn: not even its settler runs while the first holds.
          assert.deepEqual(seen, ["settled"]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(outer);
          yield* Fiber.join(second);
          assert.deepEqual(seen, ["settled", "settled", "second"]);
          assert.equal(
            yield* barrier.bulk(repo, barrier.bulk(paper, Effect.succeed("nested"))),
            "nested",
          );
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reopens admission when a waiting bulk change is interrupted", () =>
    Effect.gen(function* () {
      const repo = "/synthetic/checkout";
      const barrier = makeCheckoutBarrier(() =>
        Effect.succeed({ root: repo, keys: ["synthetic-checkout"] }),
      );
      const release = yield* Deferred.make<void>();
      const application = yield* holdApplication(barrier, repo, release);
      const bulk = yield* barrier
        .bulk(repo, Effect.void)
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.equal((yield* barrier.current(repo)).epoch, 1);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(barrier.application(repo, () => Effect.void))),
      );
      yield* Fiber.interrupt(bulk);
      assert.equal((yield* barrier.current(repo)).epoch, 2);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(application);
      yield* barrier.application(repo, () => Effect.void);
    }).pipe(Effect.scoped),
  );

  it.effect("makes a bulk change of an enclosing checkout wait for and suspend inner ones", () =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const submodule = NodePath.join(repo, "vendor/sub");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(submodule, ".git"), { recursive: true }),
      );
      const barrier = makeCheckoutBarrier();
      const inner = yield* barrier.current(submodule);
      assert.notEqual(inner.key, (yield* barrier.current(repo)).key);
      assert.equal(inner.keys[1], (yield* barrier.current(repo)).key);
      const release = yield* Deferred.make<void>();
      const application = yield* holdApplication(barrier, submodule, release);
      let mutated = false;
      const bulk = yield* forkBulk(
        barrier,
        repo,
        Effect.sync(() => {
          mutated = true;
        }),
      );
      assert.isFalse(mutated);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(barrier.application(submodule, () => Effect.void))),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(application);
      yield* Fiber.join(bulk);
      assert.isTrue(mutated);
      // The outer change makes plans of the inner checkout stale too.
      assert.equal((yield* barrier.current(submodule)).epoch, inner.epoch + 2);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a detached task join a bulk section that has ended", () =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const barrier = makeCheckoutBarrier();
      const afterOuter = yield* Deferred.make<void>();
      let mutated = false;
      let detached:
        | Fiber.Fiber<void, CheckoutRecoveryRequiredError | CheckoutLookupError>
        | undefined;
      yield* barrier.bulk(
        repo,
        Effect.gen(function* () {
          // Started inside the section, it inherits the section and outlives it.
          detached = yield* Deferred.await(afterOuter).pipe(
            Effect.andThen(
              barrier.bulk(
                repo,
                Effect.sync(() => {
                  mutated = true;
                }),
              ),
            ),
            Effect.forkDetach,
          );
        }),
      );
      const release = yield* Deferred.make<void>();
      const application = yield* holdApplication(barrier, repo, release);
      const before = (yield* barrier.current(repo)).epoch;
      yield* Deferred.succeed(afterOuter, undefined);
      yield* waitForBulkAnnounced(barrier, repo, before, detached!);
      assert.isFalse(mutated);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(application);
      yield* Fiber.join(detached!);
      assert.isTrue(mutated);
      assert.equal((yield* barrier.current(repo)).epoch, 4);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a queued bulk change whose path now names another checkout", () =>
    Effect.gen(function* () {
      const { root, repo } = yield* folders;
      const barrier = makeCheckoutBarrier();
      const release = yield* Deferred.make<void>();
      const outer = yield* holdBulk(barrier, repo, release);
      let mutated = false;
      const queued = yield* forkBulk(
        barrier,
        repo,
        Effect.sync(() => {
          mutated = true;
        }),
      );
      // The checkout moves away and another takes its path.
      yield* Effect.promise(async () => {
        await NodeFSP.rename(repo, NodePath.join(root, "moved"));
        await NodeFSP.mkdir(NodePath.join(repo, ".git"), { recursive: true });
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(outer);
      const refused = yield* Effect.exit(Fiber.join(queued));
      assert.include(String(refused), "CheckoutLookupError");
      assert.isFalse(mutated);
    }).pipe(Effect.scoped),
  );

  it.effect("hands settlers an inner checkout's whole chain and summed epoch", () =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const submodule = NodePath.join(repo, "vendor/sub");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(submodule, ".git"), { recursive: true }),
      );
      const barrier = makeCheckoutBarrier();
      yield* barrier.bulk(repo, Effect.void);
      const handed: CheckoutSection[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* barrier.settleBeforeBulk((section) => Effect.sync(() => handed.push(section)));
          const inside = yield* barrier.bulk(submodule, barrier.current(submodule));
          assert.equal(handed[0]!.keys.length, 2);
          assert.equal(handed[0]!.epoch, inside.epoch);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("makes another fiber's change of the same checkout wait its turn", () =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const barrier = makeCheckoutBarrier();
      const order: string[] = [];
      let child: Fiber.Fiber<void, CheckoutRecoveryRequiredError | CheckoutLookupError> | undefined;
      yield* barrier.bulk(
        repo,
        Effect.gen(function* () {
          // Forked inside the section, it inherits it but does not own it.
          child = yield* forkBulk(
            barrier,
            repo,
            Effect.sync(() => {
              order.push("child");
            }),
            { detach: true },
          );
          order.push("owner");
        }),
      );
      yield* Fiber.join(child!);
      assert.deepEqual(order, ["owner", "child"]);
      assert.equal((yield* barrier.current(repo)).epoch, 4);
    }).pipe(Effect.scoped),
  );

  it.effect("reopens admission when an owner is interrupted while its child waits", () =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const barrier = makeCheckoutBarrier();
      const inside = yield* Deferred.make<void>();
      const owner = yield* barrier
        .bulk(
          repo,
          Effect.gen(function* () {
            yield* barrier.bulk(repo, Effect.void).pipe(Effect.forkChild);
            yield* Deferred.succeed(inside, undefined);
            return yield* Effect.never;
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(inside);
      yield* Fiber.interrupt(owner);
      yield* barrier.application(repo, () => Effect.void);
    }).pipe(Effect.scoped),
  );

  it.effect("runs a queued change of a vanished path without settlers when told to skip", () =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const worktree = NodePath.join(repo, "worktree");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(worktree, ".git"), { recursive: true }),
      );
      const barrier = makeCheckoutBarrier();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const outer = yield* holdBulk(barrier, worktree, release);
          let removed = false;
          const queued = yield* forkBulk(
            barrier,
            worktree,
            Effect.sync(() => {
              removed = true;
            }),
            { missing: "skip" },
          );
          // Gone meanwhile; a settler that would refuse its vanished checkout never runs.
          yield* Effect.promise(() => NodeFSP.rm(worktree, { recursive: true, force: true }));
          yield* barrier.settleBeforeBulk((section) =>
            Effect.fail(new CheckoutRecoveryRequiredError({ checkout: section.root })),
          );
          yield* Deferred.succeed(release, undefined).pipe(
            Effect.andThen(Effect.exit(Fiber.join(outer))),
          );
          yield* Fiber.join(queued);
          assert.isTrue(removed);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reports a folder it cannot examine as a typed failure", () =>
    Effect.gen(function* () {
      const { root } = yield* folders;
      const locked = NodePath.join(root, "locked");
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(locked, "inside"), { recursive: true });
          await NodeFSP.chmod(locked, 0o000);
        }),
        () => Effect.promise(() => NodeFSP.chmod(locked, 0o700)),
      );
      const barrier = makeCheckoutBarrier();
      const failure = yield* Effect.flip(
        barrier.bulk(NodePath.join(locked, "inside"), Effect.void),
      );
      assert.equal(failure._tag, "CheckoutLookupError");
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

  // A skipped change runs outside the barrier: no settler, no epoch.
  const skipsOutside = (barrier: CheckoutBarrierShape, path: string, observe: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* barrier.settleBeforeBulk((section) =>
          Effect.fail(new CheckoutRecoveryRequiredError({ checkout: section.root })),
        );
        let ran = false;
        yield* barrier.bulk(
          path,
          Effect.sync(() => {
            ran = true;
          }),
          { missing: "skip" },
        );
        assert.isTrue(ran);
        assert.equal((yield* barrier.current(observe)).epoch, 0);
      }),
    );

  it.effect.each([
    { name: "fails its identity read", read: "missing" },
    // Windows reports a missing identity as an error without a code.
    { name: "fails its identity read without an error code", read: "uncoded" },
    { name: "was read, leaving a stale nearest checkout", read: "after-identity" },
    { name: "leaves its enclosing checkout as the nearest", read: "before-marker" },
  ] as const)("skips a path removed while it is examined when that $name", ({ read }) =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const worktree = NodePath.join(repo, "worktree");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(worktree, ".git"), { recursive: true }),
      );
      const remove = () => NodeFSP.rm(worktree, { recursive: true, force: true });
      const key = platformFileIdentity.key.bind(platformFileIdentity);
      const identity = vi.spyOn(platformFileIdentity, "key").mockImplementation(async (path) => {
        // Gone after its `.git` was seen: before its own identity read, or after it.
        if (read !== "before-marker" && path === (read === "after-identity" ? repo : worktree))
          await remove();
        if (read === "uncoded" && path === worktree)
          throw new Error("File identity is unavailable.");
        return key(path);
      });
      // Gone after its real path was resolved and before its `.git` is looked for.
      const promises = NodeFS.promises;
      const lstat = promises.lstat.bind(promises);
      const marker = vi.spyOn(promises, "lstat").mockImplementation(async (file, ...rest) => {
        if (read === "before-marker" && file === NodePath.join(worktree, ".git")) await remove();
        return lstat(file, ...rest);
      });
      NodeModule.syncBuiltinESMExports();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          identity.mockRestore();
          marker.mockRestore();
          NodeModule.syncBuiltinESMExports();
        }),
      );
      yield* skipsOutside(makeCheckoutBarrier(), worktree, repo);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses, not skips, when an enclosing checkout vanishes but the path remains", () =>
    Effect.gen(function* () {
      const { repo } = yield* folders;
      const worktree = NodePath.join(repo, "worktree");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(worktree, ".git"), { recursive: true }),
      );
      const key = platformFileIdentity.key.bind(platformFileIdentity);
      const spy = vi.spyOn(platformFileIdentity, "key").mockImplementation(async (path) => {
        if (path === repo)
          throw Object.assign(new Error("ENOENT: the enclosing checkout moved"), {
            code: "ENOENT",
          });
        return key(path);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      let ran = false;
      const refused = yield* Effect.exit(
        makeCheckoutBarrier().bulk(
          worktree,
          Effect.sync(() => {
            ran = true;
          }),
          { missing: "skip" },
        ),
      );
      assert.include(String(refused), "CheckoutLookupError");
      assert.isFalse(ran);
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
const driverWith = (barrier: CheckoutBarrierShape) =>
  GitVcsDriver.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "scient-checkout-barrier-" })),
    Layer.provide(Layer.succeed(CheckoutBarrier, barrier)),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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
      yield* waitForBulkAdmission(barrier, root);
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

  it.live("a worktree removal by relative path waits for an application inside it", () => {
    const barrier = makeCheckoutBarrier();
    return Effect.gen(function* () {
      const root = yield* repository;
      git(root, "worktree", "add", "-q", "-b", "side", "target");
      const target = NodePath.join(root, "target");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const release = yield* Deferred.make<void>();
      const application = yield* holdApplication(barrier, target, release);
      const removing = yield* driver
        .removeWorktree({ cwd: root, path: "./target", force: true })
        .pipe(Effect.forkChild);
      yield* waitForBulkAdmission(barrier, target);
      assert.isTrue(yield* Effect.promise(() => NodeFSP.access(target).then(() => true)));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(application);
      yield* Fiber.join(removing);
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.access(target).then(
            () => true,
            () => false,
          ),
        ),
      );
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
      yield* waitForBulkAdmission(barrier, root);
      assert.deepEqual(restored, []);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(application);
      yield* Fiber.join(restoring);
      assert.deepEqual(restored, [root]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
