import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, test } from "vite-plus/test";
import {
  checkEnvironment,
  compareFailures,
  readVitestReport,
  selectBoundaries,
} from "./scient-alignment-checks.mjs";

const cli = NodeURL.fileURLToPath(new URL("./scient-alignment-checks.mjs", import.meta.url));
const ids = (paths) => selectBoundaries(paths).boundaries.map((row) => row.id);
const all = [
  "provider",
  "stop",
  "adapters",
  "queue",
  "settings",
  "persistence",
  "fork",
  "ownership",
  "reader",
];
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

test("adapter protocol and run-lifecycle changes select every adapter suite", () => {
  for (const path of [
    "packages/effect-codex-app-server/src/protocol.ts",
    "apps/server/src/orchestration-v2/RunExecutionService.ts",
  ]) {
    const adapters = selectBoundaries([path]).boundaries.find((row) => row.id === "adapters");
    NodeAssert.ok(adapters.checks.server.includes("src/orchestration-v2/Adapters/"), path);
  }
});

test("every native provider integration suite, however nested, belongs to a boundary", () => {
  const server = NodeURL.fileURLToPath(new URL("../apps/server/", import.meta.url));
  const { boundaries } = JSON.parse(
    NodeFS.readFileSync(new URL("./scient-alignment-checks.json", import.meta.url), "utf8"),
  );
  const mapped = boundaries.flatMap((row) => row.checks.server ?? []);
  // A directory entry covers its nested suites; a file entry covers itself.
  const covered = (path) =>
    mapped.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
  const native = NodeFS.readdirSync(NodePath.join(server, "src"), { recursive: true })
    .map((name) => `src/${String(name).split(NodePath.sep).join("/")}`)
    .filter((path) => /(Native\w*|\.native)\.integration\.test\.ts$/u.test(path));
  NodeAssert.ok(
    native.includes("src/orchestration-v2/testkit/NativeReadingIdentity.integration.test.ts"),
  );
  NodeAssert.deepEqual(
    native.filter((path) => !covered(path)),
    [],
  );
});

test("a directory entry keeps live suites behind --native", () => {
  const commands = (...args) =>
    JSON.parse(
      NodeChildProcess.spawnSync(
        process.execPath,
        [cli, "--boundary", "adapters", "--boundary", "provider", ...args],
        {
          encoding: "utf8",
        },
      ).stdout,
    ).commands;
  const server = commands().find((command) => command.id === "server");
  NodeAssert.ok(server.files.includes("src/orchestration-v2/Adapters/"));
  NodeAssert.deepEqual(server.argv.slice(-2), ["--exclude", "**/*.live.test.ts"]);
  const native = commands("--native").find((command) => command.id === "native");
  NodeAssert.deepEqual(native.files, [
    "src/orchestration-v2/Adapters/PiNativeRuntime.live.test.ts",
  ]);
  NodeAssert.ok(!native.argv.includes("--exclude"));
  NodeAssert.equal(commands().find((command) => command.id === "native").included, false);
});

