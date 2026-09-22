#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const git = (cwd, args, options = {}) => {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !(options.allowConflict && result.status === 1)) {
    throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result;
};
const output = (cwd, args, options) => git(cwd, args, options).stdout.trim();
const isAncestor = (cwd, older, newer) =>
  git(cwd, ["merge-base", "--is-ancestor", older, newer], { allowConflict: true }).status === 0;
const nulPaths = (value) => value.split("\0").filter(Boolean);

function argumentsFor(argv) {
  const [command, ...rest] = argv;
  if (!["plan", "start"].includes(command)) throw new Error("Use plan or start");
  const args = {};
  const allowed = new Set(["--base", "--target", "--format", "--worktree", "--branch"]);
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--historical") {
      if (command !== "plan" || Object.hasOwn(args, flag)) {
        throw new Error("--historical is a plan-only flag and may be supplied once");
      }
      args[flag] = true;
      continue;
    }
    const value = rest[++i];
    if (!allowed.has(flag) || !value || value.startsWith("--") || Object.hasOwn(args, flag)) {
      throw new Error(`Invalid or duplicate argument: ${flag}`);
    }
    args[flag] = value;
  }
  if (!args["--base"] || !args["--target"]) throw new Error("--base and --target are required");
  if (args["--format"] && !["text", "json"].includes(args["--format"])) {
    throw new Error("--format must be text or json");
  }
  if (command === "plan" && (args["--worktree"] || args["--branch"])) {
    throw new Error("--worktree and --branch apply only to start");
  }
  if (command === "start" && (!args["--worktree"] || !args["--branch"])) {
    throw new Error("start requires --worktree and --branch");
  }
  if (
    command === "start" &&
    (!/^[0-9a-f]{40}$/u.test(args["--base"]) || !/^[0-9a-f]{40}$/u.test(args["--target"]))
  ) {
    throw new Error("start requires the frozen full base and target commit IDs from plan");
  }
  return { command, args };
}

