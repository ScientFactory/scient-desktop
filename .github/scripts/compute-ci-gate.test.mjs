import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";
import { needsComputeQualification, testGatePasses } from "./compute-ci-gate.mjs";

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
    return NodeFS.readFileSync(outputPath, "utf8").trim();
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
    NodeAssert.equal(detect({ before: base }, base), "changed=false");
    NodeFS.renameSync(
      NodePath.join(directory, "apps/server/src/atomicWrite.ts"),
      NodePath.join(directory, "moved.txt"),
    );
    git("add", "apps", "moved.txt");
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "move out of scope");
    const head = git("rev-parse", "HEAD");
    NodeAssert.equal(detect({ pull_request: { base: { sha: base } } }, head), "changed=true");
    NodeAssert.equal(detect({ before: base }, head), "changed=true");
    NodeAssert.equal(detect({ before: "0".repeat(40) }, head), "changed=true");
    NodeAssert.equal(detect({}, head), "changed=true");
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
