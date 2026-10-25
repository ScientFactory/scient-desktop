import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";
import { needsLinuxPackaging, needsWindowsPackaging } from "./windows-packaging-ci-gate.mjs";

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
      ".github/workflows/remote-server-packaging.yml",
      ".github/workflows/linux-packaging.yml",
      ".github/scripts/windows-packaging-ci-gate.test.mjs",
    ])
      NodeAssert.equal(needsWindowsPackaging([path]), true, path);
    NodeAssert.equal(needsWindowsPackaging(["docs/user/agents.md", "README.md"]), false);
  },
);

NodeTest.test(
  "Linux packaging selects assembly, native and dependency changes but skips ordinary renderer/server edits",
  () => {
    for (const path of [
      "scripts/build-desktop-artifact.ts",
      "scripts/stage-whisper-runtime.ts",
      "scripts/lib/scient-synctex-build.ts",
      "scripts/qualify-linux-packaged-runtime.mjs",
      "apps/desktop/src/main.ts",
      "native/kde-snap-shot/src/main.rs",
      "apps/server/package.json",
      "pnpm-lock.yaml",
      ".github/workflows/linux-packaging.yml",
      ".github/workflows/ci.yml",
      ".github/scripts/windows-packaging-ci-gate.mjs",
    ])
      NodeAssert.equal(needsLinuxPackaging([path]), true, path);
    NodeAssert.equal(
      needsLinuxPackaging([
        "apps/web/src/App.tsx",
        "apps/server/src/ws.ts",
        "docs/operations/release.md",
      ]),
      false,
    );
  },
);

NodeTest.test(
  "test-only and docs-only changes skip packaging; runtime inputs still select it",
  () => {
    const testOnly = [
      "apps/server/src/ws.test.ts",
      "apps/web/src/components/ChatView.browser.test.tsx",
      "apps/desktop/src/main.spec.ts",
      "apps/server/src/textGeneration/__tests__/prompt.ts",
      "apps/web/test/browserSetup.ts",
      "apps/server/src/workspace/knownWorkspaces.testkit.ts",
      "apps/server/src/orchestration-v2/testkit/fixtures/shared.ts",
      "packages/effect-omp-rpc/test/fixtures/v18.3.1/live-turn.jsonl",
      "apps/desktop/src/__snapshots__/main.test.ts.snap",
      "apps/web/latexPaging.vitest.config.ts",
      "native/kde-snap-shot/tests/capture.rs",
      "scripts/build-desktop-artifact.test.ts",
      "scripts/lib/scient-synctex-build.test.ts",
    ];
    const docsOnly = [
      "apps/server/README.md",
      "scripts/lib/conversation-preview-build.md",
      "apps/desktop/docs/notes.txt",
      "docs/user/agents.md",
    ];
    for (const paths of [testOnly, docsOnly, [...testOnly, ...docsOnly]]) {
      NodeAssert.equal(needsWindowsPackaging(paths), false, paths.join());
      NodeAssert.equal(needsLinuxPackaging(paths), false, paths.join());
    }
    // Source, packaging config and product Markdown keep selecting packaging,
    // including when mixed with test-only edits.
    for (const path of [
      "apps/server/src/ws.ts",
      "apps/server/vite.config.ts",
      "apps/server/src/testUtils/weightedShardSequencer.ts",
      "apps/server/src/scient/skills/built-ins/latex-authoring/SKILL.md",
      "apps/server/src/provider/pi/NOTICE.md",
      "patches/some-dep@1.0.0.test.patch",
    ])
      NodeAssert.equal(needsWindowsPackaging([...testOnly, ...docsOnly, path]), true, path);
    for (const path of [
      "apps/desktop/src/main.ts",
      "apps/desktop/package.json",
      "scripts/build-desktop-artifact.ts",
      "pnpm-lock.yaml",
    ]) {
      NodeAssert.equal(needsWindowsPackaging([...testOnly, path]), true, path);
      NodeAssert.equal(needsLinuxPackaging([...testOnly, path]), true, path);
    }
    // Test files that packaging jobs execute stay exact inputs.
    NodeAssert.equal(needsLinuxPackaging([".github/scripts/linux-packaging-probe.test.mjs"]), true);
    NodeAssert.equal(
      needsWindowsPackaging([".github/scripts/windows-packaging-ci-gate.test.mjs"]),
      true,
    );
  },
);

NodeTest.test(
  "Linux qualification failure or unknown/skipped execution blocks the required Test gate",
  () => {
    for (const native of ["failure", "cancelled", "skipped", ""]) {
      const result = NodeChildProcess.spawnSync(process.execPath, [script, "check"], {
        env: {
          ...process.env,
          WORKSPACE_RESULT: "success",
          WINDOWS_DETECTION_RESULT: "success",
          WINDOWS_CHANGED: "true",
          WINDOWS_NATIVE_RESULT: "success",
          REMOTE_SERVER_RESULT: "success",
          LINUX_CHANGED: "true",
          LINUX_NATIVE_RESULT: native,
        },
        encoding: "utf8",
      });
      NodeAssert.equal(result.status, 1, native);
    }
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
    NodeAssert.equal(NodeFS.readFileSync(output, "utf8"), "changed=true\nlinux_changed=true\n");
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
          REMOTE_SERVER_RESULT: native,
          LINUX_CHANGED: changed,
          LINUX_NATIVE_RESULT: native,
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
        NodeAssert.equal(
          NodeFS.readFileSync(output, "utf8"),
          "changed=true\nlinux_changed=false\n",
        );
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

NodeTest.test("remote qualification failure blocks otherwise green Windows packaging", () => {
  for (const remote of ["failure", "cancelled", "skipped", ""]) {
    const result = NodeChildProcess.spawnSync(process.execPath, [script, "check"], {
      env: {
        ...process.env,
        WORKSPACE_RESULT: "success",
        WINDOWS_DETECTION_RESULT: "success",
        WINDOWS_CHANGED: "true",
        WINDOWS_NATIVE_RESULT: "success",
        REMOTE_SERVER_RESULT: remote,
        LINUX_CHANGED: "false",
        LINUX_NATIVE_RESULT: "skipped",
      },
      encoding: "utf8",
    });
    NodeAssert.equal(result.status, 1, remote);
  }
});
