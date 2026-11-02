const HostProcess = require("../../packages/shared/src/HostProcess.ts");
const {
  buildFilePublicationHelper,
  builtFromThisCheckout,
} = require("../../apps/server/src/scient/workspace/filePublicationTestBuild.ts");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// The tests only this platform can run, or whose disk behavior differs there; every entry must run.
const FILES = {
  win32: [
    "src/scient/overleaf/OverleafGitExecutor.test.ts",
    "src/scient/overleaf/OverleafGitExecutor.windows.test.ts",
    "src/scient/overleaf/OverleafGitBytes.test.ts",
    "src/scient/overleaf/manuscriptPaths.test.ts",
    "src/scient/overleaf/overleafHostPaths.test.ts",
    "src/scient/overleaf/overleafFileAvailability.test.ts",
    "src/scient/overleaf/OverleafSync.folders.test.ts",
    "src/scient/overleaf/OverleafCoordinator.platform.test.ts",
    "src/scient/workspace/WindowsRetainedFileMutation.test.ts",
    "src/scient/workspace/NativeFilePublication.resource.test.ts",
  ],
  darwin: [
    "src/scient/overleaf/OverleafGitExecutor.macos.test.ts",
    "src/scient/overleaf/overleafFileAvailability.macos.test.ts",
    "src/scient/overleaf/OverleafCoordinator.leaseRoom.test.ts",
    "src/scient/overleaf/OverleafCoordinator.privacy.test.ts",
    "src/scient/overleaf/OverleafStateStore.test.ts",
    "src/scient/overleaf/RetainedDiscard.crash.test.ts",
    "src/scient/workspace/PlatformFileIdentity.test.ts",
    "src/scient/workspace/NativeFilePublication.test.ts",
    "src/scient/workspace/fileExchange.test.ts",
    "src/workspace/WorkspaceFileSystem.swap.test.ts",
  ],
};

function validateReport(report, files) {
  const results = report.testResults;
  if (
    report.success !== true ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    !Array.isArray(results) ||
    results.length !== files.length
  )
    throw new Error("Incomplete Overleaf qualification");
  for (const file of files) {
    const matches = results.filter((result) =>
      result.name.replaceAll("\\", "/").endsWith(`/${file}`),
    );
    const result = matches[0];
    if (
      matches.length !== 1 ||
      result.status !== "passed" ||
      !Array.isArray(result.assertionResults) ||
      result.assertionResults.length === 0 ||
      result.assertionResults.some((test) => test.status !== "passed")
    )
      throw new Error(`Missing or skipped Overleaf tests: ${file}`);
  }
}

const HELPERS = [
  ["SCIENT_FILE_PUBLICATION_HELPER", false],
  ["SCIENT_FILE_PUBLICATION_PROBE_HELPER", true],
];

/** One build per job: the fixtures reuse these instead of compiling for every test file. */
function buildHelpers(directory) {
  const env = {};
  for (const [name, probe] of HELPERS) {
    const current = process.env[name];
    env[name] =
      current && builtFromThisCheckout(current, probe)
        ? current
        : buildFilePublicationHelper(path.join(directory, probe ? "probe" : "helper"), probe);
  }
  return env;
}

function platformFiles() {
  const files = FILES[HostProcess.Platform.defaultValue()];
  if (!files)
    throw new Error(`No Overleaf platform tests for ${HostProcess.Platform.defaultValue()}`);
  return files;
}

function run() {
  const root = path.resolve(__dirname, "../..");
  const cwd = path.join(root, "apps/server");
  const files = platformFiles();
  for (const file of files) {
    if (!fs.statSync(path.join(cwd, file), { throwIfNoEntry: false })?.isFile())
      throw new Error(`Missing Overleaf qualification file: ${file}`);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "overleaf-platform-report-"));
  try {
    const env = { ...process.env, ...buildHelpers(path.join(scratch, "helpers")) };
    const output = path.join(scratch, "results.json");
    try {
      execFileSync("vp", ["test", "run", ...files, "--reporter=json", `--outputFile=${output}`], {
        cwd,
        env,
        stdio: "inherit",
        shell: HostProcess.Platform.defaultValue() === "win32",
      });
    } catch (error) {
      // The JSON report is the only record of which tests failed; surface it before cleanup.
      if (fs.existsSync(output)) {
        const report = JSON.parse(fs.readFileSync(output, "utf8"));
        for (const result of report.testResults ?? [])
          for (const assertion of result.assertionResults ?? [])
            if (assertion.status !== "passed")
              console.error(
                `FAILED ${result.name} > ${assertion.fullName ?? assertion.title}: ${
                  (assertion.failureMessages ?? []).join("\n").split("\n")[0] ?? assertion.status
                }`,
              );
      }
      throw error;
    }
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    validateReport(report, files);
    for (const file of files) {
      const result = report.testResults.find((entry) =>
        entry.name.replaceAll("\\", "/").endsWith(`/${file}`),
      );
      const seconds = Math.round((result.endTime - result.startTime) / 1000);
      console.log(`Qualified without skips: ${file} (${seconds} s)`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** `--build-helpers=<dir>`: builds once and hands the paths to the job's later steps. */
function buildForJob(directory) {
  const env = buildHelpers(path.resolve(directory));
  const lines = Object.entries(env).map(([name, value]) => `${name}=${value}`);
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

module.exports = { FILES, validateReport };
if (require.main === module) {
  const build = process.argv.find((argument) => argument.startsWith("--build-helpers="));
  if (build) buildForJob(build.slice("--build-helpers=".length));
  else run();
}
