import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { RUNS_PER_SUITE, SHARDS, recentWeights } from "./ci-shard-weights.mjs";

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
const report = (suite, name, seconds, success = true) =>
  Array.from({ length: SHARDS[suite] }, (_, index) =>
    index === 0
      ? single(suite, name, seconds, success)
      : single(suite, `src/shard-${index + 1}.test.ts`, 1, true, index + 1),
  );

NodeTest.test("uses the newest successful reports per suite, ignoring failed ones", () => {
  const runs = [
    {
      runId: 4,
      reports: [
        ...report("web", "src/a.test.ts", 50, false),
        ...report("server", "src/s.test.ts", 4),
      ],
    },
    ...Array.from({ length: RUNS_PER_SUITE }, (_, index) => ({
      runId: 3 - index,
      reports: [
        ...report("web", "src/a.test.ts", 10 + index),
        ...report("server", "src/s.test.ts", 1),
      ],
    })),
  ];
  const weights = recentWeights(runs);
  // The failed web report is ignored; the median comes from the next three runs.
  NodeAssert.equal(weights.web["src/a.test.ts"], 11);
  // Only the newest three server runs count, so the oldest sample is dropped.
  NodeAssert.equal(weights.server["src/s.test.ts"], 1);
});

NodeTest.test("a suite without a usable report falls back to the checked-in weights", () => {
  const weights = recentWeights([
    {
      runId: 1,
      reports: [...report("web", "src/a.test.ts", 1, false), ...report("server", "bad/path.ts", 1)],
    },
  ]);
  NodeAssert.deepEqual(weights, { web: null, server: null });
});

NodeTest.test(
  "a run counts for a suite only with every shard, from each shard's latest attempt",
  () => {
    const complete = (seconds, runId) => ({
      runId,
      reports: report("web", "src/a.test.ts", seconds),
    });
    const missingShard = { runId: 9, reports: report("web", "src/a.test.ts", 90).slice(1) };
    // Shard 1 failed on attempt 1 and passed on attempt 2: only the passing retry is read.
    const retried = {
      runId: 8,
      reports: [
        ...report("web", "src/a.test.ts", 80),
        single("web", "src/a.test.ts", 30, true, 1, 2),
      ],
    };
    // Twelve reports, but shard 13 instead of shard 1: not the matrix's shards.
    const wrongShard = {
      runId: 10,
      reports: [
        ...report("web", "src/a.test.ts", 70).slice(1),
        single("web", "src/a.test.ts", 70, true, 13),
      ],
    };
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

NodeTest.test("the shard counts match the CI matrices", () => {
  const workflow = NodeFS.readFileSync(
    NodeURL.fileURLToPath(new URL("../workflows/ci.yml", import.meta.url)),
    "utf8",
  );
  for (const [suite, job] of [
    ["web", "test_web"],
    ["server", "test_server"],
  ]) {
    const block = workflow.slice(workflow.indexOf(`\n  ${job}:\n`));
    const shards = /shard: \[([\d, ]+)\]/.exec(block)?.[1].split(",").length;
    NodeAssert.equal(shards, SHARDS[suite], job);
  }
});
