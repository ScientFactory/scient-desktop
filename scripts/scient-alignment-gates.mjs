#!/usr/bin/env node
// Final local alignment gates: serial, never stopping at a failure, with one
// recorded result per gate. Qualification evidence, not a qualification policy.
// SCIENT-FORK: the server suite runs its files in parallel, and one gates run per
// repository at a time (docs/internals/scripts.md#alignment-gates-and-receipt-facts).

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  compareFailures,
  makeCheckHome,
  readVitestReport,
  runTool,
} from "./scient-alignment-checks.mjs";

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
 * Cores already busy (the load average) are not counted as free.
 */
export const serverWorkers = (
  cores = NodeOS.availableParallelism(),
  memory = NodeOS.totalmem(),
  load = 0,
) =>
  Math.max(
    1,
    Math.min(
      6,
      Math.floor(cores / 2),
      Math.floor(memory / (4 * GiB)),
      Math.floor((cores - load) / 2),
    ),
  );

/**
 * Test failures this machine also has on main, recorded with `--record-baseline` from a clean
 * main checkout. Kept in the shared Git directory, one file per platform, architecture and Node
 * major, so every worktree of the repository compares against the same record.
 */
export const baselinePath = (
  commonDir,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone alignment CLI has no Effect runtime.
  { platform = NodeOS.platform(), arch = NodeOS.arch(), node = process.versions.node } = {},
) =>
  NodePath.join(
    commonDir,
    "scient-test-baseline",
    `${platform}-${arch}-node${node.split(".")[0]}.json`,
  );

/** A baseline older than this, or from a commit outside the candidate's history, is not used. */
const BASELINE_MAX_AGE_DAYS = 7;

