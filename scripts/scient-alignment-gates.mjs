#!/usr/bin/env node
// Final local alignment gates: serial, never stopping at a failure, with one
// recorded result per gate. Qualification evidence, not a qualification policy.

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
  // pnpm reports every failing package in one run; `vp run -r` stops scheduling after the first.
  {
    id: "typecheck",
    argv: ["pnpm", "-r", "--no-bail", "--workspace-concurrency=2", "run", "typecheck"],
  },
  { id: "test", argv: ["pnpm", "run", "test"], windows: WINDOWS_TESTS },
  { id: "build", argv: ["pnpm", "run", "build"] },
  { id: "smoke", argv: ["pnpm", "run", "test:desktop-smoke"] },
  { id: "brand", argv: ["pnpm", "run", "brand:check"] },
  { id: "diff-index", argv: ["git", "diff", "--cached", "--check"] },
  { id: "diff-worktree", argv: ["git", "diff", "--check"] },
];

function parseArgs(argv) {
  const args = { only: null, tests: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--") continue;
    if (key === "--tests" && !args.tests) args.tests = true;
    else if (key === "--only" && args.only === null) {
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
      `| ${gate.id} | ${gate.status === "not-run" ? gate.reason : `${gate.status}, ${gate.seconds} s`} |`,
  );
  return [
    `Candidate \`${record.head}\` (tree \`${record.tree}\`${record.dirty ? ", plus uncommitted changes" : ""}), ` +
      `${record.platform}, Node ${record.node}, pnpm ${record.pnpm}` +
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
    partial: args.only,
    gates: [],
  };
  const save = () =>
    NodeFS.writeFileSync(
      NodePath.join(out, "results.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  for (const gate of GATES.filter((gate) => !args.only || args.only.includes(gate.id))) {
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
      result = runTool(gate.argv, { cwd: root, home, stdio: ["ignore", fd, fd] });
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
      command: gate.argv.join(" "),
      log,
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
  console.log(`\nResults: ${NodePath.join(out, "results.json")}\n\n${formatTable(record)}`);
  const failed = record.gates.filter((gate) => gate.status === "failed").map((gate) => gate.id);
  const notRun = record.gates.filter((gate) => gate.status === "not-run").map((gate) => gate.id);
  if (failed.length) console.log(`\nFailed: ${failed.join(", ")}`);
  if (notRun.length) console.log(`Not run: ${notRun.join(", ")}`);
  return failed.length ? 1 : 0;
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