test("composer hosts include settings, Stop and queue consumers and existing client witnesses", () => {
  for (const host of ["ChatComposer.tsx", "ComposerPrimaryActions.tsx"]) {
    NodeAssert.deepEqual(ids([`apps/web/src/components/chat/${host}`]), all);
  }
  const queue = selectBoundaries(["apps/web/src/components/chat/queuedRunShortcuts.ts"]).boundaries;
  NodeAssert.deepEqual(
    queue.map((row) => row.id),
    ["queue"],
  );
  NodeAssert.ok(
    queue[0].checks["web-unit"].includes("src/components/chat/queuedRunShortcuts.test.tsx"),
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
  const adapters = NodeChildProcess.spawnSync(
    process.execPath,
    [cli, "--cwd", cwd, "--boundary", "adapters", "--run"],
    { encoding: "utf8" },
  );
  NodeAssert.equal(adapters.status, 2);
  NodeAssert.match(
    adapters.stderr,
    /Unavailable check in target checkout: src\/orchestration-v2\/Adapters\//,
  );
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

test("Vitest failures are named by test, file errors separately, and empty runs verify nothing", () => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-web-unit-report-"));
  directories.push(cwd);
  const report = NodePath.join(cwd, "vitest.json");
  NodeFS.writeFileSync(report, JSON.stringify(fakeVitestReport(cwd)));
  NodeAssert.deepEqual(readVitestReport(report, cwd, { status: 1, signal: null }), {
    failures: ["src/a.test.ts > a fails", "src/broken.test.ts > (file error)"],
    unavailable: null,
  });
  // An afterAll failure beside a known assertion failure keeps its own identity.
  const hooked = fakeVitestReport(cwd);
  hooked.testResults[0].message = "Error: afterAll cleanup failed";
  NodeFS.writeFileSync(report, JSON.stringify(hooked));
  const { failures } = readVitestReport(report, cwd, { status: 1, signal: null });
  NodeAssert.deepEqual(compareFailures(failures, ["src/a.test.ts > a fails"]).new, [
    "src/a.test.ts > (file error)",
    "src/broken.test.ts > (file error)",
  ]);
  // Runs that verified nothing are unavailable, never comparable failure IDs.
  const missing = NodePath.join(cwd, "missing.json");
  NodeAssert.match(
    readVitestReport(missing, cwd, { status: 1, signal: null }).unavailable,
    /no readable Vitest report/u,
  );
  NodeAssert.match(
    readVitestReport(report, cwd, { status: null, signal: "SIGKILL" }).unavailable,
    /terminated abnormally \(SIGKILL\)/u,
  );
  NodeFS.writeFileSync(report, JSON.stringify({ testResults: [] }));
  NodeAssert.deepEqual(readVitestReport(report, cwd, { status: 1, signal: null }), {
    failures: [],
    unavailable: "exit 1 without a recorded test failure",
  });
  NodeAssert.deepEqual(compareFailures(["new", "old"], ["old", "gone"]), {
    new: ["new"],
    preexisting: ["old"],
    noLongerFailing: ["gone"],
  });
});

function fakeVitestReport(cwd) {
  const file = (name) => `${cwd.split(NodePath.sep).join("/")}/${name}`;
  return {
    testResults: [
      {
        name: file("src/a.test.ts"),
        status: "failed",
        message: "",
        assertionResults: [
          { fullName: "a fails", status: "failed" },
          { fullName: "a passes", status: "passed" },
        ],
      },
      {
        name: file("src/broken.test.ts"),
        status: "failed",
        message: "Failed to load",
        assertionResults: [],
      },
      {
        name: file("src/b.test.ts"),
        status: "passed",
        message: "",
        assertionResults: [{ fullName: "b", status: "passed" }],
      },
    ],
  };
}

/** A fixture checkout whose pnpm writes FAKE_REPORT as the Vitest report (none when empty) and exits 1. */
function webUnitFixture() {
  const { cwd } = fixture();
  NodeFS.mkdirSync(NodePath.join(cwd, "apps/web"), { recursive: true });
  const bin = NodePath.join(cwd, "fake-bin");
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(
    NodePath.join(bin, "fake-pnpm.mjs"),
    `import * as NodeFS from "node:fs";
const out = process.argv.find((arg) => arg.startsWith("--outputFile.json="));
if (process.env.FAKE_REPORT) NodeFS.writeFileSync(out.slice("--outputFile.json=".length), process.env.FAKE_REPORT);
process.exit(1);
`,
  );
  NodeFS.writeFileSync(
    NodePath.join(bin, "pnpm"),
    `#!/bin/sh\nexec "${process.execPath}" "${NodePath.join(bin, "fake-pnpm.mjs")}" "$@"\n`,
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(
    NodePath.join(bin, "pnpm.cmd"),
    `@"${process.execPath}" "%~dp0fake-pnpm.mjs" %*\r\n`,
  );
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const report = JSON.stringify(fakeVitestReport(NodeFS.realpathSync(cwd) + "/apps/web"));
  return ({ withReport = true } = {}, ...args) => {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [cli, "--cwd", cwd, "--web-unit", "--run", ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          [pathKey]: `${bin}${NodePath.delimiter}${process.env[pathKey]}`,
          FAKE_REPORT: withReport ? report : "",
        },
      },
    );
    const match = /"failures": "(.+web-unit-failures\.json)"/u.exec(result.stdout)?.[1];
    const failuresPath = match && JSON.parse(`"${match}"`);
    if (failuresPath) directories.push(NodePath.dirname(failuresPath));
    return { ...result, failuresPath };
  };
}

test("the opt-in web unit lane fails only on failures its baseline does not have", () => {
  const run = webUnitFixture();
  const first = run();
  NodeAssert.equal(first.status, 1, first.stderr);
  NodeAssert.match(first.stdout, /Failed checks: web-unit-lane/u);
  const recorded = JSON.parse(NodeFS.readFileSync(first.failuresPath, "utf8"));
  NodeAssert.deepEqual(recorded.failures, [
    "src/a.test.ts > a fails",
    "src/broken.test.ts > (file error)",
  ]);
  NodeAssert.equal(recorded.unavailable, null);
  // The same failures on the base are pre-existing.
  const same = run({}, "--web-unit-baseline", first.failuresPath);
  NodeAssert.equal(same.status, 0, same.stdout);
  NodeAssert.match(same.stdout, /"preexisting": \[\s+"src\/a\.test\.ts > a fails"/u);
  // A failure the base did not have fails the lane.
  const baseline = NodePath.join(NodeOS.tmpdir(), `scient-web-unit-baseline-${process.pid}.json`);
  directories.push(baseline);
  NodeFS.writeFileSync(
    baseline,
    JSON.stringify({ failures: ["src/broken.test.ts > (file error)", "src/gone"] }),
  );
  const worse = run({}, "--web-unit-baseline", baseline);
  NodeAssert.equal(worse.status, 1, worse.stdout);
  NodeAssert.match(worse.stdout, /"new": \[\s+"src\/a\.test\.ts > a fails"\s+\]/u);
  NodeAssert.match(worse.stdout, /"noLongerFailing": \[\s+"src\/gone"\s+\]/u);
});

test("a web unit run without a report fails and cannot serve as a baseline", () => {
  const run = webUnitFixture();
  const base = run({ withReport: false });
  NodeAssert.equal(base.status, 1, base.stdout);
  NodeAssert.match(base.stdout, /"unavailable": "no readable Vitest report \(exit 1\)"/u);
  // Two report-less runs never compare equal: the baseline is refused.
  const candidate = run({ withReport: false }, "--web-unit-baseline", base.failuresPath);
  NodeAssert.equal(candidate.status, 2, candidate.stdout);
  NodeAssert.match(candidate.stderr, /verified nothing: no readable Vitest report/u);
  // Nor does a valid baseline excuse a candidate that verified nothing.
  const baseline = NodePath.join(NodeOS.tmpdir(), `scient-web-unit-empty-${process.pid}.json`);
  directories.push(baseline);
  NodeFS.writeFileSync(baseline, JSON.stringify({ failures: [], unavailable: null }));
  const excused = run({ withReport: false }, "--web-unit-baseline", baseline);
  NodeAssert.equal(excused.status, 1, excused.stdout);
  NodeAssert.doesNotMatch(excused.stdout, /"new":/u);
  NodeAssert.match(excused.stdout, /Failed checks: web-unit-lane/u);
});

test("the web unit lane is opt-in and its baseline needs it", () => {
  const plan = NodeChildProcess.spawnSync(process.execPath, [cli, "--web-unit"], {
    encoding: "utf8",
  });
  NodeAssert.equal(plan.status, 0, plan.stderr);
  const parsed = JSON.parse(plan.stdout);
  NodeAssert.deepEqual(parsed.boundaries, []);
  NodeAssert.match(parsed.webUnitLane.cost, /about 14 minutes/u);
  const reader = JSON.parse(
    NodeChildProcess.spawnSync(process.execPath, [cli, "--boundary", "reader"], {
      encoding: "utf8",
    }).stdout,
  );
  NodeAssert.equal(reader.webUnitLane, null);
  for (const args of [
    ["--web-unit-baseline", "base.json", "--all"],
    ["--web-unit", "--web-unit"],
  ]) {
    NodeAssert.equal(
      NodeChildProcess.spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" }).status,
      2,
    );
  }
});
