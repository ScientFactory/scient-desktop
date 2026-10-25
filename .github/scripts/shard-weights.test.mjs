import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { weightsFromReports } from "./shard-weights.mjs";

const report = (name, seconds, status = "passed") => ({
  success: true,
  testResults: [{ name, startTime: 1_000, endTime: 1_000 + seconds * 1_000, status }],
});

NodeTest.test("normalizes runner roots, keeps both projects, and takes median samples", () => {
  const samples = [
    report("/home/runner/apps/web/src/a.test.ts", 1),
    report("C:\\work\\apps\\web\\src\\a.test.ts", 3),
    report("/home/runner/apps/web/src/b.browser.test.tsx", 10),
    report("/home/runner/apps/web/src/skipped.test.ts", 0, "pending"),
  ];
  NodeAssert.deepEqual(weightsFromReports(samples), {
    "src/a.test.ts": 2,
    "src/b.browser.test.tsx": 10,
  });
  NodeAssert.deepEqual(weightsFromReports(samples.toReversed()), weightsFromReports(samples));
});

NodeTest.test("rejects malformed inputs instead of silently replacing recorded weights", () => {
  for (const value of [
    {},
    { testResults: [] },
    report("/apps/server/src/a.test.ts", 1),
    report("/apps/web/src/a.test.ts", -1),
    report("/apps/web/src/a.test.ts", NaN),
    {
      success: true,
      testResults: [
        ...report("/apps/web/src/a.test.ts", 1).testResults,
        ...report("/apps/web/src/a.test.ts", 2).testResults,
      ],
    },
  ])
    NodeAssert.throws(() => weightsFromReports([value]));
});

NodeTest.test("server weights include serial imports and setup between file results", () => {
  const first = report("/runner/apps/server/integration/a.test.ts", 2);
  const second = report("/runner/apps/server/scripts/b.test.ts", 1);
  second.testResults[0].startTime = 6_000;
  second.testResults[0].endTime = 7_000;
  const combined = { success: true, testResults: [...second.testResults, ...first.testResults] };
  NodeAssert.deepEqual(weightsFromReports([combined], "server"), {
    "integration/a.test.ts": 2,
    "scripts/b.test.ts": 4,
  });
  NodeAssert.throws(() => weightsFromReports([combined], "mobile"));
  NodeAssert.throws(() => weightsFromReports([{ ...first, success: false }], "server"));
  NodeAssert.throws(() => weightsFromReports([report("/apps/web/src/a.test.ts", 1, "failed")]));
});
