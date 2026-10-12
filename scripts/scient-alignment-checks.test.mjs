import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, test } from "vite-plus/test";
import { selectBoundaries } from "./scient-alignment-checks.mjs";

const cli = NodeURL.fileURLToPath(new URL("./scient-alignment-checks.mjs", import.meta.url));
const ids = (paths) => selectBoundaries(paths).boundaries.map((row) => row.id);
const all = ["provider", "stop", "queue", "settings", "persistence", "reader"];
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

test("provider composition checks untouched guidance, native lifetime and instance consumers", () => {
  NodeAssert.deepEqual(ids(["apps/server/src/provider/PiDriverComposition.ts"]), [
    "provider",
    "stop",
    "settings",
  ]);
  const provider = selectBoundaries(["packages/provider-pi/src/server/adapter.ts"]).boundaries.find(
    (row) => row.id === "provider",
  );
  NodeAssert.ok(
    provider.checks.native.includes("src/orchestration-v2/Adapters/PiNativeRuntime.live.test.ts"),
  );
  NodeAssert.ok(
    provider.checks.server.includes(
      "src/orchestration-v2/FullScientSkillInput.native.integration.test.ts",
    ),
  );
});

test("shared contracts and unknown consumers conservatively select all boundaries", () => {
  NodeAssert.deepEqual(ids(["packages/contracts/src/orchestrationV2.ts"]), all);
  NodeAssert.deepEqual(ids(["apps/server/src/a-new-consumer.ts"]), all);
  NodeAssert.deepEqual(selectBoundaries(["unmapped.ts"]).unknown, ["unmapped.ts"]);
});

test("chat changes select production Chromium interaction, not just policy units", () => {
  const selection = selectBoundaries(["apps/web/src/components/chat/MessagesTimeline.tsx"]);
  NodeAssert.deepEqual(
    selection.boundaries.map((row) => row.id),
    ["reader"],
  );
  NodeAssert.ok(
    selection.boundaries[0].checks["web-layout"].includes(
      "src/components/chat/responseFollow.browser.test.tsx",
    ),
  );
});

test("adapter, session and ChatView changes include their untouched authority consumers", () => {
  NodeAssert.ok(
    ids(["apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts"]).includes("provider"),
  );
  NodeAssert.ok(
    ids(["apps/server/src/orchestration-v2/ProviderSessionManager.ts"]).includes("settings"),
  );
  for (const consumer of ["Orchestrator.ts", "ProviderTurnStartService.ts"]) {
    const selected = ids([`apps/server/src/orchestration-v2/${consumer}`]);
    NodeAssert.ok(selected.includes("provider"));
    NodeAssert.ok(selected.includes("settings"));
  }
  NodeAssert.deepEqual(ids(["apps/web/src/components/ChatView.tsx"]), ["stop", "queue", "reader"]);
});

test("maintainer prose and reference repositories are explicit exclusions, runtime guidance is not", () => {
  NodeAssert.deepEqual(ids(["docs/internals/overview.md", ".repos/example/a.ts"]), []);
  NodeAssert.deepEqual(ids(["AGENTS.md"]), all);
  NodeAssert.deepEqual(ids(["apps/server/src/provider/instructions.md"]), [
    "provider",
    "stop",
    "settings",
  ]);
});

function fixture() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-check-selector-"));
  directories.push(cwd);
  const git = (...args) => NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", NodePath.join(cwd, "no-hooks"));
  NodeFS.mkdirSync(NodePath.join(cwd, "apps/web/src/components/chat"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cwd, "apps/web/src/components/chat/deleted file.ts"), "old\n");
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
  NodeFS.writeFileSync(NodePath.join(cwd, "untracked consumer.ts"), "new\n");
  const before = git("status", "--porcelain=v1");
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [cli, "--cwd", cwd, "--base", "HEAD"],
    {
      encoding: "utf8",
    },
  );
  NodeAssert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  NodeAssert.equal(plan.cwd, NodeFS.realpathSync(cwd));
  NodeAssert.deepEqual(plan.paths.sort(), [
    "apps/web/src/components/chat/deleted file.ts",
    "renamed file.ts",
    "untracked consumer.ts",
  ]);
  NodeAssert.deepEqual(plan.boundaries, all);
  NodeAssert.equal(plan.commands.find((command) => command.id === "native").included, false);
  NodeAssert.equal(git("status", "--porcelain=v1"), before);
});

test("missing target suite refuses execution before running a substring-filtered empty gate", () => {
  const { cwd } = fixture();
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [cli, "--cwd", cwd, "--boundary", "reader", "--run"],
    {
      encoding: "utf8",
    },
  );
  NodeAssert.equal(result.status, 2);
  NodeAssert.match(result.stderr, /Unavailable check in target checkout/);
});

test("invalid scope and parent traversal are refused", () => {
  for (const args of [
    ["--all", "--base", "HEAD"],
    ["--boundary", "typo"],
    ["--path", "../other-checkout.ts"],
  ]) {
    const result = NodeChildProcess.spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
    });
    NodeAssert.equal(result.status, 2);
  }
});
