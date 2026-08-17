import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const mainJs = NodePath.resolve(desktopDir, "dist-electron/main.cjs");

console.log("\nLaunching Electron smoke test...");

const electronCommand = resolveElectronLaunchCommand([mainJs]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "",
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

let forceKillTimeout;
const gracefulTimeout = setTimeout(() => {
  child.kill("SIGTERM");
  forceKillTimeout = setTimeout(() => {
    child.kill("SIGKILL");
  }, 2_000);
}, 8_000);

child.on("error", (error) => {
  clearTimeout(gracefulTimeout);
  clearTimeout(forceKillTimeout);
  console.error("\nDesktop smoke test failed to launch:\n" + error);
  process.exit(1);
});

child.on("exit", () => {
  clearTimeout(gracefulTimeout);
  clearTimeout(forceKillTimeout);

  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
  ];
  const failures = fatalPatterns.filter((pattern) => output.includes(pattern));

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    console.error("\nFull output:\n" + output);
    process.exit(1);
  }

  console.log("Desktop smoke test passed.");
  process.exit(0);
});
