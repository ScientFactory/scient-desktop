import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";
import {
  computeQualificationSuites,
  needsComputeQualification,
  testGatePasses,
} from "./compute-ci-gate.mjs";

const neither = { realKernel: false, managedPython: false };
const kernel = { realKernel: true, managedPython: false };
const managed = { realKernel: false, managedPython: true };
const both = { realKernel: true, managedPython: true };

NodeTest.test("known suite-specific inputs select only their consumer", () => {
  for (const path of [
    "apps/server/src/preview/PortScanner.ts",
    "apps/server/src/preview/PortScanner.test.ts",
    "apps/server/src/preview/PortScannerPythonCompute.integration.test.ts",
    "apps/server/src/scient/compute/PythonKernel.integration.test.ts",
    "apps/server/src/scient/compute/PythonComputeService.integration.test.ts",
    "apps/server/src/scient/compute/FreshCompute.integration.test.ts",
  ])
    NodeAssert.deepEqual(computeQualificationSuites([path]), kernel, path);
  for (const path of [
    "apps/server/src/scient/compute/ManagedPythonProduct.live.test.ts",
    "apps/server/src/scient/compute/ComputeRecipe.live.test.ts",
    "apps/server/src/scient/compute/managed-python/pyproject.toml",
    "apps/server/src/scient/compute/managed-python/uv.lock",
  ])
    NodeAssert.deepEqual(computeQualificationSuites([path]), managed, path);
});

NodeTest.test("shared runtime, setup and uncertain dependencies retain both suites", () => {
  for (const path of [
    "apps/server/src/scient/compute/ComputeSessionService.ts",
    "apps/server/src/scient/compute/ManagedPythonEnvironment.ts",
    "apps/server/src/scient/compute/ManagedPythonProvisioner.ts",
    "apps/server/src/scient/compute/ComputeRecipeSource.ts",
    "apps/server/src/scient/compute/managed-python/bundled-recipes.json",
    "apps/server/src/scient/compute/NewRuntimeDependency.ts",
    "apps/server/src/scient/compute/bridge/scient_compute_bridge.py",
    "apps/server/src/scient/execution/LocalOwnedProcess.ts",
    "apps/server/src/atomicWrite.ts",
    "apps/server/src/config.ts",
    "apps/server/src/serverSettings.ts",
    "apps/server/src/workspace/WorkspacePaths.ts",
    "apps/server/src/testUtils/gitConfig.setup.ts",
    "packages/scient-execution/src/index.ts",
    "packages/scient-project-init/src/index.ts",
    "packages/scient-provider-runtime/src/index.ts",
    "packages/shared/src/hostProcess.ts",
    "vite.config.ts",
    "pnpm-lock.yaml",
    "apps/server/scripts/compute-recipes.ts",
    ".github/workflows/ci.yml",
  ])
    NodeAssert.deepEqual(computeQualificationSuites([path]), both, path);
});

NodeTest.test("selection is a union: adding files never removes required coverage", () => {
  const paths = [
    "README.md",
    "apps/server/src/preview/PortScanner.ts",
    "apps/server/src/scient/compute/managed-python/uv.lock",
    "apps/server/src/scient/compute/PythonComputeRuntime.ts",
  ];
  for (const first of paths)
    for (const second of paths) {
      const a = computeQualificationSuites([first]);
      const b = computeQualificationSuites([second]);
      NodeAssert.deepEqual(computeQualificationSuites([first, second]), {
        realKernel: a.realKernel || b.realKernel,
        managedPython: a.managedPython || b.managedPython,
      });
    }
  NodeAssert.deepEqual(computeQualificationSuites([]), neither);
});

NodeTest.test(
  "native inputs, lifecycle dependencies and the gate itself trigger qualification",
  () => {
    for (const path of [
      "apps/server/src/scient/compute/PythonKernel.integration.test.ts",
      "apps/server/src/scient/execution/LocalOwnedProcess.ts",
      "apps/server/src/atomicWrite.ts",
      "apps/server/src/atomicWrite.test.ts",
      "apps/server/src/preview/PortScannerPythonCompute.integration.test.ts",
      "apps/server/src/localEndpoints/OwnedLocalEndpointRegistry.ts",
      "apps/server/scripts/compute-recipes.ts",
      "packages/scient-compute/src/service.ts",
      "packages/contracts/src/scientCompute.ts",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "package.json",
      "apps/server/package.json",
      "apps/server/vite.config.ts",
      ".github/workflows/ci.yml",
      ".github/workflows/scient-compute-python-kernel.yml",
      ".github/scripts/compute-ci-gate.mjs",
      ".github/scripts/compute-ci-gate.test.mjs",
    ])
      NodeAssert.equal(needsComputeQualification([path]), true, path);
  },
);

