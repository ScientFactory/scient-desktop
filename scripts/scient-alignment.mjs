#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

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
const isImplementationPath = (path) => !/\.(test|spec)\.[cm]?[jt]sx?$/u.test(path);

function impactSignals(root, previous, target, paths) {
  const signals = [];
  const report = (id, affectedPaths, suggestedCheck) => {
    if (affectedPaths.length > 0) signals.push({ id, paths: affectedPaths, suggestedCheck });
  };
  const qualityPaths = paths.filter(
    (path) =>
      path === "vite.config.ts" ||
      path === ".github/workflows/ci.yml" ||
      (isImplementationPath(path) && /^scripts\/(lint|check|verify)-/u.test(path)),
  );
  if (paths.includes("package.json")) {
    try {
      const before = JSON.parse(output(root, ["show", `${previous}:package.json`]));
      const after = JSON.parse(output(root, ["show", `${target}:package.json`]));
      if (!NodeUtil.isDeepStrictEqual(before.scripts, after.scripts))
        qualityPaths.push("package.json");
    } catch {
      // A changed or removed manifest needs review, not a failed read-only plan.
      qualityPaths.push("package.json");
    }
  }
  report("quality-policy", qualityPaths, "Inspect changed gates; run affected static checks early");
  report(
    "shared-web-ui",
    paths.filter(
      (path) => isImplementationPath(path) && path.startsWith("apps/web/src/components/ui/"),
    ),
    "Trace changed primitive APIs into Scient consumers; consider early web lint and typecheck",
  );
  report(
    "shared-contracts",
    paths.filter(
      (path) => isImplementationPath(path) && path.startsWith("packages/contracts/src/"),
    ),
    "Trace producers and clients; consider early affected-package typechecks",
  );
  return signals;
}

function argumentsFor(argv) {
  const [command, ...rest] = argv;
  if (!["plan", "start"].includes(command)) throw new Error("Use plan or start");
  const args = {};
  const allowed = new Set(["--base", "--target", "--format", "--worktree", "--branch"]);
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--historical" || flag === "--existing") {
      if (command !== "plan" || Object.hasOwn(args, flag)) {
        throw new Error(`${flag} is a plan-only flag and may be supplied once`);
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
  if (args["--historical"] && args["--existing"]) {
    throw new Error("--historical and --existing cannot be combined");
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
  if (args["--existing"]) {
    const branch = output(root, ["branch", "--show-current"]);
    const head = output(root, ["rev-parse", "HEAD"]);
    if (
      git(root, ["rev-parse", "--verify", "-q", "MERGE_HEAD"], { allowConflict: true }).status === 0
    ) {
      throw new Error("Finish the current merge before planning an extension");
    }
    if (branch !== state.lastRefreshBranch || !branch.startsWith("codex/") || base !== head) {
      throw new Error("--existing requires HEAD of the recorded codex/ alignment branch");
    }
    const merge = state.lastRefreshMerge;
    if (typeof merge !== "string" || !isAncestor(root, merge, base)) {
      throw new Error("Existing branch lacks its recorded upstream merge");
    }
    const parents = output(root, ["rev-list", "--parents", "-n", "1", merge]).split(" ");
    if (parents.length !== 3 || parents[2] !== previous) {
      throw new Error("Recorded upstream merge does not have the integration tip as second parent");
    }
  } else if (args["--historical"]) {
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
    existingBranch: args["--existing"] === true,
    ownedMainCatchUpRequired: !isAncestor(root, ownedMain, base),
    base,
    previous,
    target,
    officialMain,
    ownedMain,
    mergeBase,
    commits,
    nearestTag,
    officialPaths,
    impactSignals: impactSignals(root, previous, target, officialPaths),
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
    process.stdout.write(
      "Source checkout is dirty; this plan uses committed history only and will not change it.\n",
    );
  }
  if (plan.historicalReplay) {
    process.stdout.write("Historical replay only; this base cannot be used with start.\n");
  }
  if (plan.existingBranch) {
    process.stdout.write(
      "Existing alignment branch; extend it in place after reviewing this plan.\n",
    );
    if (plan.ownedMainCatchUpRequired) {
      process.stdout.write(
        "Owned main has commits not in this branch; review one catch-up before final qualification.\n",
      );
    }
  }
  for (const commit of plan.commits) process.stdout.write(`  ${commit}\n`);
  if (plan.impactSignals.length > 0) {
    process.stdout.write("Advisory downstream-impact signals (not conflicts or blockers):\n");
    for (const signal of plan.impactSignals) {
      process.stdout.write(
        `  ${signal.id}: ${signal.paths.length} changed paths; ${signal.suggestedCheck}.\n`,
      );
    }
  }
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
