import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, test } from "vite-plus/test";
import { checkEnvironment, selectBoundaries } from "./scient-alignment-checks.mjs";

const cli = NodeURL.fileURLToPath(new URL("./scient-alignment-checks.mjs", import.meta.url));
const ids = (paths) => selectBoundaries(paths).boundaries.map((row) => row.id);
const all = ["provider", "stop", "queue", "settings", "persistence", "fork", "ownership", "reader"];
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

test("provider composition checks untouched guidance, native lifetime and instance consumers", () => {
  NodeAssert.deepEqual(ids(["apps/server/src/provider/PiDriverComposition.ts"]), all);
  const provider = selectBoundaries(["packages/provider-pi/src/server/adapter.ts"]).boundaries.find(
    (row) => row.id === "provider",
  );
  NodeAssert.ok(
    provider.checks.native.includes("src/orchestration-v2/Adapters/PiNativeRuntime.live.test.ts"),
  );
  NodeAssert.ok(provider.checks.server.includes("src/provider/ProviderRegistry.test.ts"));
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
  const settings = selectBoundaries(["packages/shared/src/scientModel.ts"]).boundaries.find(
    (row) => row.id === "settings",
  );
  NodeAssert.ok(settings.checks.server.includes("src/provider/ProviderRegistry.test.ts"));
  NodeAssert.ok(settings.checks.shared.includes("src/modelVisibility.test.ts"));
  NodeAssert.ok(settings.checks.shared.includes("src/projectSettings.test.ts"));
  NodeAssert.deepEqual(
    ids(["apps/mobile/src/features/settings/SettingsModelsRouteScreen.tsx"]),
    all,
  );
  NodeAssert.deepEqual(ids(["apps/server/src/orchestration-v2/EventSink.ts"]), all);
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
  NodeAssert.deepEqual(ids(["apps/web/src/components/ChatView.tsx"]), [
    "stop",
    "queue",
    "settings",
    "reader",
  ]);
  NodeAssert.ok(ids(["apps/web/src/components/chat/ModelPickerContent.tsx"]).includes("settings"));
});

test("composer hosts include settings, Stop and queue consumers and existing client witnesses", () => {
  for (const host of ["ChatComposer.tsx", "ComposerPrimaryActions.tsx"]) {
    NodeAssert.deepEqual(ids([`apps/web/src/components/chat/${host}`]), all);
  }
  const queue = selectBoundaries(["apps/web/src/scient/threadQueue/queueShortcuts.ts"]).boundaries;
  NodeAssert.deepEqual(
    queue.map((row) => row.id),
    ["queue"],
  );
  NodeAssert.ok(
    queue[0].checks["web-unit"].includes("src/scient/threadQueue/queueShortcuts.test.tsx"),
  );
  NodeAssert.ok(queue[0].checks["web-unit"].includes("src/scient/threadQueue/disposition.test.ts"));
  const stop = selectBoundaries([
    "apps/web/src/components/chat/ComposerPrimaryActions.tsx",
  ]).boundaries.find((row) => row.id === "stop");
  NodeAssert.ok(
    stop.checks["web-unit"].includes("src/components/chat/ComposerPrimaryActions.test.tsx"),
  );
  const unknown = "apps/web/src/components/chat/NewComposerHost.tsx";
  NodeAssert.deepEqual(ids([unknown]), all);
  NodeAssert.deepEqual(selectBoundaries([unknown]).unknown, [unknown]);
});

test("server and desktop owner paths select the one-owner promise", () => {
  for (const path of [
    "apps/server/src/serverOwnership.ts",
    "apps/server/src/server.ts",
    "apps/desktop/src/backend/DesktopBackendPool.ts",
  ]) {
    NodeAssert.deepEqual(ids([path]), ["ownership"]);
  }
  NodeAssert.ok(!ids(["apps/server/src/serverSettings.ts"]).includes("ownership"));
});

test("checks replace the desktop host's variables with a synthetic home and keep test inputs", () => {
  NodeAssert.deepEqual(
    checkEnvironment(
      {
        ELECTRON_RUN_AS_NODE: "1",
        T3CODE_HOME: "live",
        T3CODE_CLI_PATH: "live",
        Scient_Next_Home: "live",
        SCIENT_NEXT_SAFETY_ENVELOPE: "true",
        SCIENT_ANALYTICS_ENABLED: "true",
        SCIENT_PI_TEST_BINARY: "/opt/pi",
        T3CODE_TRANSFER_BUDGET_REPORT_PATH: "report.json",
        PATH: "bin",
      },
      "synthetic",
    ),
    {
      SCIENT_PI_TEST_BINARY: "/opt/pi",
      T3CODE_TRANSFER_BUDGET_REPORT_PATH: "report.json",
      PATH: "bin",
      SCIENT_NEXT_HOME: "synthetic",
      T3CODE_HOME: "synthetic",
    },
  );
});