function simulatedConflicts(root, base, target) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-alignment-plan-"));
  try {
    const objects = output(root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
    const privateObjects = NodePath.join(directory, "objects");
    NodeFS.mkdirSync(privateObjects);
    const env = {
      ...process.env,
      GIT_OBJECT_DIRECTORY: privateObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        JSON.stringify(objects),
        process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
      ]
        .filter(Boolean)
        .join(NodePath.delimiter),
    };
    const result = git(
      root,
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", base, target],
      { env, allowConflict: true },
    );
    const [tree, ...names] = result.stdout.split("\0");
    if (!/^[0-9a-f]{40,64}$/u.test(tree)) throw new Error("Invalid merge simulation output");
    const paths = names.filter(Boolean);
    if ((result.status === 1 && paths.length === 0) || (result.status === 0 && paths.length > 0)) {
      throw new Error("Inconsistent merge simulation result");
    }
    return { clean: result.status === 0, paths };
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

export function inspectAlignment(argv, { cwd = process.cwd() } = {}) {
  const { command, args } = argumentsFor(argv);
  const root = output(cwd, ["rev-parse", "--show-toplevel"]);
  const sourceCheckoutDirty = Boolean(git(root, ["status", "--porcelain=v1", "-z"]).stdout);
  const base = output(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${args["--base"]}^{commit}`,
  ]);
  const target = output(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${args["--target"]}^{commit}`,
  ]);
  const state = JSON.parse(output(root, ["show", `${base}:upstream-state.json`]));
  if (state.updateMode !== "thin-fork-merge" || !state.integrationBase) {
    throw new Error("Owned base lacks a valid upstream integration boundary");
  }
  const previous = output(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${state.integrationBase}^{commit}`,
  ]);
  const ownedMain = output(root, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
  const officialMain = output(root, [
    "rev-parse",
    "--verify",
    "refs/remotes/upstream/main^{commit}",
  ]);
  if (output(root, ["remote", "get-url", "--push", "upstream"]) !== "DISABLED") {
    throw new Error("Upstream push URL must be DISABLED");
  }
  if (args["--historical"]) {
    if (!isAncestor(root, base, ownedMain)) {
      throw new Error("Historical base is not in current origin/main history");
    }
  } else if (!isAncestor(root, ownedMain, base)) {
    throw new Error("Owned base is behind origin/main");
  }
  if (!isAncestor(root, previous, base))
    throw new Error("Recorded integration is absent from owned base");
  if (!isAncestor(root, previous, target) || !isAncestor(root, target, officialMain)) {
    throw new Error("Target is not on official upstream/main after the recorded integration");
  }
  if (isAncestor(root, target, base)) throw new Error("Target is already integrated in owned base");
  const mergeBase = output(root, ["merge-base", base, target]);
  const ownedPaths = nulPaths(
    git(root, ["diff", "--no-renames", "--name-only", "-z", mergeBase, base]).stdout,
  );
  const officialPaths = nulPaths(
    git(root, ["diff", "--no-renames", "--name-only", "-z", previous, target]).stdout,
  );
  const ownedSet = new Set(ownedPaths);
  const overlaps = officialPaths.filter((path) => ownedSet.has(path));
  const conflicts = simulatedConflicts(root, base, target);
  const commits = output(root, ["log", "--reverse", "--format=%H %s", `${previous}..${target}`])
    .split("\n")
    .filter(Boolean);
  let nearestTag = null;
  try {
    nearestTag = output(root, ["describe", "--tags", "--abbrev=0", target]);
  } catch (error) {
    if (!/No names found|No tags can describe/u.test(error.message)) throw error;
  }
  return {
    command,
    root,
    sourceCheckoutDirty,
    historicalReplay: args["--historical"] === true,
    base,
    previous,
    target,
    officialMain,
    ownedMain,
    mergeBase,
    commits,
    nearestTag,
    officialPaths,
    overlappingPaths: overlaps,
    referenceOverlaps: overlaps.filter((path) => path.startsWith(".repos/")).length,
    predictedConflicts: conflicts.paths,
    predictedCleanMerge: conflicts.clean,
    worktree: args["--worktree"],
    branch: args["--branch"],
    format: args["--format"] ?? "text",
  };
}

export function startAlignment(plan) {
  if (plan.command !== "start") throw new Error("Only a start plan can create a worktree");
  const destination = NodePath.resolve(plan.worktree);
  if (!NodePath.isAbsolute(plan.worktree) || destination !== plan.worktree) {
    throw new Error("Choose a new absolute worktree path outside the current repository");
  }
  const parentPath = NodePath.dirname(destination);
  if (!NodeFS.existsSync(parentPath))
    throw new Error("Worktree parent directory must already exist");
  const root = NodeFS.realpathSync(plan.root);
  const parent = NodeFS.realpathSync(parentPath);
  if (parent === root || parent.startsWith(`${root}${NodePath.sep}`)) {
    throw new Error("Choose a worktree path outside the current repository");
  }
  try {
    NodeFS.lstatSync(destination);
    throw new Error("Worktree path already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!plan.branch.startsWith("codex/")) throw new Error("Use a dedicated codex/ branch");
  git(plan.root, ["check-ref-format", "--branch", plan.branch]);
  if (
    git(plan.root, ["show-ref", "--verify", "--quiet", `refs/heads/${plan.branch}`], {
      allowConflict: true,
    }).status === 0
  ) {
    throw new Error(`Branch already exists: ${plan.branch}`);
  }
  git(plan.root, ["worktree", "add", "-b", plan.branch, plan.worktree, plan.base]);
  // A successful merge deliberately remains uncommitted; conflicts deliberately
  // remain in the new worktree. Neither outcome advances the integration cursor.
  try {
    const merge = git(
      plan.worktree,
      ["merge", "--no-ff", "--no-commit", "--no-rerere-autoupdate", plan.target],
      { allowConflict: true },
    );
    if (output(plan.worktree, ["rev-parse", "--verify", "MERGE_HEAD"]) !== plan.target) {
      throw new Error("Merge did not retain the frozen official target");
    }
    const unmergedPaths = nulPaths(
      git(plan.worktree, ["diff", "--name-only", "--diff-filter=U", "-z"]).stdout,
    );
    if (merge.status === 1 && unmergedPaths.length === 0) {
      throw new Error("Merge failed without unresolved paths");
    }
    return {
      worktree: plan.worktree,
      branch: plan.branch,
      status: merge.status === 0 ? "awaiting-review" : "needs-resolution",
      unmergedPaths,
    };
  } catch (error) {
    throw new Error(
      `Worktree ${plan.worktree} was left in place for inspection: ${error.message}`,
      {
        cause: error,
      },
    );
  }
}

function printPlan(plan, result) {
  if (plan.format === "json") {
    process.stdout.write(`${JSON.stringify({ ...plan, result }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `Owned base: ${plan.base}\nPrevious official: ${plan.previous}\nTarget: ${plan.target}\n` +
      `Nearest reachable tag: ${plan.nearestTag ?? "none available locally"}\n` +
      `${plan.commits.length} official commits, ${plan.officialPaths.length} changed paths, ` +
      `${plan.overlappingPaths.length} overlapping paths (${plan.referenceOverlaps} reference snapshots), ` +
      `${plan.predictedConflicts.length} predicted conflict paths.\n`,
  );
  if (plan.sourceCheckoutDirty) {
    process.stdout.write("Source checkout is dirty; it will not be changed by this helper.\n");
  }
  if (plan.historicalReplay) {
    process.stdout.write("Historical replay only; this base cannot be used with start.\n");
  }
  for (const commit of plan.commits) process.stdout.write(`  ${commit}\n`);
  process.stdout.write("Overlaps (review even when Git merges cleanly):\n");
  for (const path of plan.overlappingPaths) {
    if (!path.startsWith(".repos/")) process.stdout.write(`  ${path}\n`);
  }
  process.stdout.write("Predicted conflicts:\n");
  for (const path of plan.predictedConflicts) process.stdout.write(`  ${path}\n`);
  if (result) {
    process.stdout.write(
      `Created ${result.worktree} on ${result.branch}: ${result.status}; ` +
        `${result.unmergedPaths.length} unmerged paths. Review before staging or committing.\n`,
    );
  } else {
    process.stdout.write("Read-only plan; no worktree, branch, cursor, or commit changed.\n");
  }
}

export function runAlignment(argv = process.argv.slice(2), options) {
  const plan = inspectAlignment(argv, options);
  const result = plan.command === "start" ? startAlignment(plan) : null;
  printPlan(plan, result);
  return { plan, result };
}

if (import.meta.main) {
  try {
    runAlignment();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
