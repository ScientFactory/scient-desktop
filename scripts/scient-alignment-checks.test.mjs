import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vite-plus/test";
import { selectBoundaries } from "./scient-alignment-checks.mjs";

const cli = fileURLToPath(new URL("./scient-alignment-checks.mjs", import.meta.url));
const ids = (paths) => selectBoundaries(paths).boundaries.map((row) => row.id);
const all = ["provider", "stop", "queue", "settings", "persistence", "reader"];
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    FS.rmSync(directory, { recursive: true, force: true });
});

test("provider composition checks untouched guidance, native lifetime and instance consumers", () => {
  assert.deepEqual(ids(["apps/server/src/provider/PiDriverComposition.ts"]), [
    "provider",
    "stop",
    "settings",
  ]);
  const provider = selectBoundaries(["packages/provider-pi/src/server/adapter.ts"]).boundaries.find(
    (row) => row.id === "provider",
  );
  assert.ok(
    provider.checks.native.includes("src/orchestration-v2/Adapters/PiNativeRuntime.live.test.ts"),
  );
  assert.ok(
    provider.checks.server.includes(
      "src/orchestration-v2/FullScientSkillInput.native.integration.test.ts",
    ),
  );
});

test("shared contracts and unknown consumers conservatively select all boundaries", () => {
  assert.deepEqual(ids(["packages/contracts/src/orchestrationV2.ts"]), all);
  assert.deepEqual(ids(["apps/server/src/a-new-consumer.ts"]), all);
  assert.deepEqual(selectBoundaries(["unmapped.ts"]).unknown, ["unmapped.ts"]);
});

test("chat changes select production Chromium interaction, not just policy units", () => {
  const selection = selectBoundaries(["apps/web/src/components/chat/MessagesTimeline.tsx"]);
  assert.deepEqual(
    selection.boundaries.map((row) => row.id),
    ["reader"],
  );
  assert.ok(
    selection.boundaries[0].checks["web-layout"].includes(
      "src/components/chat/responseFollow.browser.test.tsx",
    ),
  );
});

test("adapter, session and ChatView changes include their untouched authority consumers", () => {
  assert.ok(
    ids(["apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts"]).includes("provider"),
  );
  assert.ok(
    ids(["apps/server/src/orchestration-v2/ProviderSessionManager.ts"]).includes("settings"),
  );
  for (const consumer of ["Orchestrator.ts", "ProviderTurnStartService.ts"]) {
    const selected = ids([`apps/server/src/orchestration-v2/${consumer}`]);
    assert.ok(selected.includes("provider"));
    assert.ok(selected.includes("settings"));
  }
  assert.deepEqual(ids(["apps/web/src/components/ChatView.tsx"]), ["stop", "queue", "reader"]);
});

test("maintainer prose and reference repositories are explicit exclusions, runtime guidance is not", () => {
  assert.deepEqual(ids(["docs/internals/overview.md", ".repos/example/a.ts"]), []);
  assert.deepEqual(ids(["AGENTS.md"]), all);
  assert.deepEqual(ids(["apps/server/src/provider/instructions.md"]), [
    "provider",
    "stop",
    "settings",
  ]);
});

function fixture() {
  const cwd = FS.mkdtempSync(Path.join(OS.tmpdir(), "scient-check-selector-"));
  directories.push(cwd);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", Path.join(cwd, "no-hooks"));
  FS.mkdirSync(Path.join(cwd, "apps/web/src/components/chat"), { recursive: true });
  FS.writeFileSync(Path.join(cwd, "apps/web/src/components/chat/deleted file.ts"), "old\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Selector fixture",
    "-c",
    "user.email=selector@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  return { cwd, git };
}

test("external --cwd diff includes deletions, staged renames and untracked consumers without changing index", () => {
  const { cwd, git } = fixture();
  git("mv", "apps/web/src/components/chat/deleted file.ts", "renamed file.ts");
  FS.writeFileSync(Path.join(cwd, "untracked consumer.ts"), "new\n");
  const before = git("status", "--porcelain=v1");
  const result = spawnSync(process.execPath, [cli, "--cwd", cwd, "--base", "HEAD"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.cwd, FS.realpathSync(cwd));
  assert.deepEqual(plan.paths.sort(), [
    "apps/web/src/components/chat/deleted file.ts",
    "renamed file.ts",
    "untracked consumer.ts",
  ]);
  assert.deepEqual(plan.boundaries, all);
  assert.equal(plan.commands.find((command) => command.id === "native").included, false);
  assert.equal(git("status", "--porcelain=v1"), before);
});

test("missing target suite refuses execution before running a substring-filtered empty gate", () => {
  const { cwd } = fixture();
  const result = spawnSync(process.execPath, [cli, "--cwd", cwd, "--boundary", "reader", "--run"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unavailable check in target checkout/);
});

test("invalid scope and parent traversal are refused", () => {
  for (const args of [
    ["--all", "--base", "HEAD"],
    ["--boundary", "typo"],
    ["--path", "../other-checkout.ts"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
  }
});