NodeTest.test("unrelated changes and empty diffs do not schedule native kernels", () => {
  NodeAssert.equal(needsComputeQualification([]), false);
  NodeAssert.equal(needsComputeQualification(["README.md", "apps/web/src/App.tsx"]), false);
});

NodeTest.test("all result combinations reject failures, cancellations and unexpected skips", () => {
  const results = ["success", "failure", "cancelled", "skipped", ""];
  let accepted = 0;
  for (const workspace of results)
    for (const detection of results)
      for (const changed of ["true", "false", ""])
        for (const native of results) {
          const expected =
            workspace === "success" &&
            detection === "success" &&
            ((changed === "true" && native === "success") ||
              (changed === "false" && native === "skipped"));
          NodeAssert.equal(testGatePasses({ workspace, detection, changed, native }), expected);
          if (expected) accepted += 1;
        }
  NodeAssert.equal(accepted, 2);
});

NodeTest.test("detector handles PRs, pushes, deletions/renames and unresolved comparisons", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-ci-gate-"));
  const script = NodeURL.fileURLToPath(new URL("./compute-ci-gate.mjs", import.meta.url));
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const detect = (event, sha) => {
    const eventPath = NodePath.join(directory, "event.json");
    const outputPath = NodePath.join(directory, "output.txt");
    NodeFS.writeFileSync(eventPath, JSON.stringify(event));
    NodeFS.writeFileSync(outputPath, "");
    NodeChildProcess.execFileSync(process.execPath, [script, "detect"], {
      cwd: directory,
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_SHA: sha,
      },
      stdio: "pipe",
    });
    return Object.fromEntries(
      NodeFS.readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  };
  try {
    git("init", "--quiet");
    git("config", "user.name", "CI fixture");
    git("config", "user.email", "fixture@example.invalid");
    NodeFS.mkdirSync(NodePath.join(directory, "apps/server/src"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, "apps/server/src/atomicWrite.ts"), "fixture\n");
    git("add", "apps");
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "baseline");
    const base = git("rev-parse", "HEAD");
    NodeAssert.deepEqual(detect({ before: base }, base), {
      changed: "false",
      real_kernel: "false",
      managed_python: "false",
    });
    NodeFS.renameSync(
      NodePath.join(directory, "apps/server/src/atomicWrite.ts"),
      NodePath.join(directory, "moved.txt"),
    );
    git("add", "apps", "moved.txt");
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "move out of scope");
    const head = git("rev-parse", "HEAD");
    const all = { changed: "true", real_kernel: "true", managed_python: "true" };
    NodeAssert.deepEqual(detect({ pull_request: { base: { sha: base } } }, head), all);
    NodeAssert.deepEqual(detect({ before: base }, head), all);
    NodeAssert.deepEqual(detect({ before: "0".repeat(40) }, head), all);
    NodeAssert.deepEqual(detect({}, head), all);
    // A normal PR and a post-merge push select the same relevant suites.
    NodeFS.mkdirSync(NodePath.join(directory, "apps/server/src/preview"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(directory, "apps/server/src/preview/PortScanner.ts"),
      "fixture\n",
    );
    git("add", "apps");
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "scanner change");
    const scannerHead = git("rev-parse", "HEAD");
    const scanner = { changed: "true", real_kernel: "true", managed_python: "false" };
    NodeAssert.deepEqual(detect({ before: head }, scannerHead), scanner);
    NodeAssert.deepEqual(detect({ pull_request: { base: { sha: head } } }, scannerHead), scanner);
    NodeFS.mkdirSync(NodePath.join(directory, "apps/server/src/scient/compute/managed-python"), {
      recursive: true,
    });
    NodeFS.writeFileSync(
      NodePath.join(directory, "apps/server/src/scient/compute/managed-python/uv.lock"),
      "fixture\n",
    );
    git("add", "apps");
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "managed recipe change");
    const recipeHead = git("rev-parse", "HEAD");
    const recipe = { changed: "true", real_kernel: "false", managed_python: "true" };
    NodeAssert.deepEqual(detect({ before: scannerHead }, recipeHead), recipe);
    NodeAssert.deepEqual(
      detect({ pull_request: { base: { sha: scannerHead } } }, recipeHead),
      recipe,
    );
    // Both changes in the same PR must retain both suites.
    NodeAssert.deepEqual(detect({ pull_request: { base: { sha: head } } }, recipeHead), all);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
