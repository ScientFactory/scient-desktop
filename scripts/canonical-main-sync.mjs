#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  clearStaleRunner,
  readLocalDevAppMarker,
  resolveLocalDevAppPaths,
  resolveStableDevHome,
  startAppInBackground,
  stopApp,
} from "./local-dev-app.mjs";

export const CANONICAL_SYNC_LABEL = "com.scientfactory.scient-dev-stable-sync";
const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const REMOTE_REF = "refs/remotes/origin/main";
const WAIT_FOR_STOP_MS = 30_000;
const STOP_POLL_MS = 250;

function run(command, args, { cwd = ROOT, env = process.env } = {}) {
  return NodeChildProcess.spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function git(args, options = {}) {
  return run("git", args, options);
}

function gitText(args, options = {}) {
  const result = git(args, options);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed${output(result) ? `: ${output(result)}` : ""}`);
  }
  return result.stdout.trim();
}

function appendLog(logPath, message) {
  NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true });
  NodeFS.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

function acquireLock(lockPath) {
  NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true });
  try {
    const fd = NodeFS.openSync(lockPath, "wx");
    NodeFS.writeFileSync(
      fd,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    return fd;
  } catch (error) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }
}

function releaseLock(lockPath, fd) {
  try {
    NodeFS.closeSync(fd);
  } finally {
    NodeFS.rmSync(lockPath, { force: true });
  }
}

function stablePaths(root = ROOT) {
  return resolveLocalDevAppPaths({ root, role: "stable" });
}

export function inspectEligibility({ root = ROOT } = {}) {
  const branch = gitText(["branch", "--show-current"], { cwd: root });
  const dirty = gitText(["status", "--porcelain", "--untracked-files=normal"], { cwd: root });
  const paths = stablePaths(root);
  const marker = readLocalDevAppMarker(paths);
  return {
    branch,
    dirty,
    paths,
    marker,
    eligible: branch === "main" && dirty.length === 0 && marker?.repoRoot === root,
  };
}

async function waitForRunnerToStop(paths, log) {
  const deadline = Date.now() + WAIT_FOR_STOP_MS;
  while (Date.now() < deadline) {
    const state = clearStaleRunner(paths);
    if (!state) return true;
    if (state.starting) {
      log("stable runner is still starting; refusing to race it");
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
  log("stable runner did not stop within 30 seconds; update paused");
  return false;
}

async function startStableApp(paths, log) {
  await startAppInBackground({ paths, writeLine: log });
}

export async function syncOnce({ root = ROOT, log = console.log } = {}) {
  const paths = stablePaths(root);
  const logToFile = (message) => {
    appendLog(NodePath.join(paths.stateRoot, "canonical-main-sync.log"), message);
    log(message);
  };
  const lockPath = NodePath.join(paths.stateRoot, "canonical-main-sync.lock");
  const lockFd = acquireLock(lockPath);
  if (lockFd === null) {
    logToFile("another canonical sync is already running; skipped");
    return { status: "locked" };
  }

  try {
    const eligibility = inspectEligibility({ root });
    if (eligibility.branch !== "main") {
      logToFile(
        `paused: canonical checkout is on ${eligibility.branch || "detached HEAD"}, not main`,
      );
      return { status: "paused", reason: "branch" };
    }
    if (eligibility.dirty.length > 0) {
      logToFile("paused: canonical checkout has local changes");
      return { status: "paused", reason: "dirty" };
    }
    if (!eligibility.marker) {
      logToFile("paused: Scient (Dev) Stable is not installed for this checkout");
      return { status: "paused", reason: "launcher" };
    }

    const fetchResult = git(["fetch", "--no-tags", "origin", `refs/heads/main:${REMOTE_REF}`], {
      cwd: root,
    });
    if (fetchResult.status !== 0) {
      logToFile(`fetch failed: ${output(fetchResult) || "unknown error"}`);
      return { status: "error", reason: "fetch" };
    }

    const head = gitText(["rev-parse", "HEAD"], { cwd: root });
    const remoteHead = gitText(["rev-parse", REMOTE_REF], { cwd: root });
    if (head === remoteHead) {
      logToFile(`up to date at ${head.slice(0, 12)}`);
      return { status: "unchanged", head };
    }

    const ancestry = git(["merge-base", "--is-ancestor", head, remoteHead], { cwd: root });
    if (ancestry.status !== 0) {
      logToFile(
        `paused: origin/main diverged from ${head.slice(0, 12)}; manual integration required`,
      );
      return { status: "paused", reason: "diverged" };
    }

    const changedPaths = gitText(["diff", "--name-only", head, remoteHead], { cwd: root })
      .split(/\r?\n/)
      .filter(Boolean);
    const lockfileChanged = changedPaths.includes("pnpm-lock.yaml");
    const launcherChanged = changedPaths.some(
      (path) =>
        path === "scripts/local-dev-app.mjs" ||
        path === "apps/desktop/scripts/electron-launcher.mjs" ||
        path === "apps/desktop/package.json" ||
        path.startsWith("assets/dev/") ||
        path.startsWith("apps/desktop/resources/"),
    );
    const runnerState = clearStaleRunner(paths);
    if (runnerState?.starting) {
      logToFile("paused: stable runner is still starting");
      return { status: "paused", reason: "starting" };
    }
    if (runnerState) {
      await stopApp({ paths, writeLine: (message) => logToFile(message) });
      if (!(await waitForRunnerToStop(paths, logToFile))) {
        return { status: "paused", reason: "stop-timeout" };
      }
    }

    const mergeResult = git(["merge", "--ff-only", remoteHead], { cwd: root });
    if (mergeResult.status !== 0) {
      logToFile(`fast-forward failed: ${output(mergeResult) || "unknown error"}`);
      return { status: "error", reason: "merge" };
    }
    logToFile(`fast-forwarded ${head.slice(0, 12)} -> ${remoteHead.slice(0, 12)}`);

    if (lockfileChanged) {
      const installResult = run("pnpm", ["install", "--frozen-lockfile"], {
        cwd: root,
        env: { ...process.env, SCIENT_DEV_APP_ROLE: "stable", SCIENT_NEXT_HOME: paths.stateRoot },
      });
      if (installResult.status !== 0) {
        logToFile(`dependency install failed: ${output(installResult) || "unknown error"}`);
        return { status: "error", reason: "dependencies", from: head, to: remoteHead };
      }
      logToFile("locked dependencies installed");
    }

    if (launcherChanged) {
      const reinstallResult = run(
        process.execPath,
        [NodePath.join(root, "scripts", "local-dev-app.mjs"), "install", "--stable", "--replace"],
        {
          cwd: root,
          env: { ...process.env, SCIENT_DEV_APP_ROLE: "stable", SCIENT_NEXT_HOME: paths.stateRoot },
        },
      );
      if (reinstallResult.status !== 0) {
        logToFile(`stable launcher refresh failed: ${output(reinstallResult) || "unknown error"}`);
        return { status: "error", reason: "launcher", from: head, to: remoteHead };
      }
      logToFile("stable launcher refreshed");
    }

    await startStableApp(paths, logToFile);
    return { status: "updated", from: head, to: remoteHead };
  } catch (error) {
    logToFile(`sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "error", reason: "exception" };
  } finally {
    releaseLock(lockPath, lockFd);
  }
}

function plistXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function makeLaunchAgentPlist({ root = ROOT, nodePath = process.execPath } = {}) {
  const scriptPath = NodePath.join(root, "scripts", "canonical-main-sync.mjs");
  const stableHome = resolveStableDevHome();
  const pathValue = `${NodePath.dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${CANONICAL_SYNC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${plistXml(nodePath)}</string>
    <string>${plistXml(scriptPath)}</string>
    <string>--once</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${plistXml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${plistXml(pathValue)}</string>
    <key>SCIENT_DEV_APP_ROLE</key>
    <string>stable</string>
    <key>SCIENT_NEXT_HOME</key>
    <string>${plistXml(stableHome)}</string>
  </dict>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${plistXml(NodePath.join(stableHome, "canonical-main-sync.launchd.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${plistXml(NodePath.join(stableHome, "canonical-main-sync.launchd.error.log"))}</string>
</dict>
</plist>
`;
}

function launchAgentPath() {
  return NodePath.join(
    NodeOS.homedir(),
    "Library",
    "LaunchAgents",
    `${CANONICAL_SYNC_LABEL}.plist`,
  );
}

function currentUserGuiDomain() {
  return `gui/${process.getuid?.() ?? 0}`;
}

export function installLaunchAgent({ root = ROOT } = {}) {
  const eligibility = inspectEligibility({ root });
  if (!eligibility.eligible) {
    throw new Error(
      "Refusing to install the stable watcher until this checkout is clean main and owns Scient (Dev) Stable.",
    );
  }
  const plistPath = launchAgentPath();
  NodeFS.mkdirSync(NodePath.dirname(plistPath), { recursive: true });
  NodeFS.writeFileSync(plistPath, makeLaunchAgentPlist({ root }));
  run("launchctl", ["bootout", currentUserGuiDomain(), plistPath]);
  const result = run("launchctl", ["bootstrap", currentUserGuiDomain(), plistPath]);
  if (result.status !== 0) {
    throw new Error(`launchctl bootstrap failed: ${output(result) || "unknown error"}`);
  }
  return plistPath;
}

export function uninstallLaunchAgent() {
  const plistPath = launchAgentPath();
  run("launchctl", ["bootout", currentUserGuiDomain(), plistPath]);
  NodeFS.rmSync(plistPath, { force: true });
  return plistPath;
}

async function main() {
  if (Number.parseInt(process.versions.node.split(".")[0] ?? "", 10) !== 24) {
    throw new Error(`Scient development requires Node 24; received ${process.version}.`);
  }
  const flags = new Set(process.argv.slice(2));
  if (flags.has("--install")) {
    console.log(`Installed ${installLaunchAgent()}`);
    return;
  }
  if (flags.has("--uninstall")) {
    console.log(`Removed ${uninstallLaunchAgent()}`);
    return;
  }
  await syncOnce();
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
