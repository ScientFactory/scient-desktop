#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

function git(cwd, args, okStatuses = [0]) {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (!okStatuses.includes(result.status)) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

const lines = (text) => text.split("\n").filter(Boolean);
const nulPaths = (text) => text.split("\0").filter(Boolean);

function parseArgs(argv) {
  const options = {
    ref: "origin/main",
    upstream: "upstream/main",
    last: 20,
    format: "markdown",
    minRecurrence: 3,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    index += 1;
    if (flag === "--ref") options.ref = value;
    else if (flag === "--upstream") options.upstream = value;
    else if (flag === "--last") options.last = Number(value);
    else if (flag === "--min-recurrence") options.minRecurrence = Number(value);
    else if (flag === "--format") options.format = value;
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!["markdown", "json"].includes(options.format)) {
    throw new Error("--format must be markdown or json");
  }
  if (!(options.last > 0) || !(options.minRecurrence > 0)) {
    throw new Error("--last and --min-recurrence must be positive numbers");
  }
  return options;
}

function replay(cwd, merge) {
  const [p1, p2] = merge.parents;
  const mergeBase = git(cwd, ["merge-base", p1, p2]).trim();
  // Exit status 1 means the merge conflicted; the conflicted paths follow the tree id.
  const conflicted = nulPaths(
    git(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", p1, p2], [0, 1]),
  ).slice(1);
  const incoming = nulPaths(git(cwd, ["diff", "--no-renames", "--name-only", "-z", mergeBase, p2]));
  const owned = new Set(
    nulPaths(git(cwd, ["diff", "--no-renames", "--name-only", "-z", mergeBase, p1])),
  );
  const incomingPaths = incoming.length;
  return {
    date: merge.date,
    merge: merge.sha,
    target: p2,
    officialCommits: Number(git(cwd, ["rev-list", "--count", `${p1}..${p2}`]).trim()),
    incomingPaths,
    overlaps: incoming.filter((path) => owned.has(path)).length,
    conflicted,
    conflictsPer100: incomingPaths === 0 ? 0 : (conflicted.length * 100) / incomingPaths,
  };
}

export function alignmentTrend(argv = [], { cwd = process.cwd() } = {}) {
  const options = parseArgs(argv);
  const upstream = new Set(lines(git(cwd, ["rev-list", options.upstream])));
  const merges = lines(
    git(cwd, ["log", "--merges", "--format=%H %P|%cI", options.ref, "--not", options.upstream]),
  )
    .map((line) => {
      const [hashes, date] = line.split("|");
      const [sha, ...parents] = hashes.split(" ");
      return { sha, parents, date };
    })
    .filter(
      ({ parents }) =>
        parents.length === 2 && upstream.has(parents[1]) && !upstream.has(parents[0]),
    )
    .slice(0, options.last)
    .reverse();
  const alignments = merges.map((merge) => replay(cwd, merge));
  const counts = new Map();
  for (const alignment of alignments) {
    for (const path of alignment.conflicted) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const recurring = [...counts]
    .filter(([, count]) => count >= options.minRecurrence)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 25)
    .map(([path, count]) => ({ path, count, area: path.split("/").slice(0, 2).join("/") }));
  return { options, alignments, recurring };
}

export function formatMarkdown({ options, alignments, recurring }) {
  const out = [
    `Alignment merges on ${options.ref} (last ${alignments.length}, oldest first)`,
    "",
    "| Date | Target | Official commits | Incoming paths | Overlaps | Conflicted | Conflicts / 100 incoming |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...alignments.map(
      (a) =>
        `| ${a.date.slice(0, 10)} | ${a.target.slice(0, 10)} | ${a.officialCommits} | ` +
        `${a.incomingPaths} | ${a.overlaps} | ${a.conflicted.length} | ${a.conflictsPer100.toFixed(1)} |`,
    ),
    "",
    `Files that keep conflicting (in at least ${options.minRecurrence} of these alignments)`,
    "",
  ];
  if (recurring.length === 0) out.push("None.");
  else {
    out.push("| Conflicts | Area | Path |", "| ---: | --- | --- |");
    for (const r of recurring) out.push(`| ${r.count} | ${r.area} | ${r.path} |`);
  }
  return out.join("\n");
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  try {
    const result = alignmentTrend(process.argv.slice(2));
    console.log(
      result.options.format === "json"
        ? JSON.stringify({ alignments: result.alignments, recurring: result.recurring }, null, 2)
        : formatMarkdown(result),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
