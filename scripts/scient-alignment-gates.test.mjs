import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, test, vi } from "vite-plus/test";
import { acquireGatesLock, main, serverWorkers } from "./scient-alignment-gates.mjs";

const cli = NodeURL.fileURLToPath(new URL("./scient-alignment-gates.mjs", import.meta.url));
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

// A fake pnpm: lint fails, the smoke step uses its home unless told not to, and
// any leaked host variable fails the step that sees it.
const fakePnpm = `
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("11.10.0"); process.exit(0); }
if (process.env.ELECTRON_RUN_AS_NODE || process.env.SCIENT_ANALYTICS_ENABLED) process.exit(9);
if (args.includes("lint")) process.exit(1);
if (args.includes("test:desktop-smoke") && !process.env.FAKE_SMOKE_IGNORES_HOME) {
  NodeFS.mkdirSync(NodePath.join(process.env.SCIENT_NEXT_HOME, "dev"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(process.env.SCIENT_NEXT_HOME, "dev", "state"), "");
}
if (process.env.FAKE_CALLS) NodeFS.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + "\\n");
const list = (name) => (process.env[name] ?? "").split(",").filter(Boolean);
if (args[0] === "-r" && args[1] === "ls") {
  const packages = ["a", "b", "untested"].map((name) => ({ name, path: NodePath.resolve("packages", name) }));
  console.log(JSON.stringify([{ name: "root", path: process.cwd() }, ...packages]));
}
const filter = args[args.indexOf("--filter") + 1];
if (args.includes("test") && filter === "!t3" && list("FAKE_FAILING_PACKAGES").length) {
  // vp's summary: the failing package ran to its failure and "a" was cancelled.
  if (!process.env.FAKE_NO_SUMMARY) {
    const failed = (exit_code) => ({ Spawned: { outcome: { Failed: { exit_code } } } });
    const code = Number(process.env.FAKE_FAIL_CODE ?? 1);
    const tasks = list("FAKE_FAILING_PACKAGES").map((name) => ({ package_name: name, task_name: "test", result: failed(code) }));
    tasks.push({ package_name: "a", task_name: "test", result: failed(137) });
    const dir = NodePath.join(process.env.VITE_CACHE_PATH, "v18");
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "last-summary.json"), JSON.stringify({ tasks, exit_code: 1 }));
  }
  process.exit(1);
}
if (process.env.FAKE_PASS_ALONE && args.includes("test")) process.exit(0);
if (args.includes("test") && list("FAKE_FAILING_PACKAGES").includes(filter)) process.exit(1);
if (args.includes("test") && filter === "t3") {
  const report = args.find((arg) => arg.startsWith("--outputFile.json=")).slice(18);
  const requested = args.filter((arg) => arg.endsWith(".test.ts"));
  const failing = args.includes("--fileParallelism")
    ? list("FAKE_SERVER_FAILS_IN_PARALLEL")
    : list("FAKE_SERVER_FAILS_ALONE").filter((file) => requested.includes(file));
  const testResults = [...new Set([...requested, ...failing])].map((file) => ({
    name: NodePath.resolve("apps/server", file),
    status: failing.includes(file) ? "failed" : "passed",
  }));
  NodeFS.writeFileSync(report, JSON.stringify({ testResults }));
  if (failing.length) process.exit(1);
}
`;

function fixture() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-gates-"));
  directories.push(cwd);
  const git = (...args) => NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "--quiet", "--initial-branch=main");
  git("config", "core.hooksPath", NodePath.join(cwd, "no-hooks"));
  NodeFS.writeFileSync(NodePath.join(cwd, "file.txt"), "content\n");
  for (const [name, scripts] of [
    ["a", { test: "x" }],
    ["b", { test: "x" }],
    ["untested", {}],
  ]) {
    NodeFS.mkdirSync(NodePath.join(cwd, "packages", name), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(cwd, "packages", name, "package.json"),
      JSON.stringify({ name, scripts }),
    );
  }
  git("add", ".");
  git("-c", "user.name=Gates", "-c", "user.email=gates@example.invalid", "commit", "-qm", "base");
  const bin = NodePath.join(cwd, "..", `${NodePath.basename(cwd)}-bin`);
  directories.push(bin);
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(NodePath.join(bin, "fake-pnpm.mjs"), fakePnpm);
  NodeFS.writeFileSync(
    NodePath.join(bin, "pnpm"),
    `#!/bin/sh\nexec "${process.execPath}" "${NodePath.join(bin, "fake-pnpm.mjs")}" "$@"\n`,
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(
    NodePath.join(bin, "pnpm.cmd"),
    `@"${process.execPath}" "%~dp0fake-pnpm.mjs" %*\r\n`,
  );
  return { cwd, bin };
}

