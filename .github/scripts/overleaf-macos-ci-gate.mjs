// SCIENT-FORK:START — the advisory Overleaf macOS job runs on a pull request only when its diff
// can reach what that job tests. Main pushes and the nightly run always run it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { resolveComparisonBase } from "./ci-comparison-base.cjs";

// What only macOS can show: the job's platform files (overleaf-platform-tests.cjs), the code they
// test, the native file-publication helper they build, the Electron sign-in smoke and the
// toolchain. The same files also run on Linux and Windows in required lanes, through their full
// server import graph, so a change that breaks them on every platform still fails there.
const EXACT = new Set([
  ".github/workflows/ci.yml",
  ".github/scripts/overleaf-platform-tests.cjs",
  ".github/scripts/overleaf-macos-ci-gate.mjs",
  ".github/scripts/overleaf-macos-ci-gate.test.mjs",
  ".github/scripts/ci-comparison-base.cjs",
  "apps/desktop/scripts/google-sign-in-smoke.mjs",
  "apps/desktop/scripts/ensure-electron-runtime.mjs",
  "apps/server/src/config.ts",
  "apps/server/src/auth/serverInternalPaths.ts",
  "packages/provider-core/src/server/pathExpansion.ts",
  "scripts/stage-file-exchange.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".node-version",
  ".nvmrc",
  "vite.config.ts",
  "tsconfig.base.json",
]);
const PREFIXES = [
  "apps/server/src/scient/overleaf/",
  "apps/server/src/scient/workspace/",
  "apps/server/src/workspace/",
  "apps/server/src/peer/fixtures/",
  // The server suite's setup files, Git configuration among them (apps/server/vite.config.ts).
  "apps/server/src/testUtils/",
  "native/file-exchange/",
  "apps/desktop/src/scient/browser/",
  "packages/shared/src/",
  "patches/",
];

export function needsMacOverleaf(paths) {
  return paths.some(
    (path) =>
      EXACT.has(path) ||
      PREFIXES.some((prefix) => path.startsWith(prefix)) ||
      /^(?:apps\/(?:server|desktop)|packages\/shared)\/(?:package\.json|vite\.config\.ts|tsconfig\.json)$/.test(
        path,
      ),
  );
}

function detect() {
  try {
    const event = JSON.parse(NodeFS.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const head = process.env.GITHUB_SHA;
    const base = resolveComparisonBase({ event, head });
    if (![base, head].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)))
      throw new Error("Missing immutable diff bounds");
    // No rename detection: a file moved out of these directories counts by its old path too.
    const paths = NodeChildProcess.execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", base, head, "--"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    )
      .split("\0")
      .filter(Boolean);
    return needsMacOverleaf(paths);
  } catch {
    console.warn("Could not establish the changed paths; running Overleaf macOS.");
    return true;
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const changed = detect();
  NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  console.log("Overleaf macOS applies:", changed);
}
// SCIENT-FORK:END
