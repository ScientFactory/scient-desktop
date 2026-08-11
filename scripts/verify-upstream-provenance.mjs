#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

function git(args, options = {}) {
  return NodeChildProcess.execFileSync("git", args, {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "pipe"],
  }).trim();
}

function isAncestor(ancestor, descendant) {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

export function validateIntroducedMergeParents(input) {
  const failures = [];
  for (const merge of input.merges) {
    if (
      input.allowOwnedHeadMerge === true &&
      merge.commit === input.head &&
      merge.parents[0] === input.base
    ) {
      continue;
    }
    for (const parent of merge.parents.slice(1)) {
      if (input.isOfficialAncestor(parent)) continue;
      const exception = input.exceptions.find(
        (candidate) => candidate.head === parent && candidate.importMerge === merge.commit,
      );
      if (!exception) failures.push(`${merge.commit}: non-official merge parent ${parent}`);
    }
  }
  return failures;
}

export function verifyUpstreamProvenance(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const state = JSON.parse(NodeFS.readFileSync("upstream-state.json", "utf8"));
  const failures = [];
  const head = git(["rev-parse", args.head ?? "HEAD"]);
  const base = args.base ? git(["rev-parse", args.base]) : null;
  if (state.schemaVersion !== 2) failures.push("upstream-state.json must use schemaVersion 2");
  if (state.updateMode !== "thin-fork-merge") failures.push("unexpected upstream update mode");
  if (!isAncestor(state.integrationBase, head)) {
    failures.push(`integrationBase is not an ancestor of ${head}`);
  }

  const exceptions = state.historicalExceptions ?? [];
  for (const exception of exceptions) {
    if (exception.followUpdates !== false)
      failures.push(`${exception.id}: followUpdates must be false`);
    if (exception.includedInIntegrationBase !== false) {
      failures.push(`${exception.id}: must remain outside integrationBase`);
    }
    if (!isAncestor(exception.head, exception.importMerge)) {
      failures.push(`${exception.id}: head is not an ancestor of importMerge`);
    }
    if (!isAncestor(exception.importMerge, head)) {
      failures.push(`${exception.id}: importMerge is not in owned history`);
    }
    for (const commit of exception.commits ?? []) {
      if (!isAncestor(commit, exception.head))
        failures.push(`${exception.id}: missing commit ${commit}`);
    }
    if (!NodeFS.existsSync(exception.replacementRecord)) {
      failures.push(`${exception.id}: replacement record is missing`);
    }
  }

  if (args["official-ref"]) {
    if (!isAncestor(state.integrationBase, args["official-ref"])) {
      failures.push("integrationBase is not part of official upstream main");
    }
    if (base && args.head) {
      const rows = git(["rev-list", "--parents", `${base}..${head}`])
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" "));
      failures.push(
        ...validateIntroducedMergeParents({
          base,
          head,
          merges: rows
            .filter((row) => row.length > 2)
            .map(([commit, ...parents]) => ({ commit, parents })),
          exceptions,
          allowOwnedHeadMerge: args["allow-owned-head-merge"] === "true",
          isOfficialAncestor: (commit) => isAncestor(commit, args["official-ref"]),
        }),
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Upstream provenance check passed at integrationBase ${state.integrationBase}.\n`,
  );
}

if (import.meta.main) verifyUpstreamProvenance();
