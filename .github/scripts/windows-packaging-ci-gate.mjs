import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { testGatePasses } from "./compute-ci-gate.mjs";

export function needsWindowsPackaging(paths) {
  const exact = new Set([
    ".github/workflows/ci.yml",
    ".github/workflows/windows-packaging.yml",
    ".github/workflows/remote-server-packaging.yml",
    ".github/workflows/linux-packaging.yml",
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

/** Linux assembly/native changes need an AppImage; ordinary renderer edits do not. */
export function needsLinuxPackaging(paths) {
  const exact = new Set([
    ".github/scripts/linux-packaging-probe.test.mjs",
    ".github/workflows/ci.yml",
    ".github/workflows/linux-packaging.yml",
    ".github/workflows/release.yml",
    ".github/scripts/windows-packaging-ci-gate.mjs",
    ".github/scripts/windows-packaging-ci-gate.test.mjs",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".node-version",
    ".nvmrc",
    "vite.config.ts",
    "t3.json",
    "tsconfig.base.json",
  ]);
  const prefixes = [
    "apps/desktop/",
    "native/",
    "patches/",
    "scripts/build-desktop-artifact",
    "scripts/stage-",
    "scripts/lib/",
    "scripts/qualify-linux-",
    "scripts/measure-linux-",
  ];
  return paths.some(
    (path) =>
      exact.has(path) ||
      path.endsWith("/package.json") ||
      prefixes.some((prefix) => path.startsWith(prefix)),
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
    return { changed: needsWindowsPackaging(paths), linux_changed: needsLinuxPackaging(paths) };
  } catch {
    console.warn("Could not establish the changed paths; running desktop packaging qualification.");
    return { changed: true, linux_changed: true };
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "detect") {
    const result = detectChanges();
    NodeFS.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${result.changed}\nlinux_changed=${result.linux_changed}\n`,
    );
    console.log("Desktop packaging required:", result);
  } else if (process.argv[2] === "check") {
    const results = {
      workspace: process.env.WORKSPACE_RESULT,
      detection: process.env.WINDOWS_DETECTION_RESULT,
      changed: process.env.WINDOWS_CHANGED,
      native: process.env.WINDOWS_NATIVE_RESULT,
    };
    console.log("Windows packaging gate:", results);
    const remote = { ...results, native: process.env.REMOTE_SERVER_RESULT };
    console.log("Remote server packaging gate:", remote);
    const linux = {
      ...results,
      changed: process.env.LINUX_CHANGED,
      native: process.env.LINUX_NATIVE_RESULT,
    };
    console.log("Linux packaging gate:", linux);
    if (!testGatePasses(results) || !testGatePasses(remote) || !testGatePasses(linux))
      process.exitCode = 1;
  } else throw new Error("Expected detect or check");
}