const gitRef = (args, cwd) => {
  const result = runTool(["git", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
};

/** The baseline, or `{ unusable }` saying why it cannot judge `head`; null when there is none. */
export function usableBaseline(path, head, root, now = Date.now()) {
  const baseline = readGatesBaseline(path);
  if (!baseline) return null;
  const ageDays = (now - Date.parse(baseline.recordedAt)) / 86_400_000;
  if (!(ageDays <= BASELINE_MAX_AGE_DAYS))
    return { unusable: `recorded more than ${BASELINE_MAX_AGE_DAYS} days ago, record it again` };
  const ancestor = runTool(["git", "merge-base", "--is-ancestor", baseline.head, head], {
    cwd: root,
    stdio: "ignore",
  });
  if (ancestor.status !== 0)
    return {
      unusable: `its main commit ${String(baseline.head).slice(0, 10)} is not in this candidate's history`,
    };
  return baseline;
}

export function readGatesBaseline(path) {
  try {
    const baseline = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    return Array.isArray(baseline?.failures) ? { ...baseline, path } : null;
  } catch {
    return null;
  }
}

/**
 * The machine at the start of a run: load average and, on macOS, the file events daemon,
 * whose saturation makes every test that waits for a file change fail or time out.
 */
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone alignment CLI has no Effect runtime.
export function machineLoad(platform = NodeOS.platform(), cores = NodeOS.availableParallelism()) {
  // Windows reports no load average.
  const load = platform === "win32" ? null : Number(NodeOS.loadavg()[0].toFixed(1));
  let fseventsd = null;
  if (platform === "darwin") {
    const ps = runTool(["ps", "-axco", "%cpu=,comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = (ps.stdout ?? "").split("\n").find((row) => row.trim().endsWith(" fseventsd"));
    fseventsd = line === undefined ? null : Number.parseFloat(line.trim());
  }
  const busy = [
    ...(load !== null && load > 0.75 * cores ? [`load average ${load} on ${cores} CPUs`] : []),
    ...(fseventsd !== null && fseventsd >= 80
      ? [`fseventsd at ${fseventsd}% CPU, so file change events arrive late or never`]
      : []),
  ];
  return { load, fseventsd, busy };
}

/** Failed tests whose failure is a Vitest timeout, from a JSON report. */
const timedOut = (reportPath, cwd) => {
  try {
    const report = JSON.parse(NodeFS.readFileSync(reportPath, "utf8"));
    return report.testResults.flatMap((file) =>
      (file.assertionResults ?? [])
        .filter(
          (test) =>
            test.status === "failed" &&
            (test.failureMessages ?? []).some((message) => /timed out in \d+ms/u.test(message)),
        )
        .map(
          (test) => `${NodePath.relative(cwd, file.name).replaceAll("\\", "/")} > ${test.fullName}`,
        ),
    );
  } catch {
    return [];
  }
};

const fileOf = (id) => id.slice(0, id.indexOf(" > "));
const FILE_ERROR = " > (file error)";
const RUN_OUTCOME_REPORTER = NodeURL.fileURLToPath(
  new URL("./vitest-run-outcome-reporter.mjs", import.meta.url),
);

const runLogged = (argv, { root, home, log, env }) => {
  const fd = NodeFS.openSync(log, "a");
  try {
    return runTool(argv, { cwd: root, home, env, stdio: ["ignore", fd, fd] });
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
 * vp's summary of the aggregate, from the empty cache directory that run alone used:
 * package name -> exit code, 0 for a pass. Cancelled packages are killed (137, or
 * 143) and skipped dependents are absent. Unreadable: null.
 */
export function readAggregateOutcomes(cacheRoot) {
  try {
    const [summary, ...others] = NodeFS.readdirSync(cacheRoot)
      .map((entry) => NodePath.join(cacheRoot, entry, "last-summary.json"))
      .filter((file) => NodeFS.existsSync(file));
    if (!summary || others.length) return null;
    const { tasks } = JSON.parse(NodeFS.readFileSync(summary, "utf8"));
    return new Map(
      tasks.map((task) => {
        const outcome = task.result?.Spawned?.outcome;
        return [task.package_name, outcome?.Success ? 0 : (outcome?.Failed?.exit_code ?? -1)];
      }),
    );
  } catch {
    return null;
  }
}
const CANCELLED = new Set([137, 143]);

/**
 * Packages other than the server run in one aggregate. One failure there cancels
 * running packages and skips dependents, so only those rerun on their own. The
 * server runs alone with parallel files; up to RERUN_LIMIT failed files rerun alone
 * as a diagnostic, and the gate still fails.
 */
function runTests({ root, home, out, log, workers, baseline, recording }) {
  const packagesLog = log;
  const started = performance.now();
  const cacheRoot = NodePath.join(out, "aggregate-task-cache");
  const aggregate = runLogged(
    ["pnpm", "exec", "vp", "run", "--filter", `!${SERVER.name}`, "test"],
    { root, home, log: packagesLog, env: { VITE_CACHE_PATH: cacheRoot } },
  );
  const packagesFailed = [];
  const packagesRerun = [];
  if (aggregate.status !== 0 || aggregate.error) {
    const outcomes = readAggregateOutcomes(cacheRoot);
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
      if (exit === 0) continue;
      // A package that ran to its own failure is a complete result.
      if (exit !== undefined && !CANCELLED.has(exit)) {
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
    if (packagesFailed.length === 0)
      packagesFailed.push("(the aggregate failed, yet no package failed on its own)");
  }

  const packagesSeconds = Math.round((performance.now() - started) / 1000);
  const serverStarted = performance.now();
  const serverLog = log;
  NodeFS.appendFileSync(serverLog, `\n### ${SERVER.name}, ${workers} file(s) at a time\n`);
  const serverCwd = NodePath.join(root, SERVER.dir);
  const serverRun = (files, reportPath, parallel, outcomePath) =>
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
        ...(outcomePath ? [`--reporter=${RUN_OUTCOME_REPORTER}`] : []),
        ...files,
      ],
      {
        root,
        home,
        log: serverLog,
        ...(outcomePath ? { env: { SCIENT_VITEST_RUN_OUTCOME: outcomePath } } : {}),
      },
    );
  const report = NodePath.join(out, "test-server.json");
  const outcome = NodePath.join(out, "test-server-outcome.json");
  const parallelRun = serverRun([], report, workers > 1, outcome);
  const server = { workers, report };
  const serverPassed = parallelRun.status === 0 && !parallelRun.error;
  // Test IDs, `<file> > <full test name>`, relative to the server package.
  const failures = readVitestReport(report, serverCwd)?.failures ?? null;
  // Errors outside any test, an interrupted run and unfinished files: never known on main.
  server.runErrors = runErrors(parallelRun, outcome, serverCwd);
  if (failures === null) server.reason = "no readable report from the server suite";
  else if (!serverPassed) server.timedOut = timedOut(report, serverCwd);
  // A file that failed to load is never waived either.
  const labels =
    baseline && failures !== null
      ? compareFailures(
          failures,
          baseline.failures.filter((id) => !id.endsWith(FILE_ERROR)),
        )
      : null;
  const blocking = labels ? labels.new : (failures ?? []);
  const blockingFiles = [...new Set(blocking.map(fileOf))].toSorted();
  // Evidence only: a file that passes alone still failed in the suite, from load or from a
  // race with other files, so it blocks either way.
  if (!recording && blockingFiles.length > 0) {
    if (workers === 1 || blockingFiles.length > RERUN_LIMIT) {
      server.failed = blockingFiles;
    } else {
      NodeFS.appendFileSync(serverLog, `\n### Failed files again, one at a time\n`);
      const recheck = NodePath.join(out, "test-server-alone.json");
      const alone = serverRun(blockingFiles, recheck, false);
      const stillFailing = alone.status === 0 ? [] : failedFiles(recheck, serverCwd);
      if (stillFailing === null || (alone.status !== 0 && stillFailing.length === 0)) {
        server.failed = blockingFiles;
        server.rerunUnfinished = true;
      } else {
        server.failedAgainAlone = stillFailing;
        server.passedWhenRerunAlone = blockingFiles.filter((file) => !stillFailing.includes(file));
      }
    }
  }
  server.seconds = Math.round((performance.now() - serverStarted) / 1000);
  const details = { packagesSeconds, packagesFailed, packagesRerun, server };
  if (failures !== null) details.failures = failures;
  const complete = failures !== null && server.runErrors.length === 0;
  if (recording) {
    if (complete) details.recorded = { failures };
    return { status: complete && packagesFailed.length === 0 ? 0 : 1, details };
  }
  if (labels) {
    details.baseline = {
      path: baseline.path,
      head: baseline.head,
      recordedAt: baseline.recordedAt,
      new: labels.new,
      knownOnMain: labels.preexisting,
      notFailingHere: labels.noLongerFailing,
    };
  }
  const serverClean = labels ? labels.new.length === 0 : serverPassed;
  return {
    status: complete && serverClean && packagesFailed.length === 0 ? 0 : 1,
    details,
  };
}

/** Why the server run cannot be judged by its failed tests alone; empty when it can. */
function runErrors(run, outcomePath, cwd) {
  if (run.error || run.signal) return [`the run ended abnormally (${run.signal ?? run.error})`];
  let outcome;
  try {
    outcome = JSON.parse(NodeFS.readFileSync(outcomePath, "utf8"));
  } catch {
    return ["Vitest wrote no run outcome"];
  }
  const relative = (file) => NodePath.relative(cwd, file).replaceAll("\\", "/");
  return [
    ...(outcome.reason === "interrupted" ? ["the run was interrupted"] : []),
    ...(outcome.unfinished ?? []).map((file) => `unfinished: ${relative(file)}`),
    ...(outcome.unhandledErrors ?? []).map((message) => `error outside any test: ${message}`),
  ];
}

const describeTests = ({ packagesFailed, packagesRerun = [], server, baseline, recorded }) => {
  const parts = [
    `server ${server.seconds} s, ${server.workers} file${server.workers === 1 ? "" : "s"} at a time`,
  ];
  if (packagesFailed.length) parts.push(`failed packages: ${packagesFailed.join(", ")}`);
  if (packagesRerun.length)
    parts.push(`rerun after the aggregate stopped: ${packagesRerun.join(", ")}`);
  if (server.reason) parts.push(`server: ${server.reason}`);
  if (server.runErrors?.length) parts.push(`server run: ${server.runErrors.join(", ")}`);
  if (baseline) {
    const since = `main \`${baseline.head?.slice(0, 10)}\``;
    parts.push(
      baseline.new.length ? `new failures: ${baseline.new.join(", ")}` : "no new failures",
    );
    if (baseline.knownOnMain.length)
      parts.push(`also failing on ${since}: ${baseline.knownOnMain.join(", ")}`);
    if (baseline.notFailingHere.length)
      parts.push(
        `failing on ${since}, absent from this run's failures: ${baseline.notFailingHere.join(", ")}`,
      );
  }
  if (server.failed?.length) parts.push(`failed files: ${server.failed.join(", ")}`);
  if (server.failedAgainAlone?.length)
    parts.push(`failed again alone: ${server.failedAgainAlone.join(", ")}`);
  if (server.passedWhenRerunAlone?.length)
    parts.push(
      `passed when rerun alone (load, or a race with other files): ${server.passedWhenRerunAlone.join(", ")}`,
    );
  if (server.timedOut?.length) parts.push(`timed out: ${server.timedOut.join(", ")}`);
  if (recorded)
    parts.push(`baseline recorded: ${recorded.failures.length} failure(s) on this machine`);
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

const gatesLock = (commonDir) => NodePath.join(commonDir, "scient-alignment-gates.lock");
const slots = (lock) =>
  NodeFS.readdirSync(lock)
    .filter((name) => /^\d+$/u.test(name))
    .map(Number);
const ownerOf = (lock, slot) => {
  try {
    return JSON.parse(NodeFS.readFileSync(NodePath.join(lock, String(slot), "owner.json"), "utf8"));
  } catch {
    return null;
  }
};
const discard = (lock, slot) => {
  const gone = NodePath.join(lock, `.gone-${NodeCrypto.randomUUID()}`);
  try {
    NodeFS.renameSync(NodePath.join(lock, String(slot)), gone);
  } catch {
    return;
  }
  NodeFS.rmSync(gone, { recursive: true, force: true });
};

/**
 * Claims slot `seen + 1` for `owner`, the slot after the highest one the caller saw.
 * Returns it if it is now the highest slot, otherwise removes it and returns null.
 */
export function claimGatesSlot(commonDir, seen, owner) {
  const lock = gatesLock(commonDir);
  const slot = seen + 1;
  const staging = NodePath.join(lock, `.claim-${owner.token}`);
  NodeFS.mkdirSync(staging);
  NodeFS.writeFileSync(NodePath.join(staging, "owner.json"), JSON.stringify(owner));
  try {
    // A slot always holds its owner, so renaming onto a taken one fails.
    NodeFS.renameSync(staging, NodePath.join(lock, String(slot)));
  } catch (error) {
    NodeFS.rmSync(staging, { recursive: true, force: true });
    // Taken: that slot, or a later one once its holder cleared it. The highest slot stays.
    if (slots(lock).some((taken) => taken >= slot)) return null;
    throw error;
  }
  if (Math.max(...slots(lock)) === slot) return slot;
  discard(lock, slot);
  return null;
}

/**
 * One gates run per repository, across its worktrees: the lock lives in the shared Git
 * directory as numbered slots, and the highest slot is the lock. That slot is never
 * removed, only marked released, and it is free once released or its process has exited.
 * No timeout decides, and no run removes a slot another run may still hold.
 */
export function acquireGatesLock(commonDir, { root, wait = sleep, log = console.log } = {}) {
  const lock = gatesLock(commonDir);
  NodeFS.mkdirSync(lock, { recursive: true });
  const token = NodeCrypto.randomUUID();
  let announced = false;
  for (;;) {
    const top = Math.max(0, ...slots(lock));
    const holder = top === 0 ? null : ownerOf(lock, top);
    const free =
      holder === null ||
      NodeFS.existsSync(NodePath.join(lock, String(top), "released")) ||
      !alive(holder.pid);
    if (free) {
      const owner = { pid: process.pid, root, token, started: new Date().toISOString() };
      const slot = claimGatesSlot(commonDir, top, owner);
      if (slot === null) continue;
      for (const older of slots(lock)) if (older < slot) discard(lock, older);
      return () => {
        // Only this run's slot: the lock folder may have been deleted by hand meanwhile.
        if (ownerOf(lock, slot)?.token !== token) return;
        NodeFS.writeFileSync(NodePath.join(lock, String(slot), "released"), "");
      };
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
  const args = { only: null, tests: false, serverWorkers: null, recordBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--") continue;
    if (key === "--tests" && !args.tests) args.tests = true;
    else if (key === "--record-baseline" && !args.recordBaseline) args.recordBaseline = true;
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
      `${record.fseventsd === null || record.fseventsd === undefined ? "" : `, fseventsd ${record.fseventsd}% CPU`}` +
      `${record.partial ? `; partial run: ${record.partial.join(", ")}` : ""}.`,
    ...(record.busy?.length
      ? [
          "",
          `Busy machine at start: ${record.busy.join("; ")}. Timeouts and file-watch failures ` +
            "below may come from that, not from the candidate.",
        ]
      : []),
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
  const commonDir = NodePath.resolve(root, capture(["git", "rev-parse", "--git-common-dir"], root));
  const cores = NodeOS.availableParallelism();
  const out = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-alignment-gates-"));
  const record = {
    head: capture(["git", "rev-parse", "HEAD"], root),
    tree: capture(["git", "rev-parse", "HEAD^{tree}"], root),
    dirty: capture(["git", "status", "--porcelain=v1"], root) !== "",
    platform: `${platform} ${NodeOS.release()}`,
    node: process.version,
    pnpm: capture(["pnpm", "--version"], root),
    cores,
    load: null,
    fseventsd: null,
    busy: [],
    partial: args.only,
    gates: [],
  };
  const save = () =>
    NodeFS.writeFileSync(
      NodePath.join(out, "results.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  const selected = GATES.filter((gate) => !args.only || args.only.includes(gate.id));
  const baselineFile = baselinePath(commonDir, { platform });
  if (args.recordBaseline) {
    const testGate = selected.find((gate) => gate.id === "test");
    if (!testGate) throw new Error("--record-baseline needs the test gate");
    if (testGate.windows && platform === "win32" && !args.tests)
      throw new Error("--record-baseline needs --tests on Windows, where the test gate is skipped");
    const originMain = gitRef(
      ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"],
      root,
    );
    if (record.dirty || originMain !== record.head)
      throw new Error(
        "--record-baseline needs a clean checkout of origin/main (fetch it, then check out that commit)",
      );
  }
  const baseline = args.recordBaseline ? null : usableBaseline(baselineFile, record.head, root);
  if (baseline?.unusable) {
    console.log(`\nTest baseline ${baselineFile} not used: ${baseline.unusable}.`);
  }
  const release = selected.some((gate) => HEAVY_GATES.has(gate.id))
    ? acquireGatesLock(commonDir, { root })
    : () => {};
  // Sampled once this run holds the lock, so a wait for another run does not make it stale.
  const machine = machineLoad(platform, cores);
  Object.assign(record, { load: machine.load, fseventsd: machine.fseventsd, busy: machine.busy });
  const workers = args.serverWorkers ?? serverWorkers(cores, NodeOS.totalmem(), machine.load ?? 0);
  const onSignal = (signal) => {
    release();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    runGates(selected, {
      args,
      platform,
      root,
      out,
      record,
      save,
      baseline: baseline?.unusable ? null : baseline,
      workers,
    });
  } finally {
    release();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  const recorded = record.gates.find((gate) => gate.id === "test")?.tests?.recorded;
  if (args.recordBaseline && recorded) {
    NodeFS.mkdirSync(NodePath.dirname(baselineFile), { recursive: true });
    NodeFS.writeFileSync(
      baselineFile,
      `${JSON.stringify(
        {
          head: record.head,
          tree: record.tree,
          recordedAt: new Date().toISOString(),
          platform: record.platform,
          node: record.node,
          failures: recorded.failures,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\nBaseline: ${baselineFile}`);
  } else if (
    !args.recordBaseline &&
    (!baseline || baseline.unusable) &&
    selected.some((gate) => gate.id === "test")
  ) {
    console.log(
      `\nNo test baseline for this machine (${baselineFile}): every failure counts. ` +
        "Record one from a clean checkout of origin/main with `pnpm alignment:gates --only test --record-baseline`.",
    );
  }
  console.log(`\nResults: ${NodePath.join(out, "results.json")}\n\n${formatTable(record)}`);
  const failed = record.gates.filter((gate) => gate.status === "failed").map((gate) => gate.id);
  const notRun = record.gates.filter((gate) => gate.status === "not-run").map((gate) => gate.id);
  if (failed.length) console.log(`\nFailed: ${failed.join(", ")}`);
  if (notRun.length) console.log(`Not run: ${notRun.join(", ")}`);
  return failed.length ? 1 : 0;
}

function runGates(selected, { args, platform, root, out, record, save, baseline, workers }) {
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
        ? gate.run({
            root,
            home,
            out,
            log,
            workers,
            baseline,
            recording: args.recordBaseline,
          })
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
