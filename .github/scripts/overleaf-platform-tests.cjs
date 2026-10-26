const HostProcess = require("../../packages/shared/src/HostProcess.ts");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Extend this list as Windows file-publication qualification lands; every entry must run.
const FILES = [
  "src/scient/overleaf/OverleafGitExecutor.test.ts",
  "src/scient/overleaf/OverleafGitExecutor.windows.test.ts",
  "src/scient/overleaf/OverleafGitBytes.test.ts",
  "src/scient/overleaf/manuscriptPaths.test.ts",
  "src/scient/overleaf/overleafHostPaths.test.ts",
  "src/scient/overleaf/overleafFileAvailability.test.ts",
];

function validateReport(report, file) {
  const results = report.testResults;
  if (
    report.success !== true ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    !Array.isArray(results) ||
    results.length !== 1
  )
    throw new Error(`Incomplete Overleaf qualification: ${file}`);
  const result = results[0];
  if (
    !result.name.replaceAll("\\", "/").endsWith(`/${file}`) ||
    result.status !== "passed" ||
    !Array.isArray(result.assertionResults) ||
    result.assertionResults.length === 0 ||
    result.assertionResults.some((test) => test.status !== "passed")
  )
    throw new Error(`Missing or skipped Overleaf tests: ${file}`);
}

function run() {
  const root = path.resolve(__dirname, "../..");
  const cwd = path.join(root, "apps/server");
  for (const file of FILES) {
    if (!fs.statSync(path.join(cwd, file), { throwIfNoEntry: false })?.isFile())
      throw new Error(`Missing Overleaf qualification file: ${file}`);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "overleaf-platform-report-"));
  try {
    for (const [index, file] of FILES.entries()) {
      const output = path.join(scratch, `${index}.json`);
      execFileSync("vp", ["test", "run", file, "--reporter=json", `--outputFile=${output}`], {
        cwd,
        stdio: "inherit",
        shell: HostProcess.Platform.defaultValue() === "win32",
      });
      validateReport(JSON.parse(fs.readFileSync(output, "utf8")), file);
      console.log(`Qualified without skips: ${file}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
module.exports = { FILES, validateReport };
if (require.main === module) run();
