import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const mapping = JSON.parse(
  NodeFS.readFileSync(new URL("./scient-alignment-checks.json", import.meta.url)),
);
const matches = (path, prefix) => path.startsWith(prefix);
const WEB_UNIT_LANE_COST =
  "Opt-in: every web unit suite, about 14 minutes on a Windows 11 workstation. Compare with " +
  "--web-unit-baseline from the same run on the unmodified base; a flaky test can still appear new.";

/**
 * Child environment for local checks. A Scient desktop host gives its agents
 * variables that point at the live profile or make Electron run as Node; drop
 * them and, given a synthetic home, root every default state path there.
 */
export function checkEnvironment(env, home) {
  const hostOwned = (name) => {
    const upper = name.toUpperCase();
    return (
      ["ELECTRON_RUN_AS_NODE", "T3CODE_HOME", "T3CODE_CLI_PATH"].includes(upper) ||
      upper.startsWith("SCIENT_NEXT_") ||
      upper.startsWith("SCIENT_ANALYTICS_")
    );
  };
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !hostOwned(name)));
  return home === undefined ? kept : { ...kept, SCIENT_NEXT_HOME: home, T3CODE_HOME: home };
}

/** A fresh state root, so a check cannot fall back to a live profile. */
export const makeCheckHome = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-check-home-"));

