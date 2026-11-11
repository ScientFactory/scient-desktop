import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-scient-test-",
});
const layerTest = GitVcsDriver.layer.pipe(
  Layer.provideMerge(layerServerConfig),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const isUntrackedListing = (command: ChildProcess.Command) =>
  ChildProcess.isStandardCommand(command) &&
  command.args.includes("ls-files") &&
  command.args.includes("--others");

// The listing walks the whole untracked tree before the 5,000-path cap applies, so a folder
// that failed once costs the same on every status poll. Branch totals remember the failure and
// back off until the untracked roots change.
it.layer(layerTest)("branch change totals", (it) => {
  // A listing that fails (here: output past the limit) backs off like one over the cap.
  it.effect("do not repeat an untracked listing that failed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outer = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "git-untracked-error-" });
      yield* outer.execute({
        operation: "GitVcsDriver.test.git",
        cwd,
        args: ["init", "--quiet"],
        timeoutMs: 10_000,
      });
      yield* outer.execute({
        operation: "GitVcsDriver.test.git",
        cwd,
        args: ["config", "user.email", "test@test.com"],
        timeoutMs: 10_000,
      });
      yield* outer.execute({
        operation: "GitVcsDriver.test.git",
        cwd,
        args: ["config", "user.name", "Test"],
        timeoutMs: 10_000,
      });
      yield* fs.writeFileString(path.join(cwd, "README.md"), "# test\n");
      yield* outer.execute({
        operation: "GitVcsDriver.test.git",
        cwd,
        args: ["add", "."],
        timeoutMs: 10_000,
      });
      yield* outer.execute({
        operation: "GitVcsDriver.test.git",
        cwd,
        args: ["commit", "--quiet", "-m", "initial"],
        timeoutMs: 10_000,
      });
      yield* fs.writeFileString(path.join(cwd, "untracked.txt"), "new\n");
      let listings = 0;
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Stands in for a listing that floods its output past the 16 MiB limit.
      const flood = ChildProcess.make(process.execPath, [
        "-e",
        "const b = Buffer.alloc(1 << 20, 120); (function w() { process.stdout.write(b, w); })();",
      ]);
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          if (
            ChildProcess.isStandardCommand(command) &&
            command.args.includes("ls-files") &&
            command.args.includes("--others")
          ) {
            listings++;
            return delegate.spawn(flood);
          }
          return delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const read = driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
      assert.strictEqual((yield* read).branchChanges, undefined);
      yield* read;
      assert.strictEqual(listings, 1, "the failed listing is not repeated within the backoff");
      yield* TestClock.adjust("1 minute");
      yield* read;
      assert.strictEqual(listings, 2);
    }),
  );

  it.effect("do not list untracked files again on every status read after a failed listing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outer = yield* GitVcsDriver.GitVcsDriver;
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        outer.execute({ operation: "GitVcsDriver.test.git", cwd, args, timeoutMs: 10_000 });
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "git-untracked-totals-" });
      yield* git(cwd, ["init", "--quiet"]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* fs.writeFileString(path.join(cwd, "README.md"), "# test\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "--quiet", "-m", "initial"]);
      const many = path.join(cwd, "many");
      yield* fs.makeDirectory(many);
      yield* Effect.forEach(
        Array.from({ length: 5_001 }, (_, index) => index),
        (index) => fs.writeFileString(path.join(many, `file-${index}`), ""),
        { concurrency: 64, discard: true },
      );

      let listings = 0;
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          if (isUntrackedListing(command)) listings++;
          return delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const read = driver.statusDetailsLocal(cwd, { includeBranchChanges: true });

      assert.strictEqual((yield* read).branchChanges, undefined, "too many files to count");
      assert.strictEqual(listings, 1);
      yield* read;
      yield* read;
      assert.strictEqual(listings, 1, "the failed listing is not repeated within the backoff");

      yield* TestClock.adjust("1 minute");
      yield* read;
      assert.strictEqual(listings, 2, "it is retried once the backoff passes");
      yield* TestClock.adjust("1 minute");
      yield* read;
      assert.strictEqual(listings, 2, "and the next backoff is longer");

      // A change at the untracked-roots level scans again at once and counts again.
      yield* fs.remove(many, { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "notes.txt"), "one\ntwo\n");
      const status = yield* read;
      assert.strictEqual(listings, 3);
      assert.deepStrictEqual(status.branchChanges, { baseRef: null, insertions: 2, deletions: 0 });
    }),
  );

  // A slow listing would otherwise be repeated by every read that a file change starts meanwhile.
  it.effect("share one listing between overlapping status reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outer = yield* GitVcsDriver.GitVcsDriver;
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        outer.execute({ operation: "GitVcsDriver.test.git", cwd, args, timeoutMs: 10_000 });
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "git-untracked-shared-" });
      yield* git(cwd, ["init", "--quiet", "--initial-branch=main"]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* fs.writeFileString(path.join(cwd, "README.md"), "# test\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "--quiet", "-m", "initial"]);
      yield* fs.writeFileString(path.join(cwd, "notes.txt"), "one\ntwo\n");

      const firstListing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const secondReadAtListing = yield* Deferred.make<void>();
      let listings = 0;
      let branchChecks = 0;
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (isUntrackedListing(command) && ++listings === 1) {
            yield* Deferred.succeed(firstListing, undefined);
            yield* Deferred.await(release);
          }
          const handle = yield* delegate.spawn(command);
          // A read's branch check is its last Git command before the listing.
          const args = ChildProcess.isStandardCommand(command) ? command.args.map(String) : [];
          if (!args.includes("refs/heads/main") || ++branchChecks !== 2) return handle;
          return ChildProcessSpawner.makeHandle({
            ...handle,
            exitCode: handle.exitCode.pipe(
              Effect.tap(() => Deferred.succeed(secondReadAtListing, undefined)),
            ),
          });
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const read = driver.statusDetailsLocal(cwd, { includeBranchChanges: true });

      const first = yield* Effect.forkChild(read);
      yield* Deferred.await(firstListing);
      const second = yield* Effect.forkChild(read);
      yield* Deferred.await(secondReadAtListing);
      yield* Deferred.succeed(release, undefined);
      const totals = { baseRef: null, insertions: 2, deletions: 0 };
      assert.deepStrictEqual((yield* Fiber.join(first)).branchChanges, totals);
      assert.deepStrictEqual((yield* Fiber.join(second)).branchChanges, totals);
      assert.strictEqual(listings, 1, "the second read used the listing already running");
    }),
  );

  // Git ends a porcelain fetch with `maintenance run --auto`, detached by default: outside the
  // server's process group, it survives a quit, and on some Git versions several repack one
  // repository at once. The repository below would repack on its next fetch (two packs, limit
  // one), with maintenance in the foreground so Git's trace shows it.
  it.effect("automatic ref refreshes start no Git maintenance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        driver.execute({ operation: "GitVcsDriver.test.git", cwd, args, timeoutMs: 10_000 });
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "git-fetch-maintenance-" });
      const origin = path.join(root, "origin.git");
      const cwd = path.join(root, "work");
      yield* git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
      yield* git(root, ["init", "--quiet", "--initial-branch=main", cwd]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* git(cwd, ["remote", "add", "origin", origin]);
      for (const name of ["first", "second"]) {
        yield* fs.writeFileString(path.join(cwd, name), `${name}\n`);
        yield* git(cwd, ["add", name]);
        yield* git(cwd, ["-c", "maintenance.auto=false", "commit", "--quiet", "-m", name]);
        yield* git(cwd, ["-c", "maintenance.auto=false", "repack", "-d", "-q"]);
      }
      yield* git(cwd, ["push", "--quiet", "origin", "main"]);
      yield* git(cwd, ["config", "gc.autoPackLimit", "1"]);
      yield* git(cwd, ["config", "maintenance.autoDetach", "false"]);
      yield* git(cwd, ["config", "gc.autoDetach", "false"]);

      const trace = path.join(root, "trace2.jsonl");
      const env = yield* HostProcess.Environment;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = env.GIT_TRACE2_EVENT;
          env.GIT_TRACE2_EVENT = trace;
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete env.GIT_TRACE2_EVENT;
            else env.GIT_TRACE2_EVENT = previous;
          }),
      );

      assert.isNotNull(yield* driver.fetchWorktreeBaseCommit({ cwd, refName: "origin/main" }));
      yield* driver.fetchRemoteTrackingBranch({ cwd, remoteName: "origin", remoteBranch: "main" });

      const events = (yield* fs.readFileString(trace))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event?: string; argv?: ReadonlyArray<string> });
      const fetches = events.filter(
        (event) => event.event === "start" && event.argv?.includes("fetch"),
      );
      const maintenance = events.filter(
        (event) =>
          (event.event === "start" || event.event === "child_start") &&
          event.argv?.some((arg) => ["maintenance", "gc", "repack"].includes(arg)),
      );
      assert.isAtLeast(fetches.length, 2);
      assert.deepStrictEqual(
        maintenance.map((event) => event.argv),
        [],
      );
    }),
  );
});
