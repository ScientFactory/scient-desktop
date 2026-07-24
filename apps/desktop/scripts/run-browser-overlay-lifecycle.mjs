// Bundles the focused TypeScript harness into a temporary directory, then launches it
// in the repository's real Electron runtime. No generated test artifact enters the repo.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const workspaceRoot = resolve(desktopDir, "../..");
const tempDir = mkdtempSync(join(tmpdir(), "scient-browser-overlay-lifecycle-"));
const outputPath = join(tempDir, "browser-overlay-lifecycle.cjs");
const entryPath = join(scriptDir, "browser-overlay-lifecycle.electron.ts");

const build = spawnSync(
  process.execPath,
  [
    "build",
    entryPath,
    "--target=node",
    "--format=cjs",
    "--external=electron",
    `--outfile=${outputPath}`,
  ],
  { cwd: workspaceRoot, encoding: "utf8" },
);
if (build.status !== 0) {
  rmSync(tempDir, { recursive: true, force: true });
  process.stderr.write(build.stdout ?? "");
  process.stderr.write(build.stderr ?? "");
  process.exit(build.status ?? 1);
}

const electronCommand = resolveElectronLaunchCommand(["--disable-gpu", outputPath], {
  development: false,
});
const child = spawn(electronCommand.electronPath, electronCommand.args, {
  cwd: workspaceRoot,
  detached: process.platform !== "win32",
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
  process.stderr.write(chunk);
});

function killChildTree() {
  if (!child.pid) return;
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

const timeout = setTimeout(() => {
  process.stderr.write("Electron browser overlay lifecycle test timed out.\n");
  killChildTree();
}, 50_000);

child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  rmSync(tempDir, { recursive: true, force: true });
  if (code === 0 && output.includes('"result":"passed"')) {
    process.exit(0);
  }
  process.stderr.write(
    `Electron browser overlay lifecycle test failed (code=${String(code)}, signal=${String(signal)}).\n`,
  );
  process.exit(code && code > 0 ? code : 1);
});
