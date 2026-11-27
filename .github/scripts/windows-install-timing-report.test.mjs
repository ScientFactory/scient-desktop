import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { compare, median, renderSummary, report } from "./windows-install-timing-report.mjs";

const statuses = (current, baseline) =>
  Object.fromEntries(compare(current, baseline).map((row) => [row.key, row.status]));

NodeTest.test("the median of an even sample count averages the middle pair", () => {
  NodeAssert.equal(median([9, 1, 5]), 5);
  NodeAssert.equal(median([4, 1, 3, 10]), 4);
  NodeAssert.equal(median([]), null);
});

NodeTest.test("a stage regresses only when slower past both the ratio and its floor", () => {
  const baseline = { installMs: 40_000, firstLaunchMs: 4_000, secondLaunchMs: 2_000 };
  // +30% but only 1.2 s on the first launch and 0.6 s on the second: runner noise.
  NodeAssert.deepEqual(
    statuses({ installMs: 44_000, firstLaunchMs: 5_200, secondLaunchMs: 2_600 }, baseline),
    {
      installMs: "within tolerance",
      firstLaunchMs: "within tolerance",
      secondLaunchMs: "within tolerance",
    },
  );
  // +6 s but only 15% on the install.
  NodeAssert.equal(
    statuses({ ...baseline, installMs: 46_000 }, baseline).installMs,
    "within tolerance",
  );
  NodeAssert.deepEqual(
    statuses({ installMs: 52_000, firstLaunchMs: 6_000, secondLaunchMs: 3_100 }, baseline),
    { installMs: "regressed", firstLaunchMs: "regressed", secondLaunchMs: "regressed" },
  );
  NodeAssert.equal(statuses({ ...baseline, installMs: 20_000 }, baseline).installMs, "improved");
});

NodeTest.test("missing numbers are reported as such, not as regressions", () => {
  NodeAssert.deepEqual(statuses({ installMs: 1, firstLaunchMs: null, secondLaunchMs: 1 }, null), {
    installMs: "no baseline",
    firstLaunchMs: "not measured",
    secondLaunchMs: "no baseline",
  });
});

NodeTest.test("the summary names the baseline, every sample, regressions and failures", () => {
  const sample = (installMs, first, second) => ({
    installMs,
    first: { readyMs: first },
    second: { readyMs: second },
  });
  const measurement = {
    readiness: "app shell and main view",
    installer: { name: "Scient-0.6.36-x64.exe", bytes: 250e6, sha256: "a".repeat(64) },
    installedVersion: "0.6.36.0",
    runner: { image: "win25 1.0", logicalCpus: 4, defenderRealtime: false },
    samples: [sample(28_000, 9_000, 3_000), sample(29_000, 9_500, null)],
    plannedSamples: 3,
    complete: false,
    median: { installMs: 28_500, firstLaunchMs: 9_250, secondLaunchMs: 3_000 },
    failures: ["sample-2-second: the app was not ready within 180.0 s"],
  };
  const baseline = {
    context: { kind: "release", version: "0.6.35", runId: 7, runUrl: "https://example.test/7" },
    measurement: { median: { installMs: 40_000, firstLaunchMs: 6_000, secondLaunchMs: 3_000 } },
  };
  const summary = renderSummary(
    report({
      measurement,
      baseline,
      context: { kind: "release", version: "0.6.36", channel: "stable" },
    }),
  );
  NodeAssert.match(summary, /Baseline: `0\.6\.35` from \[run 7\]\(https:\/\/example\.test\/7\)/);
  NodeAssert.match(
    summary,
    /\| Install \| 28\.5 s \| 28\.0 s, 29\.0 s \| 40\.0 s \| -11\.5 s \| improved \|/,
  );
  NodeAssert.match(
    summary,
    /\| First launch to ready \| 9\.3 s \| 9\.0 s, 9\.5 s \| 6\.0 s \| \+3\.3 s \| ⚠️ regressed \(not re-checked\) \|/,
  );
  NodeAssert.match(summary, /\| Second launch to ready \| 3\.0 s \| 3\.0 s, — \|/);
  NodeAssert.match(summary, /1 stage\(s\) regressed:\*\* First launch to ready/);
  NodeAssert.match(summary, /- sample-2-second: the app was not ready/);
  NodeAssert.match(summary, /\*\*Incomplete:\*\* 2 of 3 samples ran/);
});

NodeTest.test(
  "a regression stands only if the baseline's installer is faster on the same runner",
  () => {
    // The same v0.6.34 installer measured 7.4 s and 11.3 s to a first ready launch on two runners.
    const recorded = { installMs: 40_000, firstLaunchMs: 7_410, secondLaunchMs: 5_600 };
    const current = { installMs: 41_000, firstLaunchMs: 11_290, secondLaunchMs: 8_530 };
    const installer = { sha256: "b".repeat(64) };
    const baseline = { context: {}, measurement: { installer, median: recorded } };
    const timedAgain = (median, overrides = {}) => ({
      installer,
      median,
      complete: true,
      failures: [],
      ...overrides,
    });
    const results = (rerun) => {
      const result = report({ measurement: { median: current }, baseline, context: {}, rerun });
      return [
        result.recheck?.rejection ?? null,
        Object.fromEntries(result.comparison.map((row) => [row.key, row.status])),
      ];
    };
    // On this slow runner the baseline's own installer is as slow to a first launch, not a second.
    NodeAssert.deepEqual(
      results(timedAgain({ installMs: 40_500, firstLaunchMs: 11_000, secondLaunchMs: 6_500 })),
      [
        null,
        {
          installMs: "within tolerance",
          firstLaunchMs: "not confirmed",
          secondLaunchMs: "regressed",
        },
      ],
    );
    const unconfirmed = {
      installMs: "within tolerance",
      firstLaunchMs: "regressed",
      secondLaunchMs: "regressed",
    };
    NodeAssert.deepEqual(results(null), [
      "the baseline's installer could not be timed again",
      unconfirmed,
    ]);
    NodeAssert.deepEqual(results(timedAgain(recorded, { installer: { sha256: "c".repeat(64) } })), [
      "the installer timed again is not the baseline's",
      unconfirmed,
    ]);
    NodeAssert.deepEqual(
      results(timedAgain({ ...recorded, firstLaunchMs: 7_000 }, { complete: false })),
      ["timing the baseline's installer again did not finish cleanly", unconfirmed],
    );
  },
);
