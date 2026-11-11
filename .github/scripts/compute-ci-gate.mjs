import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

// Unit tests run in the ordinary test lanes and no native suite imports them, so
// changing one proves nothing the native suites would add. Integration and live
// tests are the native suites themselves. ComputeRpcServerTests.ts is the RPC
// fixture server.test.ts registers.
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
  const managedOnly = new Set([
    "apps/server/src/scient/compute/ManagedPythonProduct.live.test.ts",
    "apps/server/src/scient/compute/ManagedPythonProduct.bench.ts",
    "apps/server/src/scient/compute/ComputeRecipe.live.test.ts",
    "apps/server/src/scient/compute/managed-python/pyproject.toml",
    "apps/server/src/scient/compute/managed-python/uv.lock",
  ]);
  const exact = new Set([
    ".github/workflows/scient-compute-python-kernel.yml",
    ".github/scripts/compute-ci-gate.mjs",
    ".github/scripts/compute-ci-gate.test.mjs",
    "apps/server/src/atomicWrite.ts",
    "apps/server/scripts/compute-recipes.ts",
    // It can turn tests off on one platform.
    "apps/server/vite.config.ts",
  ]);
  const prefixes = [
    "apps/server/src/scient/compute/",
    "apps/server/src/scient/execution/",
    "apps/server/src/localEndpoints/",
    "packages/scient-compute/",
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
  let allPlatforms = false;
  for (const path of paths) {
    if (ordinaryTest(path)) continue;
    if (kernelOnly.has(path) || path.startsWith("apps/server/src/preview/PortScanner")) {
      realKernel = true;
      allPlatforms = true;
    } else if (managedOnly.has(path)) {
      managedPython = true;
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
    platforms: realKernel || managedPython ? (allPlatforms ? "all" : "linux") : "none",
  };
}

export function needsComputeQualification(paths) {
  const suites = computeQualificationSuites(paths);
  return suites.realKernel || suites.managedPython;
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
    const base = event.pull_request?.base.sha ?? event.merge_group?.base_sha ?? event.before;
    const head = process.env.GITHUB_SHA;
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
    return { realKernel: true, managedPython: true, platforms: "all" };
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "detect") {
    const suites = detectChanges();
    const changed = suites.realKernel || suites.managedPython;
    NodeFS.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${changed}\nreal_kernel=${suites.realKernel}\nmanaged_python=${suites.managedPython}\nplatforms=${suites.platforms}\n`,
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
