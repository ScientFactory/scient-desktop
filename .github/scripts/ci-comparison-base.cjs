"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const SHA = /^[0-9a-f]{40}$/;

/**
 * The base every change gate diffs against and a receipt records. A PR run's `base.sha` can lag
 * the main GitHub merged its head onto, so that merge's first parent is the base; any other tested
 * commit keeps the event's base, which no receipt joins. Undefined when unknown.
 */
function comparisonBase(event, parents) {
  const pr = event.pull_request;
  if (!pr) return event.merge_group?.base_sha ?? event.before;
  // No parents means Git could not see them (a shallow checkout grafts them away).
  if (parents === null || parents.length === 0) return undefined;
  const [main, head] = parents;
  return parents.length === 2 && SHA.test(main) && head === pr.head?.sha ? main : pr.base?.sha;
}

/** The comparison base of `head` in the repository at `cwd`, read with local Git. */
function resolveComparisonBase({ event, head, cwd = process.cwd() }) {
  let parents = null;
  if (event.pull_request) {
    try {
      // A shallow checkout reports no parents, which leaves the base unknown.
      parents = execFileSync("git", ["rev-list", "--parents", "-n", "1", head, "--"], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        timeout: 30_000,
      })
        .trim()
        .split(" ")
        .slice(1);
    } catch {
      // Unknown parents leave the base unknown; every gate then runs its lanes.
    }
  }
  return comparisonBase(event, parents);
}

if (require.main === module) {
  // Prints the base for this run, or nothing when it cannot be established.
  try {
    const base = resolveComparisonBase({
      event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
      head: process.env.GITHUB_SHA,
    });
    if (typeof base === "string") process.stdout.write(base);
  } catch {
    // Missing or malformed event data: the caller runs everything.
  }
}

module.exports = { comparisonBase, resolveComparisonBase };
