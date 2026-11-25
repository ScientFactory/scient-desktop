import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { resolveComparisonBase } from "./ci-comparison-base.cjs";

// Unit tests run in the ordinary test lanes and no native suite imports them, so
// changing one proves nothing the native suites would add. Integration and live
// tests are the native suites themselves. ComputeRpcServerTests.ts is the RPC
// fixture server.workspace.test.ts registers.
const ordinaryTest = (path) =>
  (/\.test\.tsx?$/.test(path) && !/\.(integration|live)\.test\.tsx?$/.test(path)) ||
  path === "apps/server/src/scient/compute/ComputeRpcServerTests.ts";

export function computeQualificationSuites(paths) {
  // Only narrow inputs whose consumer is known. Shared runtime code (including
  // ManagedPython*.ts imported by PythonComputeRuntime) still selects both.
  const kernelOnly = new Set([
    "apps/server/src/scient/compute/PythonKernel.integration.test.ts",
    "apps/server/src/scient/compute/PythonComputeService.integration.test.ts",
    "apps/server/src/scient/compute/FreshCompute.integration.test.ts",
  ]);
  // The product case runs in the Linux 3.12 leg of the kernel job, which every real-kernel
  // run includes; changing only it needs only that leg.
  const productOnly = "apps/server/src/scient/compute/ComputeProduct.integration.test.ts";
  const managedLock = "apps/server/src/scient/compute/managed-python/uv.lock";
  const managedOnly = new Set([
    "apps/server/src/scient/compute/ManagedPythonProduct.live.test.ts",
    "apps/server/src/scient/compute/ManagedPythonProduct.bench.ts",
    "apps/server/src/scient/compute/ComputeRecipe.live.test.ts",
    "apps/server/src/scient/compute/managed-python/pyproject.toml",
    managedLock,
  ]);
  const exact = new Set([
    ".github/workflows/scient-compute-python-kernel.yml",
    ".github/scripts/match-windows-llvm.sh",
    ".github/scripts/compute-ci-gate.mjs",
    ".github/scripts/compute-ci-gate.test.mjs",
    ".github/scripts/compute-roles.mjs",
    "apps/server/src/atomicWrite.ts",
    "apps/server/scripts/compute-recipes.ts",
    // It can turn tests off on one platform.
    "apps/server/vite.config.ts",
    // The run table's live test runs in real_languages; these are what it exercises.
    "apps/server/src/scient/analysis/RunTableAdapter.ts",
    "apps/server/src/scient/analysis/RunTableAdapter.live.test.ts",
    "apps/server/src/scient/analysis/StanRun.ts",
    "apps/server/src/scient/analysis/batchLogOutput.ts",
    "packages/contracts/src/scient/computeRunTable.ts",
  ]);
  const prefixes = [
    "apps/server/src/scient/compute/",
    "apps/server/src/scient/execution/",
    "apps/server/src/localEndpoints/",
    "packages/scient-compute/",
    "packages/scient-analysis/",
    "packages/contracts/src/scientCompute",
    "packages/scient-execution/",
    "packages/scient-project-init/",
    "packages/scient-provider-runtime/",
    "packages/shared/src/hostProcess",
  ];
  // Linux only: the nightly main run covers all four computers and catches what this misses.
  const broadExact = new Set([
    ".github/workflows/ci.yml",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "apps/server/package.json",
    "vite.config.ts",
    "apps/server/src/config.ts",
    "apps/server/src/serverSettings.ts",
  ]);
  const broadPrefixes = ["apps/server/src/workspace/", "apps/server/src/testUtils/"];
  let realKernel = false;
  let managedPython = false;
  let pythonProduct = false;
  let allPlatforms = false;
  for (const path of paths) {
    if (ordinaryTest(path)) continue;
    if (
      path === productOnly ||
      path === "packages/shared/src/savedDataView.ts" ||
      (path.startsWith("apps/server/src/scient/data/") && !path.endsWith(".scale.live.test.ts"))
    ) {
      pythonProduct = true;
    } else if (kernelOnly.has(path) || path.startsWith("apps/server/src/preview/PortScanner")) {
      realKernel = true;
      allPlatforms = true;
    } else if (managedOnly.has(path)) {
      managedPython = true;
      // The Linux data view tests install their DuckDB version from this lock.
      if (path === managedLock) pythonProduct = true;
      allPlatforms = true;
    } else if (exact.has(path) || prefixes.some((prefix) => path.startsWith(prefix))) {
      realKernel = true;
      managedPython = true;
      allPlatforms = true;
    } else if (broadExact.has(path) || broadPrefixes.some((prefix) => path.startsWith(prefix))) {
      realKernel = true;
      managedPython = true;
    }
  }
  return {
    realKernel,
    managedPython,
    pythonProduct,
    platforms:
      realKernel || managedPython || pythonProduct ? (allPlatforms ? "all" : "linux") : "none",
  };
}

export function needsComputeQualification(paths) {
  const suites = computeQualificationSuites(paths);
  return suites.realKernel || suites.managedPython || suites.pythonProduct;
}

export function testGatePasses({ workspace, detection, changed, native }) {
  return (
    workspace === "success" &&
    detection === "success" &&
    ((changed === "true" && native === "success") || (changed === "false" && native === "skipped"))
  );
}

function detectChanges() {
  try {
    const event = JSON.parse(NodeFS.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const head = process.env.GITHUB_SHA;
    const base = resolveComparisonBase({ event, head });
    if (![base, head].every((sha) => typeof sha === "string" && /^[a-f0-9]{40,64}$/.test(sha)))
      throw new Error("Missing comparison revision");
    // Disabling rename detection includes both the removed and added paths.
    // Local Git avoids the changed-file truncation of hosted diff APIs/filters.
    const paths = NodeChildProcess.execFileSync(
      "git",
      ["diff", "--no-renames", "--name-only", "-z", base, head],
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    ).split("\0");
    return computeQualificationSuites(paths);
  } catch {
    console.warn("Could not establish the changed paths; running Compute qualification.");
    return { realKernel: true, managedPython: true, pythonProduct: true, platforms: "all" };
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "detect") {
    const suites = detectChanges();
    const changed = suites.realKernel || suites.managedPython || suites.pythonProduct;
    NodeFS.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${changed}\nreal_kernel=${suites.realKernel}\nmanaged_python=${suites.managedPython}\npython_product=${suites.pythonProduct}\nplatforms=${suites.platforms}\n`,
    );
    console.log("Compute qualification:", suites);
  } else if (process.argv[2] === "check") {
    const results = {
      workspace: process.env.WORKSPACE_RESULT,
      detection: process.env.DETECTION_RESULT,
      changed: process.env.COMPUTE_CHANGED,
      native: process.env.NATIVE_RESULT,
    };
    console.log(results);
    if (!testGatePasses(results)) process.exitCode = 1;
  } else {
    throw new Error("Expected detect or check");
  }
}
