import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { RUNS_PER_SUITE, SHARDS, matrixShards, recentWeights } from "./ci-shard-weights.mjs";

const single = (suite, name, seconds, success = true, shard = 1, attempt = 1) => ({
  suite,
  shard,
  attempt,
  report: {
    success,
    testResults: [
      {
        name: `/runner/apps/${suite}/${name}`,
        startTime: 0,
        endTime: seconds * 1_000,
        status: "passed",
      },
    ],
  },
});
// One report per shard: `name` on shard 1, a placeholder file on each other shard.
// A run whose own ci.yml had today's matrices.
const ran = (runId, reports, shards = SHARDS) => ({ runId, shards, reports });
const report = (suite, name, seconds, success = true) =>
  Array.from({ length: SHARDS[suite] }, (_, index) =>
    index === 0
      ? single(suite, name, seconds, success)
      : single(suite, `src/shard-${index + 1}.test.ts`, 1, true, index + 1),
  );

NodeTest.test("uses the newest successful reports per suite, ignoring failed ones", () => {
  const runs = [
    ran(4, [...report("web", "src/a.test.ts", 50, false), ...report("server", "src/s.test.ts", 4)]),
    ...Array.from({ length: RUNS_PER_SUITE }, (_, index) =>
      ran(3 - index, [
        ...report("web", "src/a.test.ts", 10 + index),
        ...report("server", "src/s.test.ts", 1),
      ]),
    ),
  ];
  const weights = recentWeights(runs);
  // The failed web report is ignored; the median comes from the next three runs.
  NodeAssert.equal(weights.web["src/a.test.ts"], 11);
  // Only the newest three server runs count, so the oldest sample is dropped.
  NodeAssert.equal(weights.server["src/s.test.ts"], 1);
});

NodeTest.test("a suite without a usable report falls back to the checked-in weights", () => {
  const weights = recentWeights([
    ran(1, [...report("web", "src/a.test.ts", 1, false), ...report("server", "bad/path.ts", 1)]),
  ]);
  NodeAssert.deepEqual(weights, { web: null, server: null });
});

NodeTest.test(
  "a run counts for a suite only with every shard, from each shard's latest attempt",
  () => {
    const complete = (seconds, runId) => ran(runId, report("web", "src/a.test.ts", seconds));
    const missingShard = ran(9, report("web", "src/a.test.ts", 90).slice(1));
    // Shard 1 failed on attempt 1 and passed on attempt 2: only the passing retry is read.
    const retried = ran(8, [
      ...report("web", "src/a.test.ts", 80),
      single("web", "src/a.test.ts", 30, true, 1, 2),
    ]);
    // One report per shard, but shard 13 instead of shard 1: not the matrix's shards.
    const wrongShard = ran(10, [
      ...report("web", "src/a.test.ts", 70).slice(1),
      single("web", "src/a.test.ts", 70, true, 13),
    ]);
    const weights = recentWeights([
      wrongShard,
      missingShard,
      retried,
      complete(20, 7),
      complete(10, 6),
    ]);
    // Runs 10 and 9 are incomplete; runs 8, 7 and 6 give 30, 20 and 10 for the file.
    NodeAssert.equal(weights.web["src/a.test.ts"], 20);
  },
);

// A wider matrix than today's, as ci.yml ran before its shard counts fell.
const OLD = { web: 16, server: 16 };
const old = (suite, runId, seconds, passed = OLD[suite]) =>
  ran(
    runId,
    Array.from({ length: OLD[suite] }, (_, index) =>
      single(
        suite,
        index === 0 ? "src/a.test.ts" : `src/shard-${index + 1}.test.ts`,
        seconds,
        index < passed,
        index + 1,
      ),
    ),
    OLD,
  );

NodeTest.test("a run from a wider matrix, before the shard count fell, is not used", () => {
  NodeAssert.deepEqual(recentWeights([old("web", 2, 40), old("server", 1, 40)]), {
    web: null,
    server: null,
  });
  const weights = recentWeights([old("web", 3, 40), ran(2, report("web", "src/a.test.ts", 5))]);
  NodeAssert.equal(weights.web["src/a.test.ts"], 5);
});

NodeTest.test("a partial run from the wider matrix is not taken for a complete new one", () => {
  // Today's shards passed and the higher ones failed: exactly today's reports, from another matrix.
  NodeAssert.deepEqual(recentWeights([old("web", 2, 40, SHARDS.web)]).web, null);
  // The same eight reports, with the higher-numbered artifacts missing or unreadable.
  const missing = old("web", 2, 40);
  missing.reports = missing.reports.slice(0, SHARDS.web);
  NodeAssert.deepEqual(recentWeights([missing]).web, null);
  // A run whose workflow could not be read is not used either.
  NodeAssert.deepEqual(recentWeights([ran(1, report("web", "src/a.test.ts", 5), null)]).web, null);
  const weights = recentWeights([
    old("web", 3, 40, SHARDS.web),
    ran(2, report("web", "src/a.test.ts", 5)),
  ]);
  NodeAssert.equal(weights.web["src/a.test.ts"], 5);
});

NodeTest.test("reads each suite's shard count from a run's own workflow", () => {
  const matrix = (shards) =>
    `    strategy:\n      matrix:\n        shard: [${shards.join(", ")}]\n`;
  const range = (count) => Array.from({ length: count }, (_, index) => index + 1);
  const workflow = (web, server) =>
    `jobs:\n  test_web:\n${matrix(web)}  # between\n  test_server:\n${matrix(server)}  check:\n    needs: [test_web]\n`;
  NodeAssert.deepEqual(matrixShards(workflow(range(16), range(16))), OLD);
  NodeAssert.deepEqual(matrixShards(workflow(range(8), [1, 2, 4])), { web: 8, server: null });
  NodeAssert.deepEqual(matrixShards("jobs:\n  test:\n" + matrix(range(6))), {
    web: null,
    server: null,
  });
});

NodeTest.test("the shard counts match the CI matrices", () => {
  const workflow = NodeFS.readFileSync(
    NodeURL.fileURLToPath(new URL("../workflows/ci.yml", import.meta.url)),
    "utf8",
  );
  NodeAssert.deepEqual(matrixShards(workflow), SHARDS);
});
