// What Vitest's JSON report leaves out: how the run ended, errors outside any test, and test
// files that never finished. The alignment gates add it to the server suite
// (scripts/scient-alignment-gates.mjs) and read the file named by SCIENT_VITEST_RUN_OUTCOME.

import * as NodeFS from "node:fs";

const FINISHED = new Set(["passed", "failed", "skipped"]);

export default class RunOutcomeReporter {
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const file = process.env.SCIENT_VITEST_RUN_OUTCOME;
    if (!file) return;
    const outcome = {
      reason,
      modules: testModules.length,
      unfinished: testModules
        .filter((module) => !FINISHED.has(module.state()))
        .map((module) => module.moduleId),
      unhandledErrors: unhandledErrors.map(
        (error) => String(error?.message ?? error).split("\n")[0],
      ),
    };
    NodeFS.writeFileSync(file, `${JSON.stringify(outcome)}\n`);
  }
}
