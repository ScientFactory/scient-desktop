// Bundles a hermetic Electron fixture, launches it with an isolated profile, and always
// tears down the detached process group and temporary state on completion or interruption.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { resolveElectronPackagePath, resolveLinuxSandboxArgs } from "./electron-launcher.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const workspaceRoot = resolve(desktopDir, "../..");
const tempDir = mkdtempSync(join(tmpdir(), "scient-browser-overlay-lifecycle-"));
let child = null;

function cleanupTempDir() {
  rmSync(tempDir, { recursive: true, force: true });
}

// Register cleanup before any other setup can fail after creating the directory.
process.once("exit", cleanupTempDir);

const profileDir = join(tempDir, "profile");
mkdirSync(join(profileDir, "session-data"), { recursive: true });
// Allow both bounded 10s fixture startup waits, the required >30s overlay hold,
// Electron launch/load time, and cleanup without making a cold run race its watchdog.
const PROCESS_TIMEOUT_MS = 90_000;
const electronOutputPath = join(tempDir, "browser-overlay-lifecycle.cjs");
const preloadOutputPath = join(tempDir, "browser-overlay-lifecycle.preload.cjs");
const rendererOutputPath = join(tempDir, "browser-overlay-lifecycle.renderer.js");
const fixturePath = join(tempDir, "browser-overlay-lifecycle.html");
const macTestBundleId = `com.scientfactory.scient.browser-overlay-test.${process.pid}`;
const macSavedStatePaths = [
  join(tmpdir(), `${macTestBundleId}.savedState`),
  join(homedir(), "Library", "Saved Application State", `${macTestBundleId}.savedState`),
];

function cleanupTemporaryState() {
  cleanupTempDir();
  if (process.platform === "darwin") {
    for (const savedStatePath of macSavedStatePaths) {
      rmSync(savedStatePath, { recursive: true, force: true });
    }
  }
}

// Keep setup failures hermetic too: package resolution, sandbox validation, fixture
// generation, and process spawning can all fail before the child handlers are installed.
process.removeListener("exit", cleanupTempDir);
process.once("exit", cleanupTemporaryState);

function interruptSetup(signal, code) {
  process.stderr.write(`Electron browser overlay lifecycle test interrupted by ${signal}.\n`);
  killChildTree();
  cleanupTemporaryState();
  process.exit(code);
}

let handleInterrupt = interruptSetup;
process.once("SIGINT", () => handleInterrupt("SIGINT", 130));
process.once("SIGTERM", () => handleInterrupt("SIGTERM", 143));

function createMacTestElectronExecutable(originalExecutablePath) {
  const originalAppPath = dirname(dirname(dirname(originalExecutablePath)));
  const testAppPath = join(tempDir, "ScientBrowserOverlayTest.app");
  const testContentsPath = join(testAppPath, "Contents");
  const clone = spawnSync("cp", ["-cR", originalAppPath, testAppPath], { encoding: "utf8" });
  if (clone.status !== 0) {
    throw new Error(
      `Could not clone the Electron test app: ${clone.stderr || clone.stdout || "unknown error"}`,
    );
  }

  const originalInfoPath = join(originalAppPath, "Contents", "Info.plist");
  const originalInfo = readFileSync(originalInfoPath, "utf8");
  const info = originalInfo.replace(
    /(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]+(<\/string>)/,
    `$1${macTestBundleId}$2`,
  );
  if (info === originalInfo) {
    throw new Error("Could not isolate the Electron test app bundle identifier.");
  }
  writeFileSync(join(testContentsPath, "Info.plist"), info, "utf8");
  return join(testContentsPath, "MacOS", "Electron");
}

const builds = [
  {
    entry: join(scriptDir, "browser-overlay-lifecycle.electron.ts"),
    output: electronOutputPath,
    args: ["--target=node", "--format=cjs", "--external=electron"],
  },
  {
    entry: join(scriptDir, "browser-overlay-lifecycle.preload.ts"),
    output: preloadOutputPath,
    args: ["--target=node", "--format=cjs", "--external=electron"],
  },
  {
    entry: join(scriptDir, "browser-overlay-lifecycle.renderer.ts"),
    output: rendererOutputPath,
    args: ["--target=browser", "--format=iife"],
  },
];

