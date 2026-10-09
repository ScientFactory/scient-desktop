import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";
import { needsWindowsPackaging } from "./windows-packaging-ci-gate.mjs";

const script = NodeURL.fileURLToPath(new URL("./windows-packaging-ci-gate.mjs", import.meta.url));

NodeTest.test(
  "runtime, dependency, packaging and gate changes require Windows qualification",
  () => {
    for (const path of [
      "apps/server/src/new-provider.ts",
      "apps/desktop/src/main.ts",
      "apps/web/src/App.tsx",
      "packages/shared/src/index.ts",
      "native/resource-monitor/Cargo.toml",
      "scripts/build-desktop-artifact.ts",
      "patches/native.patch",
      "pnpm-lock.yaml",
      ".github/workflows/release.yml",
      ".github/workflows/ci.yml",
      ".github/scripts/windows-packaging-ci-gate.test.mjs",
    ])
      NodeAssert.equal(needsWindowsPackaging([path]), true, path);
    NodeAssert.equal(needsWindowsPackaging(["docs/user/agents.md", "README.md"]), false);
  },
);

NodeTest.test("unknown diff bounds run packaging instead of silently skipping it", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "windows-ci-gate-"));
  try {
    const event = NodePath.join(root, "event.json");
    const output = NodePath.join(root, "output");
    NodeFS.writeFileSync(event, "{}");
    const result = NodeChildProcess.spawnSync(process.execPath, [script, "detect"], {
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
        GITHUB_SHA: "unknown",
      },
      encoding: "utf8",
    });
    NodeAssert.equal(result.status, 0, result.stderr);
    NodeAssert.equal(NodeFS.readFileSync(output, "utf8"), "changed=true\n");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

NodeTest.test(
  "required gate rejects failure, cancellation, unknown detection and unqualified skips",
  () => {
    for (const { changed, detection, native, passes } of [
      { changed: "true", detection: "success", native: "success", passes: true },
      { changed: "false", detection: "success", native: "skipped", passes: true },
      { changed: "true", detection: "success", native: "failure", passes: false },
      { changed: "true", detection: "success", native: "cancelled", passes: false },
      { changed: "true", detection: "success", native: "skipped", passes: false },
      { changed: "", detection: "success", native: "skipped", passes: false },
      { changed: "false", detection: "failure", native: "skipped", passes: false },
    ]) {
      const result = NodeChildProcess.spawnSync(process.execPath, [script, "check"], {
        env: {
          ...process.env,
          WORKSPACE_RESULT: "success",
          WINDOWS_DETECTION_RESULT: detection,
          WINDOWS_CHANGED: changed,
          WINDOWS_NATIVE_RESULT: native,
        },
        encoding: "utf8",
      });
      NodeAssert.equal(
        result.status,
        passes ? 0 : 1,
        JSON.stringify({ changed, detection, native }),
      );
    }
  },
);

NodeTest.test(
  "real Git diff detects deleted or renamed runtime inputs for PRs, pushes and merge groups",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "windows-ci-git-"));
    const git = (...args) =>
      NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    try {
      git("init", "--quiet");
      git("config", "user.name", "Qualification fixture");
      git("config", "user.email", "fixture@example.invalid");
      NodeFS.mkdirSync(NodePath.join(root, "apps/server"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, "apps/server/runtime.txt"), "runtime fixture");
      git("add", ".");
      git("commit", "--quiet", "-m", "fixture base");
      const base = git("rev-parse", "HEAD");
      NodeFS.mkdirSync(NodePath.join(root, "docs"));
      git("mv", "apps/server/runtime.txt", "docs/removed-runtime.txt");
      git("commit", "--quiet", "-m", "move runtime input");
      const head = git("rev-parse", "HEAD");
      for (const [index, payload] of [
        { pull_request: { base: { sha: base } } },
        { before: base },
        { merge_group: { base_sha: base } },
      ].entries()) {
        const event = NodePath.join(root, `event-${index}.json`);
        const output = NodePath.join(root, `output-${index}`);
        NodeFS.writeFileSync(event, JSON.stringify(payload));
        const result = NodeChildProcess.spawnSync(process.execPath, [script, "detect"], {
          cwd: root,
          env: {
            ...process.env,
            GITHUB_EVENT_PATH: event,
            GITHUB_OUTPUT: output,
            GITHUB_SHA: head,
          },
          encoding: "utf8",
        });
        NodeAssert.equal(result.status, 0, result.stderr);
        NodeAssert.equal(NodeFS.readFileSync(output, "utf8"), "changed=true\n");
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
