// SCIENT-FORK:START — checkpoint publication and non-UTF-8 filename tests.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous git fixture identifiers use node crypto.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - FileSystem takes string paths; the non-UTF-8 test needs a byte path.
import * as NodeFS from "node:fs";
import * as HostProcess from "@t3tools/shared/HostProcess";
// SCIENT-FORK:END
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import * as Metric from "effect/Metric";
import { assert, it } from "@effect/vitest";
import { expect, vi } from "@effect/vitest";

import { CheckpointRef, GitCommandError, VcsProcessExitError } from "@t3tools/contracts";
import { CommandAvailability } from "@t3tools/shared/shell";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as ServerConfig from "../config.ts";
import { gitCommandDuration, gitCommandsTotal } from "../observability/Metrics.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import type * as VcsDriver from "./VcsDriver.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const layerGitContract = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);
const layerGitCaptureContract = Layer.merge(
  layerGitContract,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

const makeCaptureStore = Effect.fn("test.makeCaptureStore")(function* (
  driver: VcsDriver.VcsDriver["Service"],
  cwd: string,
) {
  const repository = yield* driver.detectRepository(cwd);
  if (repository === null) return yield* Effect.die("Expected a test Git repository");
  const handle = { kind: repository.kind, repository, driver };
  return yield* CheckpointStore.make.pipe(
    Effect.provideService(VcsDriverRegistry.VcsDriverRegistry, {
      get: () => Effect.succeed(driver),
      detect: () => Effect.succeed(handle),
      resolve: () => Effect.succeed(handle),
    }),
  );
});

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: layerGitContract,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect("distinguishes a missing Git executable from an ordinary non-repository", () => {
  const commandAvailability = vi.fn(() => Effect.succeed(false));
  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const error = yield* driver.detectRepository("/workspace").pipe(Effect.flip);

    expect(error).toMatchObject({
      _tag: "VcsExecutableUnavailableError",
      operation: "GitVcsDriver.detectRepository",
      kind: "git",
      command: "git",
      cwd: "/workspace",
    });
    expect(commandAvailability).toHaveBeenCalledWith("git", { bypassCache: true });
  }).pipe(
    Effect.provideService(CommandAvailability, commandAvailability),
    Effect.provide(layerGitContract),
  );
});
it.effect("lists the fetch and push URLs of a partial clone remote", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-partial-clone-remotes-",
    });
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    yield* runGit(cwd, ["init"]);
    yield* runGit(cwd, ["remote", "add", "origin", "https://github.com/pingdotgg/t3code.git"]);
    yield* runGit(cwd, [
      "remote",
      "set-url",
      "--push",
      "origin",
      "git@github.com:octocat/t3code.git",
    ]);
    yield* runGit(cwd, ["config", "remote.origin.promisor", "true"]);
    yield* runGit(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);

    const result = yield* driver.listRemotes(cwd);
    assert.deepEqual(result.remotes, [
      {
        name: "origin",
        url: "https://github.com/pingdotgg/t3code.git",
        pushUrl: Option.some("git@github.com:octocat/t3code.git"),
        isPrimary: true,
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

const makeCheckpointFixture = Effect.fn("makeCheckpointFixture")(function* (
  driver: Effect.Success<ReturnType<typeof GitVcsDriver.makeVcsDriverShape>>,
  cwd: string,
  objectFormat: "sha1" | "sha256" = "sha1",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = (args: ReadonlyArray<string>) =>
    driver.execute({ operation: "checkpoint-test", cwd, args });
  yield* git(objectFormat === "sha256" ? ["init", "--object-format=sha256"] : ["init"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@test.com"]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "initial\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "initial"]);
  const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/test");
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "staged\n");
  yield* git(["add", "."]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "unstaged\n");
  return { git, checkpointRef };
});

it.effect("checkpoint capture skips untracked nested repositories without a commit", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-unborn-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const nested = "scratch/empty [repo]";
    yield* git(["init", nested]);
    yield* git(["init", "another empty"]);
    yield* fileSystem.writeFileString(path.join(cwd, nested, "private.txt"), "nested\n");
    yield* git(["init", "committed"]);
    yield* git([
      "-C",
      "committed",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    const nestedHead = (yield* git(["-C", "committed", "rev-parse", "HEAD"])).stdout.trim();
    yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "new\n");
    const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:untracked.txt`])).stdout, "new\n");
    assert.strictEqual((yield* git(["ls-tree", "-r", checkpointRef, "--", nested])).stdout, "");
    assert.strictEqual((yield* git(["ls-tree", checkpointRef, "--", "another empty"])).stdout, "");
    assert.strictEqual(
      (yield* git(["ls-tree", checkpointRef, "--", "committed"])).stdout,
      `160000 commit ${nestedHead}\tcommitted\n`,
    );
    assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
    assert.strictEqual(
      yield* fileSystem.readFileString(path.join(cwd, nested, "private.txt")),
      "nested\n",
    );
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.skipIf(!symlinksSupported)(
  "checkpoint capture writes its index into the real git dir when cwd is a symlinked subdirectory",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveRunner = yield* ProcessRunner.ProcessRunner;
      const indexFiles: string[] = [];
      const captureProcess = yield* VcsProcess.make.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) => {
            const indexFile = input.env?.GIT_INDEX_FILE;
            if (indexFile !== undefined) indexFiles.push(indexFile);
            return liveRunner.run(input);
          },
        }),
      );
      const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, captureProcess),
      );
      const sandbox = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-checkpoint-symlink-",
      });
      const repo = path.join(sandbox, "repo");
      const subdir = path.join(repo, "sub", "dir");
      const link = path.join(sandbox, "nest", "link");
      yield* fileSystem.makeDirectory(subdir, { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
      yield* fileSystem.symlink(subdir, link);
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, repo);
      // Git returns ../../.git from the target; resolving it against the link reaches the decoy.
      yield* git(["-C", sandbox, "init"]);
      yield* fileSystem.writeFileString(path.join(subdir, "nested.txt"), "from-link\n");
      const realCommonDir = yield* fileSystem.realPath(path.join(repo, ".git"));

      yield* driver.checkpoints.captureCheckpoint({ cwd: link, checkpointRef });

      assert.isTrue(indexFiles.length > 0);
      for (const indexFile of indexFiles) {
        assert.strictEqual(yield* fileSystem.realPath(path.dirname(indexFile)), realCommonDir);
      }
      assert.strictEqual(
        (yield* git(["show", `${checkpointRef}:sub/dir/nested.txt`])).stdout,
        "from-link\n",
      );
    }).pipe(Effect.scoped, Effect.provide(layerGitCaptureContract)),
);

it.effect("checkpoint capture keeps the shared index a split index still uses", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-split-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["config", "core.splitIndex", "true"]);
    yield* git(["config", "splitIndex.sharedIndexExpire", "now"]);
    yield* git(["update-index", "--split-index"]);
    yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "new\n");

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual((yield* git(["show", `${checkpointRef}:untracked.txt`])).stdout, "new\n");
    assert.strictEqual((yield* git(["ls-files", "--cached"])).stdout, "file.txt\n");
    assert.strictEqual((yield* git(["diff", "--cached", "--name-only"])).stdout, "file.txt\n");
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint recovery discovers nested HEAD independently of inherited GIT_DIR", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-git-dir-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["init", "empty"]);
    const originalIndex = yield* fs.readFile(path.join(cwd, ".git", "index"));
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.GIT_DIR;
        process.env.GIT_DIR = path.join(cwd, ".git");
        return previous;
      }),
      () => driver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.GIT_DIR;
          else process.env.GIT_DIR = previous;
        }),
    );
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    assert.strictEqual((yield* git(["ls-tree", "-r", checkpointRef, "--", "empty"])).stdout, "");
    assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git", "index")), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture still fails when a clean filter rejects a file", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-checkpoint-filter-failure-",
    });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* fileSystem.writeFileString(path.join(cwd, ".gitattributes"), "file.txt filter=reject\n");
    yield* git(["config", "filter.reject.clean", "false"]);
    yield* git(["config", "filter.reject.required", "true"]);
    const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));
    const originalObjects = (yield* git(["count-objects", "-v"])).stdout;
    let stagingObjects: string | undefined;
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.env?.GIT_OBJECT_DIRECTORY) stagingObjects = input.env.GIT_OBJECT_DIRECTORY;
          return liveProcess.run(input);
        },
      }),
    );

    const result = yield* Effect.result(
      captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
    );

    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure._tag, "VcsProcessExitError");
    }
    assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
    assert.strictEqual((yield* git(["count-objects", "-v"])).stdout, originalObjects);
    assert.isDefined(stagingObjects);
    assert.isFalse(yield* fileSystem.exists(path.dirname(stagingObjects!)));
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("refuses an oversized changed file without touching repository objects or refs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-size-limit-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const originalObjects = (yield* git(["count-objects", "-v"])).stdout;
    const largeFile = path.join(cwd, "large.bin");
    yield* fs.writeFileString(largeFile, "");
    yield* fs.truncate(largeFile, 513 * 1024 * 1024);

    const result = yield* Effect.exit(driver.checkpoints.captureCheckpoint({ cwd, checkpointRef }));
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      const error = Cause.findErrorOption(result.cause);
      assert.strictEqual(error._tag, "Some");
      if (error._tag === "Some") assert.match(error.value.message, /size limit/);
    }
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
    assert.strictEqual((yield* git(["count-objects", "-v"])).stdout, originalObjects);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("publishes a valid checkpoint without invoking receive hooks", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-no-receive-hook-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const receiveHook = path.join(cwd, ".git", "hooks", "pre-receive");
    yield* fs.writeFileString(receiveHook, "#!/bin/sh\nexit 42\n");
    yield* fs.chmod(receiveHook, 0o755);

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    assert.isTrue(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    yield* git(["fsck", "--connectivity-only", "--no-reflogs"]);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

// SCIENT-FORK:START — incremental checkpoint publication (loose and packed transfer).
// Objects in this repository's own object directory; in-pack counts every pack's
// copy, so objects re-sent for a capture show up here.
const countLocalObjects = (stats: string) =>
  [/^count: (\d+)$/m, /^in-pack: (\d+)$/m].reduce(
    (total, pattern) => total + Number(stats.match(pattern)?.[1]),
    0,
  );

const checkpointTransferScenarios = [
  "loose",
  "packed",
  "unborn",
  "worktree",
  "alternates",
  "size-limit",
] as const;

for (const scenario of checkpointTransferScenarios) {
  it.effect.each(
    (["loose", "pack"] as const).map((transfer) => ({
      caseTitle: `checkpoint capture adds only missing objects (repo=${scenario}, transfer=${transfer})`,
      transfer,
    })),
  )("$caseTitle", ({ transfer }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveProcess = yield* VcsProcess.VcsProcess;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-transfer-" });
      const gitIn = (cwd: string) => (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
        driver.execute({ operation: "checkpoint-test", cwd, args, ...(env ? { env } : {}) });
      const source = path.join(root, scenario === "alternates" ? "source" : "repo");
      const sourceGit = gitIn(source);
      yield* fs.makeDirectory(path.join(source, "data"), { recursive: true });
      yield* sourceGit(["init"]);
      yield* sourceGit(["config", "user.name", "Test"]);
      yield* sourceGit(["config", "user.email", "test@test.com"]);
      // More objects than fetch.unpackLimit, so Git keeps whatever pack it receives.
      for (let index = 0; index < 120; index++) {
        yield* fs.writeFileString(path.join(source, "data", `file-${index}`), `tracked ${index}\n`);
      }
      yield* fs.writeFileString(path.join(source, ".gitignore"), "ignored.log\n");
      yield* sourceGit(["add", "."]);
      if (scenario !== "unborn") yield* sourceGit(["commit", "-m", "initial"]);
      if (scenario === "packed") yield* sourceGit(["repack", "-adq"]);
      let cwd = source;
      if (scenario === "alternates") {
        cwd = path.join(root, "repo");
        yield* sourceGit(["clone", "--quiet", "--shared", source, cwd]);
      }
      if (scenario === "worktree") {
        cwd = path.join(root, "linked");
        yield* sourceGit(["worktree", "add", "--quiet", "--detach", cwd]);
      }
      const git = gitIn(cwd);
      if (transfer === "pack") {
        yield* git(["config", "transfer.unpackLimit", "1"]);
        // Keep a detached repack from writing while the fixture is removed.
        yield* git(["config", "maintenance.auto", "false"]);
      }
      if (scenario !== "unborn") {
        yield* fs.writeFileString(path.join(cwd, "data/file-0"), "staged\n");
        yield* git(["add", "data/file-0"]);
        yield* fs.writeFileString(path.join(cwd, "data/file-0"), "working\n");
        yield* fs.remove(path.join(cwd, "data/file-1"));
        yield* fs.rename(path.join(cwd, "data/file-2"), path.join(cwd, "data/renamed"));
      }
      yield* fs.writeFileString(path.join(cwd, "untracked"), "untracked\n");
      yield* fs.writeFileString(path.join(cwd, "ignored.log"), "ignored\n");
      let largeFiles = 0;
      if (scenario === "size-limit") {
        const globalConfig = path.join(root, "global-config");
        yield* fs.writeFileString(globalConfig, "[pack]\n\tpackSizeLimit = 1m\n");
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env.GIT_CONFIG_GLOBAL;
            process.env.GIT_CONFIG_GLOBAL = globalConfig;
            return previous;
          }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
              else process.env.GIT_CONFIG_GLOBAL = previous;
            }),
        );
        // Incompressible files that would need several 1 MiB packs.
        for (; largeFiles < 3; largeFiles++) {
          yield* fs.writeFile(
            path.join(cwd, `large-${largeFiles}`),
            NodeCrypto.randomBytes(700 * 1024),
          );
        }
      }
      const gitPath = Effect.fn(function* (name: string) {
        const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", name]);
        return result.stdout.trim();
      });
      const indexPath = yield* gitPath("index");
      const headPath = yield* gitPath("HEAD");
      const packDir = yield* gitPath("objects/pack");
      const countPacks = fs
        .readDirectory(packDir)
        .pipe(Effect.map((names) => names.filter((name) => name.endsWith(".pack")).length));
      const originalIndex = yield* fs.readFile(indexPath);
      const originalIndexMtime = (yield* fs.stat(indexPath)).mtime;
      const originalHead = yield* fs.readFileString(headPath);
      const originalRefs = (yield* git(["for-each-ref"])).stdout;
      const existingObjects = new Set(
        (yield* git(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])).stdout
          .split("\n")
          .filter(Boolean),
      );
      const objectsBefore = countLocalObjects((yield* git(["count-objects", "-v"])).stdout);
      const packsBefore = yield* countPacks;
      let commitOid: string | undefined;
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            liveProcess.run(input).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (input.args.includes("commit-tree")) commitOid = result.stdout.trim();
                }),
              ),
            ),
        }),
      );
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/transfer");

      yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // The published ref is the commit built in staging, byte for byte.
      assert.strictEqual((yield* git(["rev-parse", checkpointRef])).stdout.trim(), commitOid);
      const reachable = (yield* git(["rev-list", "--objects", checkpointRef])).stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ")[0]!);
      const missing = reachable.filter((oid) => !existingObjects.has(oid));
      // Commit, root and data trees, and the working and untracked blobs; unborn has
      // the 120 data blobs staged already, so only its trees, commit and untracked are new.
      assert.strictEqual(missing.length, (scenario === "unborn" ? 4 : 5) + largeFiles);
      assert.strictEqual(
        countLocalObjects((yield* git(["count-objects", "-v"])).stdout) - objectsBefore,
        missing.length,
      );
      // Small transfers stay loose like a small fetch; larger ones add one pack.
      assert.strictEqual((yield* countPacks) - packsBefore, transfer === "pack" ? 1 : 0);
      yield* git(["fsck", "--connectivity-only", "--no-reflogs"]);

      assert.deepEqual(yield* fs.readFile(indexPath), originalIndex);
      assert.deepEqual((yield* fs.stat(indexPath)).mtime, originalIndexMtime);
      assert.strictEqual(yield* fs.readFileString(headPath), originalHead);
      assert.strictEqual(
        (yield* git(["for-each-ref"])).stdout
          .split("\n")
          .filter((line) => !line.endsWith(`\t${checkpointRef}`))
          .join("\n"),
        originalRefs,
      );

      // Same tree as an index built from HEAD plus every nonignored working-tree file.
      const referenceEnv = { ...process.env, GIT_INDEX_FILE: path.join(root, "reference") };
      if (scenario !== "unborn") yield* git(["read-tree", "HEAD"], referenceEnv);
      yield* git(["add", "-A", "--", "."], referenceEnv);
      assert.strictEqual(
        (yield* git(["rev-parse", `${checkpointRef}^{tree}`])).stdout,
        (yield* git(["write-tree"], referenceEnv)).stdout,
      );
      const files = (yield* git(["ls-tree", "-r", "--name-only", checkpointRef])).stdout;
      assert.notInclude(files.split("\n"), "ignored.log");
      if (scenario !== "unborn") {
        assert.strictEqual(
          (yield* git(["show", `${checkpointRef}:data/file-0`])).stdout,
          "working\n",
        );
        assert.notInclude(files.split("\n"), "data/file-1");
        assert.include(files.split("\n"), "data/renamed");
      }
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
  );
}

it.effect.each(
  (["loose", "pack"] as const).map((transfer) => ({
    caseTitle: `checkpoint capture repeats without changes (transfer=${transfer})`,
    transfer,
  })),
)("$caseTitle", ({ transfer }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-repeat-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    if (transfer === "pack") {
      yield* git(["config", "transfer.unpackLimit", "1"]);
      yield* git(["config", "maintenance.auto", "false"]);
    }
    const indexPath = path.join(cwd, ".git", "index");
    const originalIndex = yield* fs.readFile(indexPath);
    const other = CheckpointRef.make("refs/t3/checkpoints/other");

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    const objectsAfterFirst = countLocalObjects((yield* git(["count-objects", "-v"])).stdout);
    // The same ref again, then another ref, with nothing changed in between.
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: other });

    const tree = (ref: string) =>
      git(["rev-parse", `${ref}^{tree}`]).pipe(Effect.map((result) => result.stdout));
    assert.strictEqual(yield* tree(other), yield* tree(checkpointRef));
    assert.strictEqual((yield* git(["show", `${other}:file.txt`])).stdout, "unstaged\n");
    // Only the new commit objects (none when the commit is identical) are added.
    assert.isAtMost(
      countLocalObjects((yield* git(["count-objects", "-v"])).stdout) - objectsAfterFirst,
      2,
    );
    yield* git(["fsck", "--connectivity-only", "--no-reflogs"]);
    assert.deepEqual(yield* fs.readFile(indexPath), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);
// SCIENT-FORK:END

it.effect("captures SHA-256 repositories with the same object format", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-sha256-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd, "sha256");

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    assert.isTrue(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture refuses a truncated nested repository listing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-truncated-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["init", "empty"]);
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) =>
          liveProcess
            .run(input)
            .pipe(
              Effect.map((result) =>
                input.args.includes("--others") ? { ...result, stdoutTruncated: true } : result,
              ),
            ),
      }),
    );

    const result = yield* Effect.result(
      captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
    );

    assert.strictEqual(result._tag, "Failure");
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture skips an ignored project while keeping its allowed sibling", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-ignored-" });
    const { git } = yield* makeCheckpointFixture(driver, parent);
    yield* fs.writeFileString(
      path.join(parent, ".gitignore"),
      "*\n!.gitignore\n!file.txt\n!keep/\n!keep/**\n",
    );
    const ignoredCwd = path.join(parent, "ignored");
    const keepCwd = path.join(parent, "keep");
    yield* fs.makeDirectory(ignoredCwd);
    yield* fs.makeDirectory(keepCwd);
    yield* fs.writeFileString(path.join(ignoredCwd, "secret.txt"), "private\n");
    yield* fs.writeFileString(path.join(keepCwd, "new.txt"), "new\n");
    const originalIndex = yield* fs.readFile(path.join(parent, ".git", "index"));
    const ignoredRef = CheckpointRef.make("refs/t3/checkpoints/ignored");
    const keepRef = CheckpointRef.make("refs/t3/checkpoints/keep");

    const ignored = yield* Effect.result(
      driver.checkpoints.captureCheckpoint({ cwd: ignoredCwd, checkpointRef: ignoredRef }),
    );
    yield* driver.checkpoints.captureCheckpoint({ cwd: keepCwd, checkpointRef: keepRef });

    assert.strictEqual((yield* git(["show", `${keepRef}:keep/new.txt`])).stdout, "new\n");
    assert.strictEqual((yield* git(["ls-tree", "-r", keepRef, "--", "ignored"])).stdout, "");
    assert.isFalse(
      yield* driver.checkpoints.hasCheckpointRef({ cwd: parent, checkpointRef: ignoredRef }),
    );
    assert.deepEqual(yield* fs.readFile(path.join(parent, ".git", "index")), originalIndex);
    assert.strictEqual(ignored._tag, "Failure");
    if (ignored._tag === "Failure") {
      assert.strictEqual(ignored.failure._tag, "VcsUnsupportedOperationError");
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each([
  { tracking: "committed-only", committed: ["committed.txt"], staged: [] },
  { tracking: "staged-only", committed: [], staged: ["staged.txt"] },
  { tracking: "mixed", committed: ["committed.txt"], staged: ["staged.txt"] },
])(
  "checkpoint capture keeps $tracking tracked edits but excludes new files in a project ignored later",
  ({ committed, staged }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-ignored-later-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, parent);
      const cwd = path.join(parent, "sub");
      yield* fs.makeDirectory(cwd);
      for (const file of committed) {
        yield* fs.writeFileString(path.join(cwd, file), "committed\n");
        yield* git(["add", `sub/${file}`]);
      }
      if (committed.length > 0) {
        yield* git(["commit", "-m", "track project"]);
      }
      for (const file of staged) {
        yield* fs.writeFileString(path.join(cwd, file), "staged\n");
        yield* git(["add", `sub/${file}`]);
      }
      const tracked = [...committed, ...staged];
      yield* fs.writeFileString(path.join(parent, ".gitignore"), "sub/\n");
      for (const file of tracked) {
        yield* fs.writeFileString(path.join(cwd, file), `${file} working\n`);
      }
      yield* fs.writeFileString(path.join(cwd, "secret.txt"), "private\n");
      const originalIndex = yield* fs.readFile(path.join(parent, ".git", "index"));

      const captured = yield* Effect.result(
        driver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
      );

      assert.deepEqual(yield* fs.readFile(path.join(parent, ".git", "index")), originalIndex);
      if (captured._tag === "Failure") return yield* captured.failure;
      assert.strictEqual(
        (yield* git(["ls-tree", "-r", "--name-only", checkpointRef, "--", "sub"])).stdout,
        tracked.map((file) => `sub/${file}\n`).join(""),
      );
      for (const file of tracked) {
        assert.strictEqual(
          (yield* git(["show", `${checkpointRef}:sub/${file}`])).stdout,
          `${file} working\n`,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each([
  { phase: "add", nestedRecovery: false, expireRecovery: false },
  { phase: "fetch", nestedRecovery: false, expireRecovery: false },
  { phase: "fetch", nestedRecovery: true, expireRecovery: false },
  { phase: "add", nestedRecovery: true, expireRecovery: false },
  { phase: "add", nestedRecovery: true, expireRecovery: true },
])(
  "checkpoint handles a $phase lock with nestedRecovery=$nestedRecovery, expireRecovery=$expireRecovery",
  ({ phase, nestedRecovery, expireRecovery }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveRunner = yield* ProcessRunner.ProcessRunner;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-ref-race-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      if (nestedRecovery) yield* git(["init", "empty"]);
      const originalIndex = yield* fs.readFile(path.join(cwd, ".git", "index"));
      const refLockPath = path.join(cwd, ".git", `${checkpointRef}.lock`);
      const failed = yield* Deferred.make<void>();
      const retryReached = yield* Deferred.make<void>();
      const allowRetry = yield* Deferred.make<void>();
      const clock = yield* Clock.Clock;
      const privateIndexes = new Set<string>();
      let racedAttempts = 0;
      let discoveries = 0;
      let stageError: VcsProcessExitError | undefined;
      const captureProcess = yield* VcsProcess.make.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) => {
            if (input.args.includes("--others")) discoveries += 1;
            if (input.env?.GIT_INDEX_FILE) privateIndexes.add(input.env.GIT_INDEX_FILE);
            const initialStage =
              phase === "add" &&
              nestedRecovery &&
              !input.args.some((arg) => arg.startsWith(":(exclude,literal)"));
            if (!input.args.includes(phase) || initialStage || ++racedAttempts !== 1) {
              return liveRunner.run(input);
            }
            const lockPath = phase === "add" ? `${input.env!.GIT_INDEX_FILE!}.lock` : refLockPath;
            return Effect.gen(function* () {
              yield* fs
                .makeDirectory(path.dirname(lockPath), { recursive: true })
                .pipe(Effect.orDie);
              yield* fs.writeFileString(lockPath, "concurrent ref writer").pipe(Effect.orDie);
              return yield* liveRunner.run(input).pipe(
                Effect.ensuring(fs.remove(lockPath).pipe(Effect.orDie)),
                Effect.tap(() => Deferred.succeed(failed, undefined)),
              );
            });
          },
        }),
      );
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            captureProcess.run(input).pipe(
              Effect.tapError((error) => {
                if (input.args.includes("add") && error._tag === "VcsProcessExitError")
                  stageError = error;
                return Effect.void;
              }),
            ),
        }),
      );
      const captureStore = yield* makeCaptureStore(captureDriver, cwd);
      const fiber = yield* captureStore.captureCheckpoint({ cwd, checkpointRef }).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          sleep: (duration) =>
            Duration.toMillis(duration) === 75
              ? Deferred.succeed(retryReached, undefined).pipe(
                  Effect.andThen(Deferred.await(allowRetry)),
                )
              : clock.sleep(duration),
        }),
        Effect.exit,
        Effect.forkScoped,
      );
      yield* Deferred.await(failed);
      yield* Deferred.await(retryReached);
      if (expireRecovery) yield* TestClock.adjust("5 seconds");
      else yield* Deferred.succeed(allowRetry, undefined);
      const result = yield* Fiber.join(fiber);
      if (expireRecovery) {
        if (Exit.isSuccess(result))
          return yield* Effect.die("Expected the recovery deadline to expire");
        const error = Cause.findErrorOption(result.cause);
        assert.isTrue(error._tag === "Some");
        if (error._tag === "Some") assert.strictEqual(error.value, stageError);
      } else assert.isTrue(Exit.isSuccess(result));
      assert.strictEqual(racedAttempts, expireRecovery ? 1 : 2);
      assert.strictEqual(discoveries, nestedRecovery ? 1 : 0);
      assert.strictEqual(privateIndexes.size, 1);
      assert.strictEqual(
        yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }),
        !expireRecovery,
      );
      for (const index of privateIndexes) {
        assert.isFalse(yield* fs.exists(index));
        assert.isFalse(yield* fs.exists(`${index}.lock`));
      }
      assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git", "index")), originalIndex);
    }).pipe(Effect.scoped, Effect.provide(layerGitCaptureContract)),
);

it.effect("checkpoint recovery preserves interruption and removes the private index", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-recovery-interrupt-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["init", "empty"]);
    const entered = yield* Deferred.make<void>();
    let privateIndex: string | undefined;
    let stagingObjects: string | undefined;
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.args.includes("add") && input.args.includes("-A")) {
            privateIndex = input.env?.GIT_INDEX_FILE;
            stagingObjects = input.env?.GIT_OBJECT_DIRECTORY;
          }
          return input.args.includes("--others")
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : liveProcess.run(input);
        },
      }),
    );
    const fiber = yield* captureDriver.checkpoints
      .captureCheckpoint({ cwd, checkpointRef })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
    assert.isDefined(privateIndex);
    assert.isFalse(yield* fs.exists(privateIndex!));
    assert.isDefined(stagingObjects);
    assert.isFalse(yield* fs.exists(path.dirname(stagingObjects!)));
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("bounds the whole capture and removes staging state when Git stalls", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-whole-timeout-" });
    const { checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const entered = yield* Deferred.make<void>();
    let privateIndex: string | undefined;
    let stagingObjects: string | undefined;
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.args.includes("add") && input.args.includes("-A")) {
            privateIndex = input.env?.GIT_INDEX_FILE;
            stagingObjects = input.env?.GIT_OBJECT_DIRECTORY;
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
          }
          return liveProcess.run(input);
        },
      }),
    );
    const fiber = yield* captureDriver.checkpoints
      .captureCheckpoint({ cwd, checkpointRef })
      .pipe(Effect.exit, Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("90 seconds");
    const result = yield* Fiber.join(fiber);
    assert.isTrue(Exit.isFailure(result));
    if (Exit.isFailure(result)) {
      const error = Cause.findErrorOption(result.cause);
      assert.strictEqual(error._tag, "Some");
      if (error._tag === "Some") assert.strictEqual(error.value._tag, "VcsProcessTimeoutError");
    }
    assert.isDefined(privateIndex);
    assert.isFalse(yield* fs.exists(privateIndex!));
    assert.isDefined(stagingObjects);
    assert.isFalse(yield* fs.exists(path.dirname(stagingObjects!)));
    assert.isFalse(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each(
  [false, true].flatMap((nested) =>
    (["sparse", "flags", "manual-skip", "missing", "non-cone-missing"] as const).map(
      (indexState) => ({ nested, indexState }),
    ),
  ),
)(
  "sparse checkpoint preserves two captures (nested=$nested, index=$indexState)",
  ({ nested, indexState }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-sparse-" });
      const { git } = yield* makeCheckpointFixture(driver, cwd);
      const write = Effect.fn(function* (name: string, contents: string) {
        yield* fs.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
        yield* fs.writeFileString(path.join(cwd, name), contents);
      });
      for (const name of [
        "scope/in/edit",
        "scope/in/delete",
        "scope/out/deep/absent",
        "scope/out/present",
        "elsewhere/file",
      ]) {
        yield* write(name, "original\n");
      }
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "sparse fixture"]);
      yield* git(["sparse-checkout", "set", "--cone", "--sparse-index", "scope/in", "elsewhere"]);
      if (indexState === "non-cone-missing")
        yield* git(["sparse-checkout", "set", "--no-cone", "/scope/in/", "/elsewhere/"]);
      yield* write("scope/in/edit", "staged\n");
      yield* write("elsewhere/file", "staged outside\n");
      yield* git(["add", "."]);
      if (indexState === "flags")
        yield* git(["update-index", "--assume-unchanged", "scope/in/delete"]);
      if (indexState === "manual-skip")
        yield* git(["update-index", "--skip-worktree", "scope/in/delete"]);
      yield* git(["config", "sparse.expectFilesOutsideOfPatterns", "true"]);
      yield* write("scope/in/edit", "working\n");
      yield* write("scope/out/present", "modified skipped\n");
      yield* write("scope/out/new file", "new outside cone\n");
      yield* write("elsewhere/file", "working outside\n");
      yield* fs.remove(path.join(cwd, "scope/in/delete"));
      const indexPath = path.join(cwd, ".git/index");
      if (indexState.endsWith("missing")) yield* fs.remove(indexPath);
      const originalIndex = yield* fs.readFile(indexPath).pipe(Effect.orElseSucceed(() => null));
      const captureCwd = nested ? path.join(cwd, "scope") : cwd;
      for (const turn of [1, 2]) {
        const ref = CheckpointRef.make(`refs/t3/checkpoints/sparse/${turn}`);
        if (turn === 2) {
          yield* write("scope/in/edit", "second\n");
          yield* fs.remove(path.join(cwd, "scope/out/new file"));
          yield* write("scope/out/second", "second addition\n");
        }
        const capture = driver.checkpoints.captureCheckpoint({
          cwd: captureCwd,
          checkpointRef: ref,
        });
        if (indexState === "non-cone-missing") {
          assert.strictEqual((yield* capture.pipe(Effect.flip))._tag, "VcsProcessExitError");
          assert.isFalse(
            yield* driver.checkpoints.hasCheckpointRef({ cwd: captureCwd, checkpointRef: ref }),
          );
          assert.isFalse(yield* fs.exists(indexPath));
          break;
        }
        yield* capture;
        for (const [name, content] of [
          ["scope/out/deep/absent", "original\n"],
          ["scope/out/present", "modified skipped\n"],
          ["scope/in/edit", turn === 1 ? "working\n" : "second\n"],
          ["elsewhere/file", nested ? "original\n" : "working outside\n"],
          [
            turn === 1 ? "scope/out/new file" : "scope/out/second",
            turn === 1 ? "new outside cone\n" : "second addition\n",
          ],
        ]) {
          assert.strictEqual((yield* git(["show", `${ref}:${name}`])).stdout, content);
        }
        const files = (yield* git(["ls-tree", "-rz", "--name-only", ref])).stdout.split("\0");
        assert.notInclude(files, "scope/in/delete");
        if (turn === 2) assert.notInclude(files, "scope/out/new file");
        assert.deepEqual(
          yield* fs.readFile(indexPath).pipe(Effect.orElseSucceed(() => null)),
          originalIndex,
        );
        assert.isFalse(yield* fs.exists(path.join(cwd, "scope/out/deep/absent")));
        assert.strictEqual(
          yield* fs.readFileString(path.join(cwd, "elsewhere/file")),
          "working outside\n",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each(
  (["normal", "flags", "sparse"] as const).flatMap((indexMode) =>
    [1, 3, 4096].map((chunkSize) => ({ indexMode, chunkSize })),
  ),
)(
  "checkpoint index inspection handles entries beyond the output cap (index=$indexMode, chunk=$chunkSize)",
  ({ indexMode, chunkSize }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const liveProcess = yield* VcsProcess.VcsProcess;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-inspection-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      yield* fs.writeFileString(path.join(cwd, ".gitattributes"), "stable filter=probe\n");
      yield* fs.writeFileString(path.join(cwd, "stable"), "unchanged\n");
      yield* fs.writeFileString(path.join(cwd, "z-skipped"), "original\n");
      yield* fs.makeDirectory(path.join(cwd, "excluded"));
      yield* fs.writeFileString(path.join(cwd, "excluded/file"), "absent\n");
      yield* fs.writeFileString(
        path.join(cwd, ".git/filter.cjs"),
        'require("node:fs").appendFileSync(".git/reads", "read\\n"); process.stdin.pipe(process.stdout);',
      );
      yield* git(["config", "filter.probe.clean", "node .git/filter.cjs"]);
      yield* fs.utimes(path.join(cwd, "stable"), 1_700_000_000, 1_700_000_000);
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "inspection fixture"]);
      if (indexMode === "flags") yield* git(["update-index", "--skip-worktree", "z-skipped"]);
      if (indexMode === "sparse")
        yield* git(["sparse-checkout", "set", "--cone", "--sparse-index", "included"]);
      yield* fs.writeFileString(path.join(cwd, "z-skipped"), "modified\n");
      yield* fs.writeFileString(path.join(cwd, ".git/reads"), "");
      const originalIndex = yield* fs.readFile(path.join(cwd, ".git/index"));
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            liveProcess.run(
              input.args.includes("ls-files")
                ? {
                    ...input,
                    maxOutputBytes: 8,
                    onStdoutChunk: (chunk) => {
                      for (let i = 0; i < chunk.length; i += chunkSize)
                        input.onStdoutChunk?.(chunk.subarray(i, i + chunkSize));
                    },
                  }
                : input,
            ),
        }),
      );
      yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      assert.strictEqual((yield* git(["show", `${checkpointRef}:z-skipped`])).stdout, "modified\n");
      if (indexMode !== "flags")
        assert.strictEqual(yield* fs.readFileString(path.join(cwd, ".git/reads")), "");
      assert.deepEqual(yield* fs.readFile(path.join(cwd, ".git/index")), originalIndex);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each([1_700_000_000, 1_700_000_000.9999])(
  "checkpoint capture preserves same-size edits with racy index timestamps (%s)",
  (timestamp) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-racy-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      const filePath = path.join(cwd, "file.txt");
      const indexPath = path.join(cwd, ".git", "index");
      yield* git(["config", "core.trustctime", "false"]);
      yield* fileSystem.writeFileString(filePath, "before\n");
      yield* fileSystem.utimes(filePath, timestamp, timestamp);
      yield* git(["add", "file.txt"]);
      yield* git(["commit", "-m", "record racy file"]);
      yield* fileSystem.utimes(indexPath, timestamp, timestamp);
      const originalIndex = yield* fileSystem.readFile(indexPath);
      const originalIndexMtime = (yield* fileSystem.stat(indexPath)).mtime;
      yield* fileSystem.writeFileString(filePath, "after!\n");
      yield* fileSystem.utimes(filePath, timestamp, timestamp);

      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "after!\n");
      assert.deepEqual(yield* fileSystem.readFile(indexPath), originalIndex);
      assert.deepEqual((yield* fileSystem.stat(indexPath)).mtime, originalIndexMtime);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("checkpoint capture preserves racy edits made after resetting the index", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-racy-reset-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const racyPath = path.join(cwd, "racy.txt");
    const indexPath = path.join(cwd, ".git", "index");
    const timestamp = 1_700_000_000;
    yield* git(["config", "core.trustctime", "false"]);
    yield* fileSystem.writeFileString(racyPath, "before\n");
    yield* fileSystem.utimes(racyPath, timestamp, timestamp);
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "record racy file"]);
    yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "staged\n");
    yield* git(["add", "file.txt"]);
    yield* fileSystem.utimes(indexPath, timestamp, timestamp);
    const originalIndex = yield* fileSystem.readFile(indexPath);
    const originalIndexMtime = (yield* fileSystem.stat(indexPath)).mtime;
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: Effect.fn(function* (input: VcsProcess.VcsProcessInput) {
          const result = yield* liveProcess.run(input);
          if (input.args.includes("read-tree") && input.args.includes("--reset")) {
            yield* fileSystem.writeFileString(racyPath, "after!\n").pipe(Effect.orDie);
            yield* fileSystem.utimes(racyPath, timestamp, timestamp).pipe(Effect.orDie);
          }
          return result;
        }),
      }),
    );

    yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual((yield* git(["show", `${checkpointRef}:racy.txt`])).stdout, "after!\n");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "staged\n");
    assert.deepEqual(yield* fileSystem.readFile(indexPath), originalIndex);
    assert.deepEqual((yield* fileSystem.stat(indexPath)).mtime, originalIndexMtime);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each(
  [false, true].flatMap((nested) =>
    (["normal", "flags", "split"] as const).map((indexMode) => ({ nested, indexMode })),
  ),
)(
  "checkpoint index reuse preserves two turns (nested=$nested, index=$indexMode)",
  ({ nested, indexMode }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-turns-" });
      const { git } = yield* makeCheckpointFixture(driver, cwd);
      const write = (name: string, contents: string) =>
        fileSystem.writeFileString(path.join(cwd, name), contents);
      yield* fileSystem.makeDirectory(path.join(cwd, "scope"));
      for (const name of [
        "scope/staged",
        "scope/deleted",
        "scope/assumed",
        "scope/skipped",
        "outside",
      ]) {
        yield* write(name, "original\n");
      }
      yield* git(["add", "."]);
      yield* git(["commit", "-m", "initial scoped files"]);
      yield* write("scope/staged", "staged\n");
      yield* write("scope/new-deleted", "staged then deleted\n");
      yield* write("outside", "staged outside\n");
      yield* git(["add", "."]);
      if (indexMode === "flags") {
        yield* git(["update-index", "--assume-unchanged", "scope/assumed"]);
        yield* git(["update-index", "--skip-worktree", "scope/skipped"]);
      }
      if (indexMode === "split") {
        yield* git(["update-index", "--split-index"]);
      }
      const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));
      for (const name of ["scope/staged", "scope/assumed", "scope/skipped", "outside"]) {
        yield* write(name, "working\n");
      }
      yield* write("scope/new", "first\n");
      yield* fileSystem.remove(path.join(cwd, "scope/deleted"));
      yield* fileSystem.remove(path.join(cwd, "scope/new-deleted"));
      const captureCwd = nested ? path.join(cwd, "scope") : cwd;
      const first = CheckpointRef.make("refs/t3/checkpoints/turns/1");
      const second = CheckpointRef.make("refs/t3/checkpoints/turns/2");
      yield* driver.checkpoints.captureCheckpoint({ cwd: captureCwd, checkpointRef: first });
      for (const name of ["scope/staged", "scope/assumed", "scope/skipped"]) {
        assert.strictEqual((yield* git(["show", `${first}:${name}`])).stdout, "working\n");
      }
      assert.strictEqual(
        (yield* git(["show", `${first}:outside`])).stdout,
        nested ? "original\n" : "working\n",
      );
      const files = (yield* git(["ls-tree", "-r", "--name-only", first])).stdout.split("\n");
      assert.notInclude(files, "scope/deleted");
      assert.notInclude(files, "scope/new-deleted");
      assert.include(files, "scope/new");

      yield* write("scope/staged", "second\n");
      yield* fileSystem.remove(path.join(cwd, "scope/new"));
      yield* write("scope/second", "added in second turn\n");
      yield* driver.checkpoints.captureCheckpoint({ cwd: captureCwd, checkpointRef: second });
      assert.strictEqual(
        (yield* git(["diff", "--name-only", first, second])).stdout,
        "scope/new\nscope/second\nscope/staged\n",
      );
      assert.strictEqual((yield* git(["show", `${second}:scope/staged`])).stdout, "second\n");
      assert.strictEqual(
        (yield* git(["show", `${second}:scope/second`])).stdout,
        "added in second turn\n",
      );
      assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each(["missing", "invalid"] as const)(
  "checkpoint capture falls back when the user index is %s",
  (indexState) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-index-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      const indexPath = path.join(cwd, ".git", "index");
      if (indexState === "missing") {
        yield* fileSystem.remove(indexPath);
      } else {
        yield* fileSystem.writeFileString(indexPath, "invalid index");
      }

      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
      if (indexState === "missing") {
        assert.isFalse(yield* fileSystem.exists(indexPath));
      } else {
        assert.strictEqual(yield* fileSystem.readFileString(indexPath), "invalid index");
      }
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("restores empty checkpoints without changing paths outside the workspace", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    for (const nested of [false, true]) {
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-empty-checkpoint-" });
      yield* runGit(root, ["init"]);
      yield* runGit(root, ["config", "user.email", "test@test.com"]);
      yield* runGit(root, ["config", "user.name", "Test"]);
      if (nested) {
        yield* fileSystem.writeFileString(path.join(root, "outside.txt"), "original\n");
        yield* runGit(root, ["add", "."]);
      }
      yield* runGit(root, ["commit", "--allow-empty", "-m", "initial"]);
      const cwd = nested ? path.join(root, "nested") : root;
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/empty");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      if (nested) {
        yield* fileSystem.writeFileString(path.join(root, "outside.txt"), "changed\n");
        yield* runGit(root, ["add", "outside.txt"]);
      }
      for (const staged of [false, true]) {
        const addedPath = path.join(cwd, "added.txt");
        yield* fileSystem.writeFileString(addedPath, "new\n");
        if (staged) yield* runGit(cwd, ["add", "added.txt"]);
        assert.isTrue(
          yield* driver.checkpoints.restoreCheckpoint({
            cwd,
            checkpointRef,
            fallbackToHead: false,
          }),
        );
        assert.isTrue(yield* fileSystem.exists(cwd));
        assert.isFalse(yield* fileSystem.exists(addedPath));
      }
      yield* fileSystem.writeFileString(
        path.join(root, ".git", "info", "exclude"),
        "ignored.txt\n",
      );
      yield* fileSystem.writeFileString(path.join(cwd, "ignored.txt"), "keep\n");
      yield* fileSystem.makeDirectory(path.join(cwd, "untracked"));
      yield* fileSystem.writeFileString(path.join(cwd, "untracked", "file.txt"), "remove\n");
      assert.isTrue(
        yield* driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
      );
      assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "ignored.txt")), "keep\n");
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "untracked")));
      if (nested) {
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(root, "outside.txt")),
          "changed\n",
        );
        const staged = yield* driver.execute({
          operation: "test",
          cwd: root,
          args: ["diff", "--cached", "--name-only"],
        });
        assert.strictEqual(staged.stdout.trim(), "outside.txt");
      }
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.each(["linux", "darwin", "win32"] as const)(
  "GitVcsDriver flushes checkpoint objects and refs before publication (%s)",
  (platform) => {
    const observedArgs: ReadonlyArray<string>[] = [];

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const liveProcess = yield* VcsProcess.VcsProcess;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkpoint-fsync-" });
      const { checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) => {
            observedArgs.push(input.args);
            return liveProcess.run(input);
          },
        }),
      );

      yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      // SCIENT-FORK:START — checkpoint publication may unpack loose objects.
      const writeCommands = [
        "add",
        "write-tree",
        "commit-tree",
        "unpack-objects",
        "update-ref",
        "fetch",
      ];
      // SCIENT-FORK:END
      const writes = observedArgs.filter((args) =>
        writeCommands.some((command) => args.includes(command)),
      );
      assert.strictEqual(writes.length, 5);
      for (const args of writes) {
        const command = args.findIndex((arg) => writeCommands.includes(arg));
        for (const setting of ["core.fsync=objects,reference", "core.fsyncMethod=fsync"]) {
          const index = args.indexOf(setting);
          assert.strictEqual(args[index - 1], "-c", args.join(" "));
          assert.isBelow(index, command);
        }
      }
      for (const args of writes) {
        const methods = args.filter((arg) => arg.startsWith("core.fsyncMethod="));
        assert.deepEqual(
          methods,
          platform === "linux"
            ? ["core.fsyncMethod=fsync"]
            : ["core.fsyncMethod=fsync", "core.fsyncMethod=batch"],
        );
      }
      assert.isTrue(writes.at(-1)?.includes("fetch"));
      assert.isTrue(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef }));
    }).pipe(
      Effect.scoped,
      Effect.provide(layerGitContract),
      Effect.provideService(HostProcess.Platform, platform),
    );
  },
);

it.effect("captures external and dangling symlinks without counting their targets", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "scient-checkpoint-links-" });
    const cwd = path.join(parent, "repo");
    yield* fs.makeDirectory(cwd);
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["config", "core.symlinks", "true"]);
    const target = path.join(parent, "large.bin");
    yield* fs.writeFileString(target, "");
    yield* fs.truncate(target, 513 * 1024 * 1024);
    for (const name of ["link-a", "link-b", "link-c"]) {
      yield* fs.symlink(target, path.join(cwd, name));
    }
    yield* fs.symlink("missing-target", path.join(cwd, "dangling"));
    const originalIndex = yield* fs.readFile(path.join(cwd, ".git", "index"));
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    expect((yield* git(["ls-tree", checkpointRef, "--", "link-a"])).stdout).toMatch(
      /^120000 blob /,
    );
    expect((yield* git(["show", `${checkpointRef}:link-a`])).stdout).toBe(target);
    expect((yield* git(["show", `${checkpointRef}:dangling`])).stdout).toBe("missing-target");
    expect(yield* fs.readFile(path.join(cwd, ".git", "index"))).toEqual(originalIndex);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect(
  "bounds only paths staged from a nested workspace and resolves them from the repository root",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-checkpoint-subdir-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      const nested = path.join(cwd, "nested");
      yield* fs.makeDirectory(nested);
      yield* fs.writeFileString(path.join(nested, "small.txt"), "small");
      const outside = path.join(cwd, "outside.bin");
      yield* fs.writeFileString(outside, "");
      yield* fs.truncate(outside, 513 * 1024 * 1024);
      yield* driver.checkpoints.captureCheckpoint({ cwd: nested, checkpointRef });
      expect((yield* git(["show", `${checkpointRef}:nested/small.txt`])).stdout).toBe("small");
      expect((yield* git(["ls-tree", checkpointRef, "--", "outside.bin"])).stdout).toBe("");
      yield* fs.rename(outside, path.join(nested, "inside.bin"));
      const refusedRef = CheckpointRef.make("refs/t3/checkpoints/refused");
      const result = yield* Effect.result(
        driver.checkpoints.captureCheckpoint({ cwd: nested, checkpointRef: refusedRef }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "VcsCheckpointUnavailableError", reason: "size-limit" },
      });
      expect(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef: refusedRef })).toBe(
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("counts hard-linked paths separately and declines the total before staging", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-checkpoint-hardlinks-" });
    const { checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const file = path.join(cwd, "large.bin");
    yield* fs.writeFileString(file, "");
    yield* fs.truncate(file, 300 * 1024 * 1024);
    for (const name of ["a.bin", "b.bin", "c.bin"]) yield* fs.link(file, path.join(cwd, name));
    const result = yield* Effect.result(
      driver.checkpoints.captureCheckpoint({ cwd, checkpointRef }),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "VcsCheckpointUnavailableError", reason: "size-limit" },
    });
    expect(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef })).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("tolerates a changed file deleted between enumeration and metadata lookup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-checkpoint-deletion-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    const vanished = path.join(cwd, "vanished.txt");
    yield* fs.writeFileString(vanished, "deleted during scan");
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) =>
          liveProcess
            .run(input)
            .pipe(
              Effect.tap(() =>
                input.args.includes("--porcelain=v1") ? fs.remove(vanished) : Effect.void,
              ),
            ),
      }),
    );
    yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    expect((yield* git(["ls-tree", checkpointRef, "--", "vanished.txt"])).stdout).toBe("");
    expect((yield* git(["show", `${checkpointRef}:file.txt`])).stdout).toBe("unstaged\n");
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

// SCIENT-FORK:START — streamed changed-path listing, including non-UTF-8 names.
it.effect(
  "captures complete streaming enumeration even when the diagnostic buffer is truncated",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const liveProcess = yield* VcsProcess.VcsProcess;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-checkpoint-path-limit-" });
      const { checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            liveProcess
              .run(input)
              .pipe(
                Effect.map((result) =>
                  input.args.includes("--porcelain=v1")
                    ? { ...result, stdoutTruncated: true }
                    : result,
                ),
              ),
        }),
      );
      yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      expect(yield* driver.checkpoints.hasCheckpointRef({ cwd, checkpointRef })).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.live("native checkpoint captures a complete changed-path listing above 16 MiB", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-checkpoint-large-list-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      const directory = path.join(
        cwd,
        ...Array.from({ length: 3 }, (_, n) => String(n) + "d".repeat(179)),
      );
      yield* fs.makeDirectory(directory, { recursive: true });
      // Many empty files exercise listing size without nearing the file-byte budget.
      // The records share long directories; a chunk never needs to hold the whole list.
      const count = 24_000;
      yield* Effect.forEach(
        Array.from({ length: count }, (_, n) => n),
        (n) =>
          fs.writeFileString(
            path.join(directory, String(n).padStart(6, "0") + "f".repeat(194)),
            "",
          ),
        { concurrency: 8, discard: true },
      );
      let listedBytes = 0;
      yield* driver.execute({
        operation: "large-list.test",
        cwd,
        args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        outputMode: "truncate",
        maxOutputBytes: 4096,
        onStdoutChunk: (chunk) => {
          listedBytes += chunk.byteLength;
        },
      });
      expect(listedBytes).toBeGreaterThan(16 * 1024 * 1024);
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      let capturedPaths = 0;
      yield* driver.execute({
        operation: "large-list.tree",
        cwd,
        args: ["ls-tree", "-r", "--name-only", "-z", checkpointRef],
        outputMode: "truncate",
        maxOutputBytes: 4096,
        onStdoutChunk: (chunk) => {
          for (const byte of chunk) if (byte === 0) capturedPaths += 1;
        },
      });
      expect(capturedPaths).toBe(count + 1);
      expect((yield* git(["show", `${checkpointRef}:file.txt`])).stdout).toBe("unstaged\n");
    }).pipe(Effect.provide(layerGitContract), Effect.timeout("80 seconds")),
  ),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "captures a changed file whose name is not valid UTF-8",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "scient-checkpoint-latin1-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      // "café.txt" in Latin-1, as an extracted archive can leave it; Linux accepts
      // any bytes but "/" and NUL in a name, and Git lists them unquoted with -z.
      NodeFS.writeFileSync(
        Buffer.concat([Buffer.from(`${cwd}/caf`), Buffer.from([0xe9]), Buffer.from(".txt")]),
        "latin-1\n",
      );

      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      assert.include(
        (yield* git(["ls-tree", "-r", "--name-only", checkpointRef])).stdout,
        '"caf\\351.txt"',
      );
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);
// SCIENT-FORK:END
// The real VCS process, spawning `command` wherever the driver runs git.
const vcsProcessSpawning = (command: string) =>
  Layer.effect(
    VcsProcess.VcsProcess,
    Effect.map(VcsProcess.make, (vcsProcess) =>
      VcsProcess.VcsProcess.of({ run: (input) => vcsProcess.run({ ...input, command }) }),
    ),
  ).pipe(Layer.provide(ProcessRunner.layer), Layer.provideMerge(NodeServices.layer));

it.effect("GitVcsDriver reports unavailable Git without confusing it with a non-repository", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-missing-git-" });
    const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provide(vcsProcessSpawning(path.join(cwd, "git"))),
    );

    assert.strictEqual(yield* driver.isInsideWorkTree(cwd), false);
    const detectionError = yield* driver.detectRepository(cwd).pipe(Effect.flip);
    assert.strictEqual(detectionError._tag, "VcsExecutableUnavailableError");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "GitVcsDriver detects a repository whose path contains a newline",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-newline-repo-" });
      const cwd = path.join(parent, "multi\nline");
      yield* fileSystem.makeDirectory(cwd);
      yield* runGit(cwd, ["init"]);
      const driver = yield* GitVcsDriver.makeVcsDriverShape();

      const repository = yield* driver.detectRepository(cwd);
      assert.strictEqual(repository?.rootPath, yield* fileSystem.realPath(cwd));
      assert.strictEqual(repository?.metadataPath, ".git");
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "GitVcsDriver still fails detection when git exists but cannot be spawned",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      // A file without the execute bit fails to spawn with a permission error.
      const notExecutable = yield* fileSystem.makeTempFileScoped({ prefix: "t3-git-" });
      const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provide(vcsProcessSpawning(notExecutable)),
      );

      const error = yield* driver.isInsideWorkTree(process.cwd()).pipe(Effect.flip);
      assert.strictEqual(error._tag, "VcsProcessSpawnError");
      const detectionError = yield* driver.detectRepository(process.cwd()).pipe(Effect.flip);
      assert.strictEqual(detectionError._tag, "VcsProcessSpawnError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const gitCommandCount = (operation: string, outcome: string) =>
  Metric.value(
    Metric.withAttributes(gitCommandsTotal, [
      ["operation", operation],
      ["outcome", outcome],
    ]),
  ).pipe(Effect.map((state) => state.count));

const gitCommandTiming = (operation: string) =>
  Metric.value(Metric.withAttributes(gitCommandDuration, [["operation", operation]]));

// Keep VcsProcess's exit classification; replace only the subprocess and its clock.
const makeMeteredDriver = Effect.fn("test.makeMeteredDriver")(function* (exitCode: number) {
  const process = yield* VcsProcess.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: () =>
        TestClock.adjust("250 millis").pipe(
          Effect.as({
            code: ChildProcessSpawner.ExitCode(exitCode),
            stdout: "git output",
            stderr: exitCode === 0 ? "" : "fatal: test failure",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
        ),
    }),
  );
  return yield* GitVcsDriver.makeVcsDriverShape().pipe(
    Effect.provideService(VcsProcess.VcsProcess, process),
  );
});

it.effect("GitVcsDriver meters each git command once under its operation", () =>
  Effect.gen(function* () {
    const operation = "GitVcsDriver.checkpoints.resolveHeadCommit";
    const driver = yield* makeMeteredDriver(0);

    const result = yield* driver.execute({ operation, cwd: "/repo", args: ["rev-parse", "HEAD"] });
    yield* driver.execute({ operation, cwd: "/another-repo", args: ["rev-parse", "other-ref"] });

    assert.strictEqual(result.stdout, "git output");
    assert.strictEqual(yield* gitCommandCount(operation, "success"), 2);
    assert.strictEqual(yield* gitCommandCount(operation, "failure"), 0);
    const timing = yield* gitCommandTiming(operation);
    assert.strictEqual(timing.count, 2);
    assert.strictEqual(timing.sum, 500);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ),
);

it.effect("GitVcsDriver counts an allowed non-zero exit as a success", () =>
  Effect.gen(function* () {
    const operation = "GitVcsDriver.checkpoints.hasHeadCommit";
    const driver = yield* makeMeteredDriver(1);

    const result = yield* driver.execute({
      operation,
      cwd: "/repo",
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
    });

    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(yield* gitCommandCount(operation, "success"), 1);
    assert.strictEqual(yield* gitCommandCount(operation, "failure"), 0);
    const timing = yield* gitCommandTiming(operation);
    assert.strictEqual(timing.count, 1);
    assert.strictEqual(timing.sum, 250);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ),
);

it.effect("GitVcsDriver counts a failed git command as a failure", () =>
  Effect.gen(function* () {
    const operation = "GitVcsDriver.checkpoints.resolveHeadCommit";
    const driver = yield* makeMeteredDriver(128);

    const error = yield* driver
      .execute({ operation, cwd: "/repo", args: ["rev-parse", "HEAD"] })
      .pipe(Effect.flip);

    assert.strictEqual(error._tag, "VcsProcessExitError");
    assert.strictEqual(yield* gitCommandCount(operation, "failure"), 1);
    assert.strictEqual(yield* gitCommandCount(operation, "success"), 0);
    const timing = yield* gitCommandTiming(operation);
    assert.strictEqual(timing.count, 1);
    assert.strictEqual(timing.sum, 250);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ),
);

it.effect("checkpoint capture meters every git process it starts, including streamed ones", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
    let started = 0;
    let streamed = 0;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const captureDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.operation === operation) {
            started++;
            if (input.onStdoutChunk !== undefined) streamed++;
          }
          return liveProcess.run(input);
        },
      }),
    );
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-metrics-" });
    const { checkpointRef } = yield* makeCheckpointFixture(driver, cwd);

    yield* captureDriver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.isAbove(streamed, 0);
    assert.strictEqual(yield* gitCommandCount(operation, "success"), started);
    assert.strictEqual(yield* gitCommandCount(operation, "failure"), 0);
    assert.strictEqual((yield* gitCommandTiming(operation)).count, started);
  }).pipe(
    Effect.scoped,
    Effect.provide(layerGitContract),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ),
);

it.effect("git metrics finalize cancellation without exposing arbitrary operation labels", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const process = yield* VcsProcess.make.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      }),
    );
    const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, process),
    );
    const operation = "arbitrary operation /private/path";
    const fiber = yield* driver
      .execute({ operation, cwd: "/repo", args: ["rev-parse", "HEAD"] })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("250 millis");
    yield* Fiber.interrupt(fiber);

    assert.strictEqual(yield* gitCommandCount("other", "interrupt"), 1);
    assert.strictEqual(yield* gitCommandCount(operation, "interrupt"), 0);
    const timing = yield* gitCommandTiming("other");
    assert.strictEqual(timing.count, 1);
    assert.strictEqual(timing.sum, 250);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ),
);

it.effect("git metrics count fsync fallback and transient retry subprocesses separately", () =>
  Effect.gen(function* () {
    const retryReady = yield* Deferred.make<void>();
    const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
    let attempts = 0;
    const process = yield* VcsProcess.make.pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: (input) =>
          Effect.gen(function* () {
            attempts++;
            yield* TestClock.adjust("250 millis");
            if (attempts === 2) {
              assert.include(input.args, "core.fsyncMethod=writeout-only");
              yield* Deferred.succeed(retryReady, undefined);
            }
            return {
              code: ChildProcessSpawner.ExitCode(attempts < 3 ? 128 : 0),
              stdout: "",
              stderr:
                attempts === 1
                  ? "fatal: fsync error on '.git/objects/test': Operation not supported"
                  : attempts === 2
                    ? "fatal: Unable to create '/repo/.git/index.lock': File exists."
                    : "",
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
    );
    const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, process),
    );
    const fiber = yield* driver
      .execute({ operation, cwd: "/repo", args: ["-c", "core.fsyncMethod=batch", "add"] })
      .pipe(Effect.forkChild);
    yield* Deferred.await(retryReady);
    yield* TestClock.adjust("75 millis");
    yield* Fiber.join(fiber);

    assert.strictEqual(attempts, 3);
    assert.strictEqual(yield* gitCommandCount(operation, "failure"), 2);
    assert.strictEqual(yield* gitCommandCount(operation, "success"), 1);
    const timing = yield* gitCommandTiming(operation);
    assert.strictEqual(timing.count, 3);
    assert.strictEqual(timing.sum, 750);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  ),
);
