const assert = require("node:assert/strict");
const test = require("node:test");
const { validateReport } = require("./overleaf-platform-tests.cjs");

const file = "src/scient/overleaf/OverleafGitExecutor.test.ts";
const complete = () => ({
  success: true,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [
    {
      name: `D:/checkout/apps/server/${file}`,
      status: "passed",
      assertionResults: [{ status: "passed" }],
    },
  ],
});
test("platform evidence rejects skipped, missing, empty and wrong-file reports", () => {
  validateReport(complete(), file);
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
      r.testResults = [];
    },
    (r) => {
      r.testResults[0].name = "other.test.ts";
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
    assert.throws(() => validateReport(report, file), /Overleaf/);
  }
});
