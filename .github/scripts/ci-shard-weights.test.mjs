import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { RUNS_PER_SUITE, recentWeights } from "./ci-shard-weights.mjs";

const report = (suite, name, seconds, success = true) => ({
  suite,
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

NodeTest.test("uses the newest successful reports per suite, ignoring failed ones", () => {
  const runs = [
    {
      runId: 4,
      reports: [report("web", "src/a.test.ts", 50, false), report("server", "src/s.test.ts", 4)],
    },
    ...Array.from({ length: RUNS_PER_SUITE }, (_, index) => ({
      runId: 3 - index,
      reports: [report("web", "src/a.test.ts", 10 + index), report("server", "src/s.test.ts", 1)],
    })),
  ];
  const weights = recentWeights(runs);
  // The failed web report is ignored; the median comes from the next three runs.
  NodeAssert.deepEqual(weights.web, { "src/a.test.ts": 11 });
  // Only the newest three server runs count, so the oldest sample is dropped.
  NodeAssert.deepEqual(weights.server, { "src/s.test.ts": 1 });
});

NodeTest.test("a suite without a usable report falls back to the checked-in weights", () => {
  const weights = recentWeights([
    {
      runId: 1,
      reports: [report("web", "src/a.test.ts", 1, false), report("server", "bad/path.ts", 1)],
    },
  ]);
  NodeAssert.deepEqual(weights, { web: null, server: null });
});
