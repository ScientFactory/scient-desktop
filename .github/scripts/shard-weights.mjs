import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Reports may come from different runner roots. Normalize to the owning package,
// and use medians when several complete CI runs supply samples for one file.
export function weightsFromReports(reports, suite = "web") {
  if (!["web", "server"].includes(suite)) throw new Error(`Unknown suite: ${suite}`);
  const samples = new Map();
  for (const report of reports) {
    if (!Array.isArray(report.testResults) || report.testResults.length === 0)
      throw new Error("Expected a nonempty Vitest JSON report");
    if (report.success !== true) throw new Error("Expected a successful Vitest report");
    const seen = new Set();
    let previousEnd;
    for (const result of [...report.testResults].sort((a, b) => a.endTime - b.endTime)) {
      const name = result.name.replaceAll("\\", "/");
      const marker = `/apps/${suite}/`;
      const key = name.slice(name.lastIndexOf(marker) + marker.length);
      if (!name.includes(marker) || !/^(src|integration|scripts)\/.*\.test\.(ts|tsx)$/.test(key))
        throw new Error(`Unexpected ${suite} test path: ${name}`);
      if (seen.has(key)) throw new Error(`Duplicate file in report: ${key}`);
      seen.add(key);
      if (result.status === "pending") continue;
      if (result.status !== "passed") throw new Error(`Unsuccessful file: ${key}`);
      const duration = (result.endTime - result.startTime) / 1_000;
      if (!Number.isFinite(duration) || duration < 0) throw new Error(`Invalid duration: ${key}`);
      // Server files run serially. End-to-end gaps include their import/setup cost;
      // web projects overlap, so only their individual file durations are meaningful.
      const seconds =
        suite === "server" && previousEnd !== undefined
          ? (result.endTime - previousEnd) / 1_000
          : duration;
      previousEnd = result.endTime;
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`Invalid duration: ${key}`);
      const values = samples.get(key) ?? [];
      values.push(seconds);
      samples.set(key, values);
    }
  }
  return Object.fromEntries(
    [...samples]
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, values]) => {
        values.sort((a, b) => a - b);
        const middle = Math.floor(values.length / 2);
        const median =
          values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
        return [key, Math.max(0.001, Math.round(median * 1_000) / 1_000)];
      }),
  );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const suite = args[0] === "--suite" ? args.splice(0, 2)[1] : "web";
  const paths = args;
  if (!paths.length)
    throw new Error(
      "Usage: node .github/scripts/shard-weights.mjs [--suite web|server] <report.json>...",
    );
  const weights = weightsFromReports(
    paths.map((path) => JSON.parse(NodeFS.readFileSync(path, "utf8"))),
    suite,
  );
  if (!Object.keys(weights).length) throw new Error("Reports contain no executed tests");
  NodeFS.writeFileSync(
    new URL(`../../apps/${suite}/src/testUtils/shardWeights.json`, import.meta.url),
    `${JSON.stringify(weights, null, 2)}\n`,
  );
  console.log(
    `Recorded ${Object.keys(weights).length} ${suite} test files from ${paths.length} reports.`,
  );
}
