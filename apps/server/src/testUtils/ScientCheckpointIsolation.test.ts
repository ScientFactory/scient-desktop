// @effect-diagnostics nodeBuiltinImport:off - these tests exercise native path aliases and Git metadata.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach } from "vite-plus/test";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { makeCheckpointIsolationGuard } from "./ScientCheckpointIsolation.test-support.ts";

let directory: string;
let commonDirectory: string;
beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-checkpoint-isolation-"));
  commonDirectory = NodePath.join(directory, ".git");
  NodeFS.mkdirSync(commonDirectory);
});
afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

it("rejects the checkout common directory even when cwd is a subdirectory", () => {
  const guard = makeCheckpointIsolationGuard(commonDirectory);
  assert.throws(
    () =>
      guard.check({
        cwd: NodePath.join(directory, "apps", "server"),
        gitCommonDir: commonDirectory,
      }),
    /independent checkpointWorkspace/,
  );
  assert.throws(() => guard.assertNoViolations(), /test checkout's Git directory/);
  guard.assertNoViolations();
});

it("allows an independent fixture common directory", () => {
  const fixture = NodePath.join(directory, "independent");
  NodeFS.mkdirSync(fixture);
  const guard = makeCheckpointIsolationGuard(commonDirectory);
  guard.check({ cwd: fixture, gitCommonDir: fixture });
  guard.assertNoViolations();
});

it("resolves checkout metadata only on the first capture, not setup or teardown", () => {
  let resolutions = 0;
  const guard = makeCheckpointIsolationGuard(() => {
    resolutions++;
    return commonDirectory;
  });
  guard.assertNoViolations();
  assert.equal(resolutions, 0);
  guard.check({ cwd: directory, gitCommonDir: directory });
  guard.check({ cwd: directory, gitCommonDir: directory });
  guard.assertNoViolations();
  assert.equal(resolutions, 1);
});

it("canonicalizes symlink aliases of the checkout common directory", () => {
  const alias = NodePath.join(directory, "alias");
  NodeFS.symlinkSync(commonDirectory, alias, "junction");
  const guard = makeCheckpointIsolationGuard(commonDirectory);
  assert.throws(() => guard.check({ cwd: directory, gitCommonDir: alias }), /test checkout/);
  assert.throws(() => guard.assertNoViolations(), /test checkout/);
});

it("rejects differently cased aliases on case-insensitive filesystems", (context) => {
  const alias = commonDirectory.toUpperCase();
  if (!NodeFS.existsSync(alias)) context.skip("Requires a case-insensitive filesystem");
  const guard = makeCheckpointIsolationGuard(commonDirectory);
  assert.throws(() => guard.check({ cwd: directory, gitCommonDir: alias }), /test checkout/);
  assert.throws(() => guard.assertNoViolations(), /test checkout/);
});

it("allows nonexistent directories supplied by mock Git drivers", () => {
  const guard = makeCheckpointIsolationGuard(commonDirectory);
  guard.check({ cwd: directory, gitCommonDir: NodePath.join(directory, "mock", ".git") });
  guard.assertNoViolations();
});

it.effect("a recovered checkpoint failure still fails the safety assertion", () =>
  Effect.gen(function* () {
    const guard = makeCheckpointIsolationGuard(commonDirectory);
    const status = yield* Effect.sync(() =>
      guard.check({ cwd: directory, gitCommonDir: commonDirectory }),
    ).pipe(Effect.catchCause(() => Effect.succeed("completed")));
    assert.equal(status, "completed");
    assert.throws(() => guard.assertNoViolations(), /test checkout's Git directory/);
  }),
);

it.live("rejects a real linked worktree that shares the forbidden common directory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("checkpoint-isolation-worktree");
      const linked = NodePath.join(cwd, "linked");
      NodeChildProcess.execFileSync("git", ["worktree", "add", "--detach", linked, "HEAD"], {
        cwd,
        stdio: "pipe",
      });
      const common = NodeChildProcess.execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: linked, encoding: "utf8" },
      ).trim();
      const guard = makeCheckpointIsolationGuard(NodePath.join(cwd, ".git"));
      assert.throws(() => guard.check({ cwd: linked, gitCommonDir: common }), /test checkout/);
      assert.throws(() => guard.assertNoViolations(), /test checkout/);
    }),
  ),
);

it.live("fails test teardown after a recovered source capture before staging", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const cwd = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
    const child = NodeChildProcess.spawnSync(
      platform === "win32" ? "pnpm.cmd" : "pnpm",
      ["exec", "vp", "test", "src/testUtils/ScientCheckpointIsolation.violation.test.ts"],
      {
        cwd,
        env: { ...process.env, SCIENT_CHECKPOINT_ISOLATION_VIOLATION: "1" },
        encoding: "utf8",
        timeout: 30_000,
        shell: platform === "win32",
      },
    );
    assert.equal(child.status, 1, child.stderr);
    assert.include(
      child.stdout + child.stderr,
      "Checkpoint capture must not use the test checkout",
    );
    assert.include(child.stdout, "guard-body-completed-without-staging");
  }),
);
