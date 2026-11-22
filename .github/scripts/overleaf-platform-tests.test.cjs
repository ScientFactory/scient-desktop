const assert = require("node:assert/strict");
const test = require("node:test");
const { failures, validateReport } = require("./overleaf-platform-tests.cjs");

const file = "src/scient/overleaf/OverleafGitExecutor.test.ts";
const files = [file, "src/scient/overleaf/OverleafGitBytes.test.ts"];
const complete = () => ({
  success: true,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: files.map((file) => ({
    name: `D:/checkout/apps/server/${file}`,
    status: "passed",
    assertionResults: [{ status: "passed" }],
  })),
});
test("platform evidence rejects skipped, missing, empty and wrong-file reports", () => {
  validateReport(complete(), files);
  for (const alter of [
    (r) => {
      r.success = false;
    },
    (r) => {
      r.numPendingTests = 1;
    },
    (r) => {
      r.numTodoTests = 1;
    },
    (r) => {
      r.testResults.pop();
    },
    (r) => {
      r.testResults[0].name = r.testResults[1].name;
    },
    (r) => {
      r.testResults[0].assertionResults = [];
    },
    (r) => {
      r.testResults[0].assertionResults[0].status = "pending";
    },
  ]) {
    const report = complete();
    alter(report);
    assert.throws(() => validateReport(report, files), /Overleaf/);
  }
});

test("a failure shows its message beyond the first line, bounded", () => {
  const report = complete();
  const hdiutil = [
    "Error: Command failed: /usr/bin/hdiutil detach -force /tmp/mount-fat",
    "hdiutil: detach failed - Resource busy",
    ...Array.from({ length: 30 }, (_, i) => `    at frame ${i}`),
  ].join("\n");
  report.testResults[0].assertionResults = [
    { status: "passed", fullName: "passes" },
    { status: "failed", fullName: "refuses FAT32", failureMessages: [hdiutil] },
    { status: "failed", title: "times out", failureMessages: [] },
  ];
  const lines = failures(report);
  assert.equal(lines[0], `FAILED D:/checkout/apps/server/${file} > refuses FAT32`);
  assert.equal(lines[2], "  hdiutil: detach failed - Resource busy");
  assert.equal(lines.filter((line) => line.startsWith("    at frame")).length, 0);
  assert.equal(lines.filter((line) => line.startsWith("      at frame")).length, 18);
  assert.deepEqual(lines.slice(-2), [
    `FAILED D:/checkout/apps/server/${file} > times out`,
    "  failed",
  ]);
});
