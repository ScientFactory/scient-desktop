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

/** Validate frozen, reviewed Scient branch merges without trusting their ancestry. */
export function validateOwnedIntegrationMerges(input) {
  if (!Array.isArray(input.receipts)) {
    return { receipts: [], failures: ["ownedIntegrationMerges must be an array"] };
  }
  const receipts = [];
  const failures = [];
  const ids = new Set();
  const merges = new Set();
  const fullCommit = /^[0-9a-f]{40}$/;
  for (const receipt of input.receipts) {
    if (
      !receipt ||
      typeof receipt.id !== "string" ||
      receipt.id.trim().length === 0 ||
      typeof receipt.merge !== "string" ||
      !fullCommit.test(receipt.merge) ||
      !Array.isArray(receipt.parents) ||
      receipt.parents.length !== 2 ||
      !receipt.parents.every((parent) => typeof parent === "string" && fullCommit.test(parent)) ||
      typeof receipt.reviewRecord !== "string" ||
      !receipt.reviewRecord.startsWith("docs/") ||
      receipt.reviewRecord.includes("\\") ||
      receipt.reviewRecord.split("/").some((part) => part === ".." || part === "." || part === "")
    ) {
      failures.push("Invalid owned integration merge receipt");
      continue;
    }
    if (ids.has(receipt.id) || merges.has(receipt.merge)) {
      failures.push(`${receipt.id}: duplicate owned integration merge receipt`);
      continue;
    }
    ids.add(receipt.id);
    merges.add(receipt.merge);
    const parents = input.parentsOf(receipt.merge);
    if (
      parents.length !== receipt.parents.length ||
      parents.some((parent, index) => parent !== receipt.parents[index])
    ) {
      failures.push(`${receipt.id}: owned integration merge parents do not match`);
      continue;
    }
    if (!input.isInOwnedHistory(receipt.merge)) {
      failures.push(`${receipt.id}: owned integration merge is not in inspected history`);
      continue;
    }
    if (!input.hasCommittedReviewRecord(receipt.reviewRecord)) {
      failures.push(`${receipt.id}: committed owned integration review record is missing`);
      continue;
    }
    receipts.push(receipt);
  }
  return { receipts, failures };
}

export function validateIntroducedMergeParents(input) {
  const failures = [];
  const queueMerges = new Set();
  if (input.allowQueueMerges === true) {
    // Only the trusted merge_group workflow enables this mode. With the queue
    // configured to MERGE, GitHub's integration commits form the first-parent
    // chain from the event head back to its exact base. PR histories hang off
    // second parents and remain fully checked below.
    const parentsByCommit = new Map(input.merges.map((merge) => [merge.commit, merge.parents]));
    let current = input.head;
    while (current !== input.base) {
      const parents = parentsByCommit.get(current);
      if (parents?.length !== 2 || queueMerges.has(current)) {
        return [`Unexpected merge queue topology at ${current}`];
      }
      queueMerges.add(current);
      current = parents[0];
    }
  }
  for (const merge of input.merges) {
    if (queueMerges.has(merge.commit)) continue;
    if (
      input.allowOwnedHeadMerge === true &&
      merge.commit === input.head &&
      merge.parents[0] === input.base
    ) {
      continue;
    }
    for (const parent of merge.parents.slice(1)) {
      if (input.isOfficialAncestor(parent)) continue;
      if (input.isOwnedAncestor(parent)) continue;
      // Exempt only this exact reviewed edge. Nested merges remain in the full
      // rev-list below and must independently satisfy the same provenance rules.
      if (
        (input.ownedIntegrationMerges ?? []).some(
          (receipt) =>
            receipt.merge === merge.commit &&
            receipt.parents.length === merge.parents.length &&
            receipt.parents.every((candidate, index) => candidate === merge.parents[index]),
        )
      )
        continue;
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

  const ownedIntegrations = validateOwnedIntegrationMerges({
    receipts: state.ownedIntegrationMerges === undefined ? [] : state.ownedIntegrationMerges,
    parentsOf: (commit) => {
      try {
        return git(["show", "-s", "--format=%P", commit]).split(" ").filter(Boolean);
      } catch {
        return [];
      }
    },
    isInOwnedHistory: (commit) => isAncestor(commit, head),
    hasCommittedReviewRecord: (path) => {
      try {
        const entry = git(["ls-tree", head, "--", path]);
        return (
          /^100(?:644|755) blob [0-9a-f]{40}\t/.test(entry) &&
          git(["show", `${head}:${path}`]).length > 0
        );
      } catch {
        return false;
      }
    },
  });
  failures.push(...ownedIntegrations.failures);

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
          ownedIntegrationMerges: ownedIntegrations.receipts,
          allowQueueMerges: args["allow-queue-merges"] === "true",
          allowOwnedHeadMerge: args["allow-owned-head-merge"] === "true",
          isOfficialAncestor: (commit) => isAncestor(commit, args["official-ref"]),
          isOwnedAncestor: (commit) => isAncestor(commit, base),
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