test("maintainer prose and reference repositories are explicit exclusions, runtime guidance is not", () => {
  NodeAssert.deepEqual(ids(["docs/internals/overview.md", ".repos/example/a.ts"]), []);
  NodeAssert.deepEqual(ids(["AGENTS.md"]), all);
  NodeAssert.deepEqual(ids(["apps/server/src/provider/instructions.md"]), all);
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

test("staged provider impact survives restoration of working bytes without unstaging", () => {
  const { cwd, git } = fixture();
  const path = "apps/server/src/provider/PiDriverComposition.ts";
  const file = NodePath.join(cwd, path);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, "base\n");
  git("add", path);
  git(
    "-c",
    "user.name=Selector fixture",
    "-c",
    "user.email=selector@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "provider base",
  );
  NodeFS.writeFileSync(file, "staged policy\n");
  git("add", path);
  NodeFS.writeFileSync(file, "base\n");
  NodeAssert.equal(git("status", "--porcelain=v1"), `MM ${path}\n`);
  const index = NodeFS.readFileSync(NodePath.join(cwd, ".git/index"));
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [cli, "--cwd", cwd, "--base", "HEAD"],
    { encoding: "utf8" },
  );
  NodeAssert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  NodeAssert.deepEqual(plan.paths, [path]);
  NodeAssert.deepEqual(plan.boundaries, all);
  NodeAssert.deepEqual(NodeFS.readFileSync(NodePath.join(cwd, ".git/index")), index);
});

test("committed, index, working and untracked impacts remain unioned across reversals", () => {
  const { cwd, git } = fixture();
  const base = git("rev-parse", "HEAD").trim();
  const committed = "committed consumer.ts";
  NodeFS.writeFileSync(NodePath.join(cwd, committed), "committed\n");
  git("add", committed);
  git(
    "-c",
    "user.name=Selector fixture",
    "-c",
    "user.email=selector@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "committed consumer",
  );
  git("rm", committed);
  const original = "apps/web/src/components/chat/deleted file.ts";
  const renamed = "renamed file.ts";
  git("mv", original, renamed);
  NodeFS.renameSync(NodePath.join(cwd, renamed), NodePath.join(cwd, original));
  NodeFS.writeFileSync(NodePath.join(cwd, "untracked consumer.ts"), "untracked\n");
  const index = NodeFS.readFileSync(NodePath.join(cwd, ".git/index"));
  const before = git("status", "--porcelain=v1");
  const result = NodeChildProcess.spawnSync(process.execPath, [cli, "--cwd", cwd, "--base", base], {
    encoding: "utf8",
  });
  NodeAssert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  NodeAssert.deepEqual(plan.paths.sort(), [original, committed, renamed, "untracked consumer.ts"]);
  NodeAssert.deepEqual(plan.boundaries, all);
  NodeAssert.equal(git("status", "--porcelain=v1"), before);
  NodeAssert.deepEqual(NodeFS.readFileSync(NodePath.join(cwd, ".git/index")), index);
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

test("a failing group does not hide later groups", () => {
  const { cwd } = fixture();
  const files = [
    "apps/server/src/serverRuntimeState.test.ts",
    "apps/web/src/components/chat/readerScrollPolicy.test.ts",
    "apps/web/src/components/chat/timelineScrollAnchoring.test.tsx",
    "apps/web/src/components/chat/readerScrolling.browser.test.tsx",
    "apps/web/src/components/chat/responseFollow.browser.test.tsx",
    "apps/web/src/components/chat/readingEnd.browser.test.tsx",
  ];
  for (const file of files) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cwd, file), "");
  }
  // A failing pnpm on PATH makes every group fail.
  const bin = NodePath.join(cwd, "fake-bin");
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(NodePath.join(bin, "pnpm"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  NodeFS.writeFileSync(NodePath.join(bin, "pnpm.cmd"), "@exit /b 1\r\n");
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [cli, "--cwd", cwd, "--boundary", "ownership", "--boundary", "reader", "--run"],
    {
      encoding: "utf8",
      env: { ...process.env, [pathKey]: `${bin}${NodePath.delimiter}${process.env[pathKey]}` },
    },
  );
  NodeAssert.equal(result.status, 1, result.stderr);
  NodeAssert.match(result.stdout, /Failed checks: server, web-unit, web-layout/);
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
