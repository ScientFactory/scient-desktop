import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import { needsMacOverleaf } from "./overleaf-macos-ci-gate.mjs";

const here = (file) => NodeURL.fileURLToPath(new URL(file, import.meta.url));

NodeTest.test("every macOS platform test file and the sign-in smoke select the job", () => {
  const source = NodeFS.readFileSync(here("./overleaf-platform-tests.cjs"), "utf8");
  const darwin = /darwin: \[([\s\S]*?)\]/.exec(source)?.[1].match(/"[^"]+"/g) ?? [];
  NodeAssert.ok(darwin.length > 10, "the darwin list was read");
  for (const file of darwin) {
    const path = `apps/server/${file.slice(1, -1)}`;
    NodeAssert.equal(needsMacOverleaf([path]), true, path);
  }
  for (const path of [
    "apps/server/src/scient/overleaf/OverleafSync.ts",
    "apps/server/src/scient/workspace/NativeFilePublication.ts",
    "apps/server/src/workspace/WorkspaceFileSystem.ts",
    "packages/shared/src/HostProcess.ts",
    "apps/desktop/scripts/google-sign-in-smoke.mjs",
    "apps/desktop/src/scient/browser/googleSignInRecovery.ts",
    "apps/desktop/scripts/ensure-electron-runtime.mjs",
    "native/file-exchange/publication-posix.c",
    "native/file-exchange/entitlements.mac.plist",
    "scripts/stage-file-exchange.ts",
    "apps/server/src/config.ts",
    "apps/server/src/auth/serverInternalPaths.ts",
    "apps/server/src/testUtils/gitConfig.setup.ts",
    "packages/provider-core/src/server/pathExpansion.ts",
    "apps/server/src/peer/fixtures/localhost.pem",
    "apps/desktop/package.json",
    "apps/server/vite.config.ts",
    "pnpm-lock.yaml",
    ".github/workflows/ci.yml",
    ".github/scripts/overleaf-platform-tests.cjs",
  ])
    NodeAssert.equal(needsMacOverleaf([path]), true, path);
});

NodeTest.test("unrelated renderer, server and documentation edits skip it", () => {
  NodeAssert.equal(
    needsMacOverleaf([
      "apps/web/src/components/ChatView.tsx",
      "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
      "apps/desktop/src/main.ts",
      "docs/operations/release.md",
    ]),
    false,
  );
});

NodeTest.test("a diff it cannot read runs the job", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "overleaf-macos-gate-"));
  try {
    const output = NodePath.join(dir, "output");
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [here("./overleaf-macos-ci-gate.mjs")],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_PATH: NodePath.join(dir, "missing-event.json"),
          GITHUB_OUTPUT: output,
          GITHUB_SHA: "0".repeat(40),
        },
      },
    );
    NodeAssert.equal(result.status, 0, result.stderr);
    NodeAssert.equal(NodeFS.readFileSync(output, "utf8"), "changed=true\n");
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
