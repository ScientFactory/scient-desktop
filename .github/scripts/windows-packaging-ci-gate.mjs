import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { testGatePasses } from "./compute-ci-gate.mjs";

export function needsWindowsPackaging(paths) {
  const exact = new Set([
    ".github/workflows/ci.yml",
    ".github/workflows/windows-packaging.yml",
    ".github/workflows/release.yml",
    ".github/scripts/windows-packaging-ci-gate.mjs",
    ".github/scripts/windows-packaging-ci-gate.test.mjs",
    "package.json",
    ".npmrc",
    ".node-version",
    ".nvmrc",
    "t3.json",
    "tsconfig.base.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "vite.config.ts",
  ]);
  const prefixes = [
    "scripts/",
    "apps/desktop/",
    "apps/server/",
    "apps/web/",
    "packages/",
    "native/",
    "patches/",
  ];
  return paths.some(
    (path) => exact.has(path) || prefixes.some((prefix) => path.startsWith(prefix)),
  );
}

function detectChanges() {
  try {
    const event = JSON.parse(NodeFS.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const base = event.pull_request?.base.sha ?? event.merge_group?.base_sha ?? event.before;
    const head = process.env.GITHUB_SHA;
    if (![base, head].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)))
      throw new Error("Missing immutable diff bounds");
    // No rename detection: moving a runtime file out of its directory must
    // include its old path, just like deleting it.
    const paths = NodeChildProcess.execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", base, head, "--"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    )
      .split("\0")
      .filter(Boolean);
    return needsWindowsPackaging(paths);
  } catch {
    console.warn("Could not establish the changed paths; running Windows packaging qualification.");
    return true;
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "detect") {
    const changed = detectChanges();
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
    console.log("Windows packaging required:", changed);
  } else if (process.argv[2] === "check") {
    const results = {
      workspace: process.env.WORKSPACE_RESULT,
      detection: process.env.WINDOWS_DETECTION_RESULT,
      changed: process.env.WINDOWS_CHANGED,
      native: process.env.WINDOWS_NATIVE_RESULT,
    };
    console.log("Windows packaging gate:", results);
    if (!testGatePasses(results)) process.exitCode = 1;
  } else throw new Error("Expected detect or check");
}
