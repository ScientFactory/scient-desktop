#!/usr/bin/env node
// Final local alignment gates: serial, never stopping at a failure, with one
// recorded result per gate. Qualification evidence, not a qualification policy.
// SCIENT-FORK: the server suite runs its files in parallel, and one gates run per
// repository at a time (docs/internals/scripts.md#alignment-gates-and-receipt-facts).

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { makeCheckHome, runTool } from "./scient-alignment-checks.mjs";

const WINDOWS_TESTS =
  "not run: the local aggregate is not a supported Windows lane; hosted test qualification pending";

const GATES = [
  { id: "fmt", argv: ["pnpm", "exec", "vp", "fmt", "--check"] },
  { id: "lint", argv: ["pnpm", "exec", "vp", "lint", "--report-unused-disable-directives"] },
  // Hosted CI's check for unused files, dependencies and exports.
  { id: "knip", argv: ["pnpm", "run", "knip:check"] },
  // Includes Vite+ tasks, which no longer need matching package.json scripts.
  {
    id: "typecheck",
    argv: ["pnpm", "run", "typecheck"],
  },
  // `pnpm run test`, split so that one failing package cannot cancel the others.
  {
    id: "test",
    argv: ["pnpm", "run", "test"],
    command:
      "pnpm exec vp run --filter !t3 test; pnpm exec vp run --filter t3 test --fileParallelism",
    run: runTests,
    windows: WINDOWS_TESTS,
  },
  { id: "build", argv: ["pnpm", "run", "build"] },
  { id: "smoke", argv: ["pnpm", "run", "test:desktop-smoke"] },
  { id: "brand", argv: ["pnpm", "run", "brand:check"] },
  { id: "diff-index", argv: ["git", "diff", "--cached", "--check"] },
  { id: "diff-worktree", argv: ["git", "diff", "--check"] },
];

const GiB = 1024 ** 3;
const SERVER = { name: "t3", dir: "apps/server" };
// More failures than this point at a broken setup, and rerunning them would take long.
const RERUN_LIMIT = 20;
// Gates that load the whole machine wait for another worktree's run of them.
const HEAVY_GATES = new Set(["typecheck", "test", "build", "smoke"]);

/**
 * Parallel server test files: CI runs one per vCPU on 4-vCPU runners. Locally,
 * half the cores (efficiency cores count) leave room for the owner and other
 * work, at most six, and 4 GiB of memory each (a worker peaks near 1.5 GiB).
 */
export const serverWorkers = (cores = NodeOS.availableParallelism(), memory = NodeOS.totalmem()) =>
  Math.max(1, Math.min(6, Math.floor(cores / 2), Math.floor(memory / (4 * GiB))));

const runLogged = (argv, { root, home, log }) => {
  const fd = NodeFS.openSync(log, "a");
  try {
    return runTool(argv, { cwd: root, home, stdio: ["ignore", fd, fd] });
  } finally {
    NodeFS.closeSync(fd);
  }
};

const failedFiles = (reportPath, cwd) => {
  try {
    const report = JSON.parse(NodeFS.readFileSync(reportPath, "utf8"));
    return report.testResults
      .filter((file) => file.status === "failed")
      .map((file) => NodePath.relative(cwd, file.name).replaceAll("\\", "/"))
      .toSorted();
  } catch {
    return null;
  }
};

/**
 * vp's summary of the aggregate it just ran: package name -> exit code, 0 for a pass.
 * A cancelled package is killed (137) and a skipped dependent is absent. Unreadable,
 * or not this run's: null, and every package reruns.
 */