/** Run a repository tool with the check environment. Windows reaches `pnpm.cmd` through its shell. */
export function runTool(argv, { home, ...options } = {}) {
  const spawnOptions = {
    stdio: "inherit",
    ...options,
    env: checkEnvironment(process.env, home),
  };
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone alignment CLI has no Effect runtime.
  if (NodeOS.platform() !== "win32") {
    return NodeChildProcess.spawnSync(argv[0], argv.slice(1), spawnOptions);
  }
  // A quoted command name breaks `%~dp0` in npm-style .cmd shims, so only arguments
  // are quoted. Inside double quotes cmd.exe still expands `%` and cannot escape `"`.
  const [name, ...rest] = argv;
  if (!/^[\w.-]+$/u.test(name) || rest.some((arg) => /["%]/u.test(arg))) {
    throw new Error(`Unsupported shell command: ${argv.join(" ")}`);
  }
  const command = [name, ...rest.map((arg) => `"${arg}"`)].join(" ");
  return NodeChildProcess.spawnSync(command, { ...spawnOptions, shell: true });
}

/** Select consumers conservatively, including paths the maintained map does not know. */
export function selectBoundaries(paths) {
  const selected = new Set();
  const excluded = [];
  const unknown = [];
  for (const path of paths) {
    if (mapping.excludedPrefixes.some((prefix) => matches(path, prefix))) {
      excluded.push(path);
      continue;
    }
    const rows = mapping.globalTriggers.some((prefix) => matches(path, prefix))
      ? mapping.boundaries
      : mapping.boundaries.filter((row) => row.triggers.some((prefix) => matches(path, prefix)));
    if (rows.length === 0) unknown.push(path);
    for (const row of rows.length === 0 ? mapping.boundaries : rows) selected.add(row.id);
  }
  return {
    boundaries: mapping.boundaries.filter((row) => selected.has(row.id)),
    excluded,
    unknown,
  };
}

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    paths: [],
    boundaries: [],
    run: false,
    native: false,
    all: false,
    webUnit: false,
    webUnitBaseline: null,
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--") continue;
    if (["--all", "--run", "--native", "--web-unit"].includes(key)) {
      if (seen.has(key)) throw new Error(`Duplicate argument: ${key}`);
      args[key === "--web-unit" ? "webUnit" : key.slice(2)] = true;
    } else if (["--cwd", "--base", "--path", "--boundary", "--web-unit-baseline"].includes(key)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value: ${key}`);
      if (["--cwd", "--base", "--web-unit-baseline"].includes(key) && seen.has(key)) {
        throw new Error(`Duplicate argument: ${key}`);
      }
      if (key === "--path") args.paths.push(value);
      else if (key === "--boundary") args.boundaries.push(value);
      else if (key === "--web-unit-baseline") args.webUnitBaseline = NodePath.resolve(value);
      else args[key.slice(2)] = value;
    } else throw new Error(`Unsupported argument: ${key}`);
    seen.add(key);
  }
  const modes =
    Number(args.all) +
    Number(Boolean(args.base)) +
    Number(args.paths.length > 0) +
    Number(args.boundaries.length > 0);
  // The full web unit lane may run alone or beside one boundary selection.
  if (modes > 1 || (modes === 0 && !args.webUnit))
    throw new Error(
      "Choose exactly one of --all, --base REF, --path PATH (repeatable), or --boundary ID (repeatable); --web-unit may run alone",
    );
  if (args.webUnitBaseline && !args.webUnit) {
    throw new Error("--web-unit-baseline compares a --web-unit run");
  }
  for (const path of args.paths) {
    if (
      NodePath.posix.normalize(path) !== path ||
      path.startsWith("/") ||
      path.startsWith("../") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path === "." ||
      path === ".."
    ) {
      throw new Error(`Expected repository-relative path: ${path}`);
    }
  }
  for (const id of args.boundaries) {
    if (!mapping.boundaries.some((row) => row.id === id))
      throw new Error(`Unknown boundary: ${id}`);
  }
  return args;
}

const git = (cwd, args) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

/** Run the target checkout's existing suites serially; this never copies lane source into it. */
export function main(argv) {
  const args = parseArgs(argv);
  const cwd = NodeFS.realpathSync(git(args.cwd, ["rev-parse", "--show-toplevel"]).trim());
  const head = git(cwd, ["rev-parse", "HEAD"]).trim();
  const base = args.base
    ? git(cwd, ["rev-parse", "--verify", "--end-of-options", `${args.base}^{commit}`]).trim()
    : null;
  const paths = base
    ? [
        ...new Set(
          [
            ...git(cwd, ["diff", "--no-renames", "--name-only", "-z", base, head, "--"]).split(
              "\0",
            ),
            ...git(cwd, [
              "diff",
              "--cached",
              "--no-renames",
              "--name-only",
              "-z",
              head,
              "--",
            ]).split("\0"),
            ...git(cwd, ["diff", "--no-renames", "--name-only", "-z", "--"]).split("\0"),
            ...git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
          ].filter(Boolean),
        ),
      ]
    : args.paths;
  const selection =
    args.all || args.boundaries.length
      ? {
          boundaries: mapping.boundaries.filter(
            (row) => args.all || args.boundaries.includes(row.id),
          ),
          excluded: [],
          unknown: [],
        }
      : selectBoundaries(paths);
  const commands = Object.entries(mapping.groups).flatMap(([id, group]) => {
    const files = [...new Set(selection.boundaries.flatMap((row) => row.checks[id] ?? []))];
    if (!files.length) return [];
    return [
      {
        id,
        cwd: NodePath.join(cwd, group.cwd),
        argv: ["pnpm", ...group.args, ...files],
        files,
        requiredEnv: group.requiredEnv ?? null,
        included: id !== "native" || args.native,
      },
    ];
  });
  const webUnitLane = args.webUnit
    ? {
        cwd: NodePath.join(cwd, mapping.groups["web-unit"].cwd),
        argv: ["pnpm", ...mapping.groups["web-unit"].args],
        baseline: args.webUnitBaseline,
        cost: WEB_UNIT_LANE_COST,
      }
    : null;
  const plan = {
    scope: mapping.scope,
    cwd,
    head,
    base,
    paths,
    excluded: selection.excluded,
    unknown: selection.unknown,
    boundaries: selection.boundaries.map((row) => row.id),
    commands,
    webUnitLane,
    limits: selection.boundaries.flatMap((row) => row.limits),
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!args.run) return 0;
  if (git(cwd, ["ls-files", "--unmerged", "-z"]))
    throw new Error(
      "Unresolved index: selection is available, but resolve the candidate before executing checks",
    );
  // Preflight every included file before starting any command. A renamed/missing
  // suite is unavailable evidence, never a substring-filtered empty success.
  for (const command of commands.filter((command) => command.included)) {
    for (const file of command.files) {
      const entry = NodeFS.statSync(NodePath.join(command.cwd, file), { throwIfNoEntry: false });
      // A trailing `/` names every suite in a directory the boundary owns.
      if (!(file.endsWith("/") ? entry?.isDirectory() : entry?.isFile())) {
        throw new Error(`Unavailable check in target checkout: ${file}`);
      }
    }
    if (command.requiredEnv && !checkEnvironment(process.env)[command.requiredEnv]) {
      throw new Error(`Native checks require ${command.requiredEnv}; no native pass claimed`);
    }
  }
  const baseline = webUnitLane?.baseline ? readBaseline(webUnitLane.baseline) : null;
  if (!webUnitLane && !commands.some((command) => command.included)) {
    console.log("No mapped checks selected; no behavioral qualification claimed.");
  }
  // Run every group so one pass reports all failing boundaries.
  const failed = [];
  for (const command of commands.filter((command) => command.included)) {
    const result = runCheck(command.id, command.argv, command.cwd);
    if (result.status !== 0) failed.push(command.id);
  }
  if (webUnitLane) {
    const out = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-web-unit-lane-"));
    const report = NodePath.join(out, "vitest.json");
    const result = runCheck(
      "web-unit-lane",
      [...webUnitLane.argv, "--reporter=default", "--reporter=json", `--outputFile.json=${report}`],
      webUnitLane.cwd,
    );
    const failures = readVitestFailures(report, webUnitLane.cwd, result.status);
    const failuresPath = NodePath.join(out, "web-unit-failures.json");
    NodeFS.writeFileSync(failuresPath, `${JSON.stringify({ head, cwd, failures }, null, 2)}\n`);
    const comparison = baseline ? compareFailures(failures, baseline.failures) : null;
    console.log(
      JSON.stringify(
        { check: "web-unit-lane", failures: failuresPath, baseline: baseline?.path, ...comparison },
        null,
        2,
      ),
    );
    if (comparison ? comparison.new.length > 0 : failures.length > 0) failed.push("web-unit-lane");
  }
  if (failed.length) console.log(`Failed checks: ${failed.join(", ")}`);
  return failed.length ? 1 : 0;
}

/** Run one check command with a fresh synthetic home and report its exit and duration. */
function runCheck(id, argv, cwd) {
  const start = performance.now();
  const home = makeCheckHome();
  let result;
  try {
    result = runTool(argv, { cwd, home });
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(
    JSON.stringify({
      check: id,
      exit: result.status,
      signal: result.signal,
      elapsedSeconds: (performance.now() - start) / 1000,
    }),
  );
  if (result.error) throw result.error;
  return result;
}

function readBaseline(path) {
  let failures;
  try {
    ({ failures } = JSON.parse(NodeFS.readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`Unreadable --web-unit-baseline ${path}: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(failures) || failures.some((id) => typeof id !== "string")) {
    throw new Error(`--web-unit-baseline ${path} has no failures list from a --web-unit run`);
  }
  return { path, failures };
}

/**
 * Failed tests in a Vitest JSON report as `file > full test name`, with a file
 * that failed outside its tests (an import error) by its path alone. A failing
 * exit without a readable report or a failed test is itself a failure.
 */
export function readVitestFailures(reportPath, cwd, exit) {
  let report;
  try {
    report = JSON.parse(NodeFS.readFileSync(reportPath, "utf8"));
  } catch {
    return [`(no Vitest report; exit ${exit})`];
  }
  const failures = report.testResults.flatMap((file) => {
    const path = NodePath.relative(cwd, file.name).split(NodePath.sep).join("/");
    const tests = file.assertionResults
      .filter((test) => test.status === "failed")
      .map((test) => `${path} > ${test.fullName}`);
    return tests.length === 0 && file.status === "failed" ? [path] : tests;
  });
  if (failures.length === 0 && exit !== 0) return [`(exit ${exit} without a failed test)`];
  return [...new Set(failures)].sort();
}

/** New failures fail the lane; pre-existing ones and baseline failures that now pass are reported. */
export function compareFailures(failures, baseline) {
  const before = new Set(baseline);
  const after = new Set(failures);
  return {
    new: failures.filter((id) => !before.has(id)),
    preexisting: failures.filter((id) => before.has(id)),
    nowPassing: baseline.filter((id) => !after.has(id)),
  };
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
