// Bundles a hermetic Electron fixture, launches it with an isolated profile, and always
// tears down the detached process group and temporary state on completion or interruption.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const workspaceRoot = resolve(desktopDir, "../..");
const tempDir = mkdtempSync(join(tmpdir(), "scient-browser-overlay-lifecycle-"));
const profileDir = join(tempDir, "profile");
mkdirSync(join(profileDir, "session-data"), { recursive: true });
const electronOutputPath = join(tempDir, "browser-overlay-lifecycle.cjs");
const preloadOutputPath = join(tempDir, "browser-overlay-lifecycle.preload.cjs");
const rendererOutputPath = join(tempDir, "browser-overlay-lifecycle.renderer.js");
const fixturePath = join(tempDir, "browser-overlay-lifecycle.html");

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
    rmSync(tempDir, { recursive: true, force: true });
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

const electronCommand = resolveElectronLaunchCommand(["--disable-gpu", electronOutputPath], {
  development: false,
});
const child = spawn(electronCommand.electronPath, electronCommand.args, {
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
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(code);
}

function interrupt(signal, code) {
  if (finished) return;
  requestedExitCode = code;
  process.stderr.write(`Electron browser overlay lifecycle test interrupted by ${signal}.\n`);
  killChildTree();
  setTimeout(() => finish(code), 2_000).unref();
}

process.once("SIGINT", () => interrupt("SIGINT", 130));
process.once("SIGTERM", () => interrupt("SIGTERM", 143));
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
}, 50_000);

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
