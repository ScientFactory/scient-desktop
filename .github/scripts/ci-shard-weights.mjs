// SCIENT-FORK:START — refresh the checked-in shard weights from the newest main timings.
// docs/operations/development.md has the command. Each suite takes a run only when that run has
// a successful report from every one of its shards, so a partial run cannot skew the split.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { weightsFromReports } from "./shard-weights.mjs";

const SUITES = ["web", "server"];
// The shard matrices of test_web and test_server in ci.yml; a test keeps them equal.
export const SHARDS = { web: 12, server: 16 };
// Medians over a few runs keep one slow run from moving the split.
export const RUNS_PER_SUITE = 3;
const REPORT = /^vitest-(web|server)-(\d+)-attempt-(\d+)$/;

/**
 * Groups each suite's complete runs, newest first: one successful report per shard, from that
 * shard's latest successful attempt. A run missing any shard is not used for that suite.
 */
export function collectReports(runs) {
  const bySuite = Object.fromEntries(SUITES.map((suite) => [suite, []]));
  for (const run of runs) {
    for (const suite of SUITES) {
      const byShard = new Map();
      for (const entry of run.reports) {
        if (entry.suite !== suite || entry.report?.success !== true) continue;
        const kept = byShard.get(entry.shard);
        if (!kept || entry.attempt > kept.attempt) byShard.set(entry.shard, entry);
      }
      const complete = Array.from({ length: SHARDS[suite] }, (_, i) => i + 1).every((shard) =>
        byShard.has(shard),
      );
      if (complete && byShard.size === SHARDS[suite] && bySuite[suite].length < RUNS_PER_SUITE)
        bySuite[suite].push([...byShard.values()].map((entry) => entry.report));
    }
  }
  return bySuite;
}

/** Weights per suite, or null when no complete run supplied its reports. */
export function recentWeights(runs) {
  const bySuite = collectReports(runs);
  return Object.fromEntries(
    SUITES.map((suite) => {
      const reports = bySuite[suite].flat();
      if (!reports.length) return [suite, null];
      try {
        const weights = weightsFromReports(reports, suite);
        return [suite, Object.keys(weights).length ? weights : null];
      } catch (error) {
        console.warn(`Ignoring ${suite} reports: ${error.message}`);
        return [suite, null];
      }
    }),
  );
}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const gh = async (args) =>
  (await execFile("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })).stdout;

// Runs `work` over `items` with at most `limit` in flight; downloads are latency-bound.
async function pool(items, limit, work) {
  const results = [];
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}

async function readRuns(repository, runIds, scratch) {
  const listed = await pool(runIds, 8, async (runId) => {
    try {
      const names = JSON.parse(
        await gh([
          "api",
          `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
          "--jq",
          "[.artifacts[] | select(.expired | not) | .name]",
        ]),
      );
      return names.filter((name) => REPORT.test(name)).map((name) => ({ runId, name }));
    } catch (error) {
      console.warn(
        `No artifacts from run ${runId}: ${String(error.stderr ?? error.message).trim()}`,
      );
      return [];
    }
  });
  const reports = await pool(listed.flat(), 16, async ({ runId, name }) => {
    const directory = NodePath.join(scratch, String(runId), name);
    try {
      await gh([
        "run",
        "download",
        String(runId),
        "--repo",
        repository,
        "--dir",
        directory,
        "--name",
        name,
      ]);
      const [suite, shard, attempt] = REPORT.exec(name).slice(1);
      return NodeFS.readdirSync(directory)
        .filter((file) => file.endsWith(".json"))
        .map((file) => ({
          runId,
          suite,
          shard: Number(shard),
          attempt: Number(attempt),
          report: JSON.parse(NodeFS.readFileSync(NodePath.join(directory, file), "utf8")),
        }));
    } catch (error) {
      console.warn(
        `Skipping ${name} from run ${runId}: ${String(error.stderr ?? error.message).trim()}`,
      );
      return [];
    }
  });
  return runIds.map((runId) => ({
    runId,
    reports: reports.flat().filter((entry) => entry.runId === runId),
  }));
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const [output] = process.argv.slice(2);
  if (!output) throw new Error("Usage: node .github/scripts/ci-shard-weights.mjs <output-dir>");
  // A fresh directory, so a suite with no complete run leaves no older file to copy.
  if (NodeFS.existsSync(output) && NodeFS.readdirSync(output).length)
    throw new Error(`${output} is not empty; give the refresh a new directory.`);
  const repository = process.env.GITHUB_REPOSITORY;
  const ids = JSON.parse(
    await gh([
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      "ci.yml",
      "--branch",
      "main",
      "--event",
      "push",
      "--status",
      "completed",
      "--limit",
      "8",
      "--json",
      "databaseId",
    ]),
  ).map((run) => run.databaseId);
  const scratch = NodeFS.mkdtempSync(
    NodePath.join(process.env.RUNNER_TEMP ?? NodeOS.tmpdir(), "shard-reports-"),
  );
  // The newest runs usually suffice; older ones are read only to fill a suite that failed.
  const runs = await readRuns(repository, ids.slice(0, RUNS_PER_SUITE), scratch);
  const bySuite = collectReports(runs);
  if (SUITES.some((suite) => bySuite[suite].length < RUNS_PER_SUITE))
    runs.push(...(await readRuns(repository, ids.slice(RUNS_PER_SUITE), scratch)));
  const weights = recentWeights(runs);
  NodeFS.mkdirSync(output, { recursive: true });
  const found = [];
  for (const suite of SUITES) {
    if (!weights[suite]) continue;
    NodeFS.writeFileSync(
      NodePath.join(output, `${suite}.json`),
      `${JSON.stringify(weights[suite], null, 2)}\n`,
    );
    found.push(`${suite} (${Object.keys(weights[suite]).length} files)`);
  }
  console.log(
    found.length
      ? `Recent weights: ${found.join(", ")}`
      : "No complete recent run; keep the checked-in weights.",
  );
}
// SCIENT-FORK:END