for (const build of builds) {
  const result = spawnSync(
    process.execPath,
    ["build", build.entry, ...build.args, `--outfile=${build.output}`],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
}

writeFileSync(
  fixturePath,
  `<!doctype html>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; }
    #browser-host { position: fixed; left: 20px; top: 30px; width: 640px; height: 480px; }
    webview { display: flex; width: 100%; height: 100%; }
    #test-overlay { position: fixed; inset: 0; z-index: 10; background: rgba(0, 0, 0, 0.1); }
  </style>
  <div id="browser-host">
    <webview id="browser" src="about:blank" partition="persist:scient-browser"></webview>
  </div>
  <script src="${pathToFileURL(rendererOutputPath).href}"></script>`,
  "utf8",
);

const electronPackagePath = resolveElectronPackagePath();
const electronExecutablePath =
  process.platform === "darwin"
    ? createMacTestElectronExecutable(electronPackagePath)
    : electronPackagePath;
const electronArgs = [
  ...resolveLinuxSandboxArgs(electronPackagePath, { development: false }),
  "--disable-gpu",
  electronOutputPath,
  ...(process.platform === "darwin" ? ["-ApplePersistenceIgnoreState", "YES"] : []),
];
child = spawn(electronExecutablePath, electronArgs, {
  cwd: workspaceRoot,
  detached: process.platform !== "win32",
  env: {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
    SCIENT_BROWSER_OVERLAY_TEST_FIXTURE: fixturePath,
    SCIENT_BROWSER_OVERLAY_TEST_PRELOAD: preloadOutputPath,
    SCIENT_BROWSER_OVERLAY_TEST_PROFILE: profileDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
let finished = false;
let requestedExitCode = null;
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
  process.stderr.write(chunk);
});

function killChildTree() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return true;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      process.stderr.write(
        `Could not terminate Electron process tree: ${result.stderr || result.stdout || "taskkill failed"}\n`,
      );
      return false;
    }
    return true;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
    return true;
  } catch {
    const killed = child.kill("SIGKILL");
    if (!killed) {
      process.stderr.write("Could not terminate Electron process tree.\n");
    }
    return killed;
  }
}

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  cleanupTemporaryState();
  process.exit(code);
}

function interrupt(signal, code) {
  if (finished) return;
  requestedExitCode = code;
  process.stderr.write(`Electron browser overlay lifecycle test interrupted by ${signal}.\n`);
  killChildTree();
  // Do not defer filesystem cleanup until child exit: interruption can also
  // occur before child listeners are installed, and the wrapper may be exiting.
  cleanupTemporaryState();
  setTimeout(() => finish(code), 2_000).unref();
}

handleInterrupt = interrupt;
process.once("uncaughtException", (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  interrupt("uncaughtException", 1);
});
process.once("unhandledRejection", (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  interrupt("unhandledRejection", 1);
});

const timeout = setTimeout(() => {
  requestedExitCode = 1;
  process.stderr.write("Electron browser overlay lifecycle test timed out.\n");
  killChildTree();
  setTimeout(() => finish(1), 2_000).unref();
}, PROCESS_TIMEOUT_MS);

child.on("error", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  requestedExitCode = 1;
  killChildTree();
  finish(1);
});

child.on("exit", (code, signal) => {
  if (requestedExitCode !== null) {
    finish(requestedExitCode);
    return;
  }
  if (code === 0 && output.includes('"result":"passed"')) {
    finish(0);
    return;
  }
  process.stderr.write(
    `Electron browser overlay lifecycle test failed (code=${String(code)}, signal=${String(signal)}).\n`,
  );
  finish(code && code > 0 ? code : 1);
});