function run({ cwd, bin }, args, env = {}) {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const result = NodeChildProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      [pathKey]: `${bin}${NodePath.delimiter}${process.env[pathKey]}`,
      ELECTRON_RUN_AS_NODE: "1",
      SCIENT_ANALYTICS_ENABLED: "true",
      ...env,
    },
  });
  const resultsPath = /Results: (.+results\.json)/u.exec(result.stdout)?.[1];
  const record = resultsPath ? JSON.parse(NodeFS.readFileSync(resultsPath, "utf8")) : null;
  if (resultsPath) directories.push(NodePath.dirname(resultsPath));
  return { ...result, record, statuses: record?.gates.map((gate) => [gate.id, gate.status]) };
}

test("one failing gate does not stop the rest, and host variables never reach a gate", () => {
  const result = run(fixture(), ["--tests"]);
  NodeAssert.equal(result.status, 1, result.stderr);
  NodeAssert.deepEqual(result.statuses, [
    ["fmt", "passed"],
    ["lint", "failed"],
    ["knip", "passed"],
    ["typecheck", "passed"],
    ["test", "passed"],
    ["build", "passed"],
    ["smoke", "passed"],
    ["brand", "passed"],
    ["diff-index", "passed"],
    ["diff-worktree", "passed"],
  ]);
  NodeAssert.equal(
    result.record.gates.find((gate) => gate.id === "knip").command,
    "pnpm run knip:check",
  );
  NodeAssert.equal(
    result.record.gates.find((gate) => gate.id === "typecheck").command,
    "pnpm run typecheck",
  );
  NodeAssert.equal(result.record.pnpm, "11.10.0");
  NodeAssert.equal(result.record.dirty, false);
  NodeAssert.match(result.stdout, /\| lint \| failed, \d+ s \|/u);
  NodeAssert.match(result.stdout, /Failed: lint/u);
});

test.each([
  ["vp's summary", {}, ["!t3", "a", "t3"], ["a"], ["b"]],
  ["a crash in the summary", { FAKE_FAIL_CODE: "134" }, ["!t3", "a", "t3"], ["a"], ["b"]],
  ["no summary", { FAKE_NO_SUMMARY: "1" }, ["!t3", "a", "b", "t3"], ["a", "b"], ["b"]],
  [
    "no summary and passes alone",
    { FAKE_NO_SUMMARY: "1", FAKE_PASS_ALONE: "1" },
    ["!t3", "a", "b", "t3"],
    ["a", "b"],
    ["(the aggregate failed, yet no package failed on its own)"],
  ],
])(
  "with %s, packages the aggregate did not finish rerun alone and the server still runs",
  (_name, extra, expectedFilters, rerun, failedPackages) => {
    const gates = fixture();
    const env = { FAKE_FAILING_PACKAGES: "b", FAKE_CALLS: NodePath.join(gates.bin, "calls.jsonl") };
    const result = run(gates, ["--only", "test", "--server-workers", "3"], { ...env, ...extra });
    NodeAssert.equal(result.status, 1, result.stderr);
    NodeAssert.deepEqual(result.record.gates[0].tests.packagesFailed, failedPackages);
    NodeAssert.deepEqual(result.record.gates[0].tests.packagesRerun, rerun);
    const calls = NodeFS.readFileSync(env.FAKE_CALLS, "utf8").trim().split("\n").map(JSON.parse);
    const filters = calls.filter((args) => args.includes("--filter")).map((args) => args[4]);
    NodeAssert.deepEqual(filters, expectedFilters);
    NodeAssert.ok(calls.at(-1).includes("--maxWorkers=3"));
    NodeAssert.match(result.stdout, /server \d+ s, 3 files at a time; failed packages: .+; rerun/u);
  },
);

test("a failed server file runs once more alone, and the gate fails either way", () => {
  const result = run(fixture(), ["--only", "test", "--server-workers", "4"], {
    FAKE_SERVER_FAILS_IN_PARALLEL: "src/flaky.test.ts,src/broken.test.ts",
    FAKE_SERVER_FAILS_ALONE: "src/broken.test.ts",
  });
  NodeAssert.equal(result.status, 1, result.stderr);
  const { server } = result.record.gates[0].tests;
  NodeAssert.deepEqual(server.failedAgainAlone, ["src/broken.test.ts"]);
  NodeAssert.deepEqual(server.passedWhenRerunAlone, ["src/flaky.test.ts"]);
  NodeAssert.match(
    result.stdout,
    /failed again alone: src\/broken\.test\.ts; passed when rerun alone: src\/flaky\.test\.ts \|/u,
  );
});

