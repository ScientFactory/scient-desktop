import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const fatalPatterns = [
  "Cannot find module",
  "MODULE_NOT_FOUND",
  "Refused to execute",
  "Uncaught Error",
  "Uncaught TypeError",
  "Uncaught ReferenceError",
];

/** Launch/no-known-fatal-error smoke, not backend or renderer readiness. */
export function runDesktopSmoke({
  executable,
  args = [],
  env = process.env,
  cwd,
  survivalMs = 8_000,
  shutdownGraceMs = 2_000,
}) {
  if (![survivalMs, shutdownGraceMs].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError("Smoke deadlines must be finite and positive.");
  }
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(executable, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    let output = "";
    let childError;
    let shutdownRequested = false;
    let shutdownSignalSent = false;
    let forcedKill = false;
    let drainageTimedOut = false;
    let exited = false;
    let forceKillTimeout;
    const refuseIncompleteDrainage = () => {
      drainageTimedOut = true;
      child.stdout.destroy();
      child.stderr.destroy();
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      output += chunk.toString();
    });
    child.on("error", (error) => {
      childError = error;
    });
    child.once("exit", () => {
      exited = true;
      if (forceKillTimeout === undefined) {
        clearTimeout(gracefulTimeout);
        forceKillTimeout = setTimeout(refuseIncompleteDrainage, shutdownGraceMs);
      }
    });

    const gracefulTimeout = setTimeout(() => {
      if (exited || child.exitCode !== null || child.signalCode !== null) return;
      shutdownRequested = true;
      shutdownSignalSent = child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        if (!exited) {
          forcedKill = true;
          child.kill("SIGKILL");
          refuseIncompleteDrainage();
        } else {
          // A child may leave inherited pipes open. Refuse success rather than
          // waiting forever or silently discarding undrained fatal output.
          refuseIncompleteDrainage();
        }
      }, shutdownGraceMs);
    }, survivalMs);

    // `exit` can precede the final stdout/stderr data. Only `close` is proof
    // that both captured streams have drained (or were explicitly refused).
    child.once("close", (code, signal) => {
      clearTimeout(gracefulTimeout);
      clearTimeout(forceKillTimeout);
      const failures = fatalPatterns.filter((pattern) => output.includes(pattern));
      const intendedExit = code === 0 || signal === "SIGTERM";
      const passed =
        shutdownRequested &&
        shutdownSignalSent &&
        intendedExit &&
        !forcedKill &&
        !drainageTimedOut &&
        childError === undefined &&
        failures.length === 0;
      resolve({
        passed,
        pid: child.pid,
        code,
        signal,
        shutdownRequested,
        forcedKill,
        drainageTimedOut,
        error: childError?.message,
        failures,
        stdout,
        stderr,
        output,
      });
    });
  });
}

async function main() {
  const desktopDir = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
  );
  const mainJs = NodePath.resolve(desktopDir, "dist-electron/boot.cjs");
  console.log("\nLaunching Electron smoke test...");
  const electronCommand = resolveElectronLaunchCommand([mainJs]);
  const result = await runDesktopSmoke({
    executable: electronCommand.electronPath,
    args: electronCommand.args,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "",
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });
  if (!result.passed) {
    console.error("\nDesktop smoke test failed:");
    if (result.error) console.error(` - Child error: ${result.error}`);
    if (!result.shutdownRequested) console.error(" - Child exited before the smoke deadline.");
    if (result.forcedKill) console.error(" - Child required forced termination.");
    if (result.drainageTimedOut) console.error(" - Child output did not finish draining.");
    console.error(` - Child exit: code=${result.code}, signal=${result.signal}`);
    for (const failure of result.failures) console.error(` - ${failure}`);
    console.error("\nFull output:\n" + result.output);
    process.exitCode = 1;
    return;
  }
  console.log("Desktop smoke test passed.");
}

if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  await main();
}