export function readAggregateOutcomes(root, status) {
  const cacheRoot =
    process.env.VITE_CACHE_PATH || NodePath.join(root, "node_modules/.vite/task-cache");
  try {
    const [latest] = NodeFS.readdirSync(cacheRoot)
      .map((entry) => NodePath.join(cacheRoot, entry, "last-summary.json"))
      .filter((file) => NodeFS.existsSync(file))
      .toSorted((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs);
    const summary = JSON.parse(NodeFS.readFileSync(latest, "utf8"));
    if (summary.exit_code !== status || summary.tasks.some((task) => task.task_name !== "test"))
      return null;
    return new Map(
      summary.tasks.map((task) => {
        const outcome = task.result?.Spawned?.outcome;
        return [task.package_name, outcome?.Success ? 0 : (outcome?.Failed?.exit_code ?? -1)];
      }),
    );
  } catch {
    return null;
  }
}

/**
 * Packages other than the server run in one aggregate. One failure there cancels
 * running packages and skips dependents, so only those rerun on their own. The
 * server runs alone with parallel files; up to RERUN_LIMIT failed files rerun alone
 * as a diagnostic, and the gate still fails.
 */
function runTests({ root, home, out, log, workers }) {
  const packagesLog = log;
  const started = performance.now();
  const aggregate = runLogged(
    ["pnpm", "exec", "vp", "run", "--filter", `!${SERVER.name}`, "test"],
    { root, home, log: packagesLog },
  );
  const packagesFailed = [];
  const packagesRerun = [];
  if (aggregate.status !== 0 || aggregate.error) {
    const outcomes = readAggregateOutcomes(root, aggregate.status);
    const listed = runTool(["pnpm", "-r", "ls", "--depth", "-1", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const packages = JSON.parse(listed.stdout || "[]").filter(
      (entry) =>
        entry.name !== SERVER.name &&
        NodePath.resolve(entry.path) !== NodePath.resolve(root) &&
        JSON.parse(NodeFS.readFileSync(NodePath.join(entry.path, "package.json"), "utf8")).scripts
          ?.test,
    );
    if (packages.length === 0) packagesFailed.push("(the workspace listing failed)");
    for (const entry of packages) {
      const exit = outcomes?.get(entry.name);
      // A package that ran to its own failure is a complete result.
      if (exit === 0) continue;
      if (exit === 1) {
        packagesFailed.push(entry.name);
        continue;
      }
      packagesRerun.push(entry.name);
      NodeFS.appendFileSync(packagesLog, `\n### ${entry.name} on its own\n`);
      const result = runLogged(["pnpm", "exec", "vp", "run", "--filter", entry.name, "test"], {
        root,
        home,
        log: packagesLog,
      });
      if (result.status !== 0 || result.error) packagesFailed.push(entry.name);
    }
  }

  const packagesSeconds = Math.round((performance.now() - started) / 1000);
  const serverStarted = performance.now();
  const serverLog = log;
  NodeFS.appendFileSync(serverLog, `\n### ${SERVER.name}, ${workers} file(s) at a time\n`);
  const serverCwd = NodePath.join(root, SERVER.dir);
  const serverRun = (files, reportPath, parallel) =>
    runLogged(
      [
        "pnpm",
        "exec",
        "vp",
        "run",
        "--filter",
        SERVER.name,
        "test",
        ...(parallel
          ? ["--fileParallelism", `--maxWorkers=${workers}`]
          : ["--no-file-parallelism"]),
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${reportPath}`,
        ...files,
      ],
      { root, home, log: serverLog },
    );
  const report = NodePath.join(out, "test-server.json");
  const parallelRun = serverRun([], report, workers > 1);
  const server = { workers, report };
  if (parallelRun.status !== 0 || parallelRun.error) {
    const failed = failedFiles(report, serverCwd);
    if (!failed?.length) {
      server.reason = "the server suite failed without a failed file in its report";
    } else if (workers === 1 || failed.length > RERUN_LIMIT) {
      server.failed = failed;
    } else {
      NodeFS.appendFileSync(serverLog, `\n### Failed files again, one at a time\n`);
      const recheck = NodePath.join(out, "test-server-alone.json");
      const alone = serverRun(failed, recheck, false);
      const stillFailing = alone.status === 0 ? [] : failedFiles(recheck, serverCwd);
      if (stillFailing === null || (alone.status !== 0 && stillFailing.length === 0)) {
        server.reason = "the one-at-a-time rerun of the failed files did not finish";
        server.failed = failed;
      } else {
        server.failedAgainAlone = stillFailing;
        server.passedWhenRerunAlone = failed.filter((file) => !stillFailing.includes(file));
      }
    }
  }
  const serverPassed = parallelRun.status === 0 && !parallelRun.error;
  server.seconds = Math.round((performance.now() - serverStarted) / 1000);
  return {
    status: packagesFailed.length === 0 && serverPassed ? 0 : 1,
    details: { packagesSeconds, packagesFailed, packagesRerun, server },
  };
}

const describeTests = ({ packagesFailed, packagesRerun = [], server }) => {
  const parts = [
    `server ${server.seconds} s, ${server.workers} file${server.workers === 1 ? "" : "s"} at a time`,
  ];
  if (packagesFailed.length) parts.push(`failed packages: ${packagesFailed.join(", ")}`);
  if (packagesRerun.length)
    parts.push(`rerun after the aggregate stopped: ${packagesRerun.join(", ")}`);
  if (server.reason) parts.push(`server: ${server.reason}`);
  if (server.failed?.length) parts.push(`failed: ${server.failed.join(", ")}`);
  if (server.failedAgainAlone?.length)
    parts.push(`failed again alone: ${server.failedAgainAlone.join(", ")}`);
  if (server.passedWhenRerunAlone?.length)
    parts.push(`passed when rerun alone: ${server.passedWhenRerunAlone.join(", ")}`);
  return parts.join("; ");
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * One gates run per repository, across its worktrees: the lock lives in the
 * shared Git directory. A lock whose process has exited is taken over.
 */
export function acquireGatesLock(commonDir, { root, wait = sleep, log = console.log } = {}) {
  const lock = NodePath.join(commonDir, "scient-alignment-gates.lock");
  const owner = NodePath.join(lock, "owner.json");
  let announced = false;
  for (;;) {
    try {
      NodeFS.mkdirSync(lock);
      NodeFS.writeFileSync(
        owner,
        JSON.stringify({ pid: process.pid, root, started: new Date().toISOString() }),
      );
      const release = () => NodeFS.rmSync(lock, { recursive: true, force: true });
      return release;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let holder = null;
    try {
      holder = JSON.parse(NodeFS.readFileSync(owner, "utf8"));
    } catch {
      // Created a moment ago and not yet written, or left empty by a crash.
      const age = Date.now() - NodeFS.statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
      if (!(age > 60_000)) {
        wait(1000);
        continue;
      }
    }
    if (holder === null || !alive(holder.pid)) {
      NodeFS.rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (!announced) {
      log(
        `Waiting for the gates run in ${holder.root} (pid ${holder.pid}, since ${holder.started}). ` +
          `If that process is not a gates run, delete ${lock}.`,
      );
      announced = true;
    }
    wait(5000);
  }
}

function parseArgs(argv) {
  const args = { only: null, tests: false, serverWorkers: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--") continue;
    if (key === "--tests" && !args.tests) args.tests = true;
    else if (key === "--server-workers" && args.serverWorkers === null) {
      args.serverWorkers = Number(argv[++i]);
      if (!Number.isSafeInteger(args.serverWorkers) || args.serverWorkers < 1)
        throw new Error("--server-workers takes a positive integer");
    } else if (key === "--only" && args.only === null) {
      const value = argv[++i];
      args.only = value?.split(",").filter(Boolean) ?? [];
      const unknown = args.only.filter((id) => !GATES.some((gate) => gate.id === id));
      if (args.only.length === 0 || unknown.length > 0) {
        throw new Error(`--only takes gate IDs: ${GATES.map((gate) => gate.id).join(", ")}`);
      }
    } else throw new Error(`Unsupported or duplicate argument: ${key}`);
  }
  return args;
}

const capture = (argv, cwd) => {
  const result = runTool(argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

const countFiles = (directory) =>
  NodeFS.readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) =>
    entry.isFile(),
  ).length;

function formatTable(record) {
  const rows = record.gates.map(
    (gate) =>
      `| ${gate.id} | ${gate.status === "not-run" ? gate.reason : `${gate.status}, ${gate.seconds} s`}` +
      `${gate.tests ? `; ${describeTests(gate.tests)}` : ""} |`,
  );
  return [
    `Candidate \`${record.head}\` (tree \`${record.tree}\`${record.dirty ? ", plus uncommitted changes" : ""}), ` +
      `${record.platform}, Node ${record.node}, pnpm ${record.pnpm}, ${record.cores} CPUs` +
      `${record.load === null ? "" : ` (load average ${record.load} at start)`}` +
      `${record.partial ? `; partial run: ${record.partial.join(", ")}` : ""}.`,
    "",
    "| Gate | Result |",
    "| --- | --- |",
    ...rows,
  ].join("\n");
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone alignment CLI has no Effect runtime.
export function main(argv, { cwd = process.cwd(), platform = NodeOS.platform() } = {}) {
  const args = parseArgs(argv);
  const root = capture(["git", "rev-parse", "--show-toplevel"], cwd);
  const out = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-alignment-gates-"));
  const record = {
    head: capture(["git", "rev-parse", "HEAD"], root),
    tree: capture(["git", "rev-parse", "HEAD^{tree}"], root),
    dirty: capture(["git", "status", "--porcelain=v1"], root) !== "",
    platform: `${platform} ${NodeOS.release()}`,
    node: process.version,
    pnpm: capture(["pnpm", "--version"], root),
    cores: NodeOS.availableParallelism(),
    // Windows reports no load average.
    load: platform === "win32" ? null : Number(NodeOS.loadavg()[0].toFixed(1)),
    partial: args.only,
    gates: [],
  };
  const save = () =>
    NodeFS.writeFileSync(
      NodePath.join(out, "results.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  const selected = GATES.filter((gate) => !args.only || args.only.includes(gate.id));
  const release = selected.some((gate) => HEAVY_GATES.has(gate.id))
    ? acquireGatesLock(
        NodePath.resolve(root, capture(["git", "rev-parse", "--git-common-dir"], root)),
        { root },
      )
    : () => {};
  const onSignal = (signal) => {
    release();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    runGates(selected, { args, platform, root, out, record, save });
  } finally {
    release();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  console.log(`\nResults: ${NodePath.join(out, "results.json")}\n\n${formatTable(record)}`);
  const failed = record.gates.filter((gate) => gate.status === "failed").map((gate) => gate.id);
  const notRun = record.gates.filter((gate) => gate.status === "not-run").map((gate) => gate.id);
  if (failed.length) console.log(`\nFailed: ${failed.join(", ")}`);
  if (notRun.length) console.log(`Not run: ${notRun.join(", ")}`);
  return failed.length ? 1 : 0;
}

function runGates(selected, { args, platform, root, out, record, save }) {
  for (const gate of selected) {
    if (gate.windows && platform === "win32" && !args.tests) {
      record.gates.push({ id: gate.id, status: "not-run", reason: gate.windows });
      save();
      continue;
    }
    const log = NodePath.join(out, `${gate.id}.log`);
    const fd = NodeFS.openSync(log, "w");
    const home = makeCheckHome();
    const start = performance.now();
    let result;
    let homeFiles;
    try {
      result = gate.run
        ? gate.run({ root, home, out, log, workers: args.serverWorkers ?? serverWorkers() })
        : runTool(gate.argv, { cwd: root, home, stdio: ["ignore", fd, fd] });
      homeFiles = countFiles(home);
    } finally {
      NodeFS.closeSync(fd);
      NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    }
    const entry = {
      id: gate.id,
      status: result.status === 0 && !result.error ? "passed" : "failed",
      exit: result.status,
      seconds: Math.round((performance.now() - start) / 1000),
      command: gate.command ?? gate.argv.join(" "),
      log,
      ...(result.details ? { tests: result.details } : {}),
    };
    // A smoke run that wrote nothing under the synthetic home resolved its state elsewhere.
    if (gate.id === "smoke" && entry.status === "passed" && homeFiles === 0) {
      entry.status = "failed";
      entry.reason = "the desktop did not use the synthetic home";
    }
    record.gates.push(entry);
    save();
    console.log(`${entry.id}: ${entry.status}, ${entry.seconds} s (${log})`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