test("gates runs queue behind a live holder and take over a dead one's lock", () => {
  const commonDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-gates-lock-"));
  directories.push(commonDir);
  const release = acquireGatesLock(commonDir, { root: "first" });
  const dead = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]).pid;
  let waits = 0;
  const messages = [];
  const second = acquireGatesLock(commonDir, {
    root: "second",
    log: (line) => messages.push(line),
    // The live holder finishes during the second wait, then a crashed run leaves its lock.
    wait: () => {
      waits++;
      if (waits === 2) {
        release();
        NodeFS.mkdirSync(NodePath.join(commonDir, "scient-alignment-gates.lock"));
        NodeFS.writeFileSync(
          NodePath.join(commonDir, "scient-alignment-gates.lock", "owner.json"),
          JSON.stringify({ pid: dead, root: "crashed", started: "" }),
        );
      }
    },
  });
  NodeAssert.equal(waits, 2);
  NodeAssert.equal(messages.length, 1);
  NodeAssert.match(messages[0], /Waiting for the gates run in first/u);
  second();
  NodeAssert.equal(
    NodeFS.existsSync(NodePath.join(commonDir, "scient-alignment-gates.lock")),
    false,
  );
});

test("a run whose lock was taken over leaves the new owner's lock when it ends", () => {
  const commonDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-gates-lock-"));
  directories.push(commonDir);
  const lock = NodePath.join(commonDir, "scient-alignment-gates.lock");
  const first = acquireGatesLock(commonDir, { root: "first" });
  NodeFS.rmSync(lock, { recursive: true });
  const second = acquireGatesLock(commonDir, { root: "second" });
  first();
  NodeAssert.equal(NodeFS.existsSync(lock), true);
  second();
  NodeAssert.equal(NodeFS.existsSync(lock), false);
});

test("server workers leave half the cores free, need 4 GiB each, and stay between 1 and 6", () => {
  const GiB = 1024 ** 3;
  NodeAssert.equal(serverWorkers(18, 48 * GiB), 6);
  NodeAssert.equal(serverWorkers(8, 32 * GiB), 4);
  NodeAssert.equal(serverWorkers(8, 8 * GiB), 2);
  NodeAssert.equal(serverWorkers(1, 2 * GiB), 1);
});

test("a smoke run that ignores its synthetic home fails", () => {
  const result = run(fixture(), ["--only", "smoke"], { FAKE_SMOKE_IGNORES_HOME: "1" });
  NodeAssert.equal(result.status, 1, result.stderr);
  NodeAssert.deepEqual(result.statuses, [["smoke", "failed"]]);
  NodeAssert.equal(result.record.gates[0].reason, "the desktop did not use the synthetic home");
  NodeAssert.deepEqual(result.record.partial, ["smoke"]);
});

test("on Windows the local test aggregate is an explicit gap unless requested", () => {
  const { cwd, bin } = fixture();
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const original = process.env[pathKey];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.env[pathKey] = `${bin}${NodePath.delimiter}${original}`;
  try {
    NodeAssert.equal(main(["--only", "test,brand"], { cwd, platform: "win32" }), 0);
    const output = log.mock.calls.flat().join("\n");
    NodeAssert.match(output, /\| test \| not run: the local aggregate is not a supported/u);
    NodeAssert.match(output, /\| brand \| passed/u);
    NodeAssert.match(output, /Not run: test/u);
    const before = log.mock.calls.length;
    NodeAssert.equal(main(["--only", "test", "--tests"], { cwd, platform: "win32" }), 0);
    NodeAssert.match(log.mock.calls.slice(before).flat().join("\n"), /\| test \| passed/u);
  } finally {
    for (const [line] of log.mock.calls) {
      const results = /Results: (.+results\.json)/u.exec(String(line))?.[1];
      if (results) directories.push(NodePath.dirname(results));
    }
    process.env[pathKey] = original;
    log.mockRestore();
  }
});

test("unknown gates and arguments are refused", () => {
  for (const args of [["--only", "typo"], ["--only"], ["--fast"], ["--server-workers", "0"]]) {
    NodeAssert.equal(run(fixture(), args).status, 2);
  }
});
