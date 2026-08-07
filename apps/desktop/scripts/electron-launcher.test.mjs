import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import {
  makeDevelopmentCommandScript,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveDevelopmentAppDisplayName,
  resolveMacLauncherPaths,
} from "./electron-launcher.mjs";

describe("electron development launcher", () => {
  it("gives the canonical launcher a distinct stable display name", () => {
    assert.equal(resolveDevelopmentAppDisplayName({}), "Scient (Dev)");
    assert.equal(
      resolveDevelopmentAppDisplayName({ SCIENT_DEV_APP_ROLE: "stable" }),
      "Scient (Dev) Stable",
    );
  });

  it("uses captured values only as fallbacks for a live runner environment", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
        T3CODE_PORT: "16566",
        T3CODE_HOME: "/tmp/t3",
      },
    });

    assert.include(
      script,
      "if [ -z \"${VITE_DEV_SERVER_URL:-}\" ]; then export VITE_DEV_SERVER_URL='http://127.0.0.1:8526'; fi",
    );
    assert.notInclude(script, "\nexport VITE_DEV_SERVER_URL=");
    assert.include(script, 'if [ "${SCIENT_NEXT_DEV_RUNNER_ACTIVE:-}" != "1" ]; then');
    assert.notInclude(script, "osascript");
    assert.notInclude(script, "open -a Terminal");
    assert.include(script, "run-scient-next-dev.command");
    assert.include(
      script,
      "exec '/repo/node_modules/electron/Electron' --t3code-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("pins the clickable launcher to its checkout and installation runtime", () => {
    const script = makeDevelopmentCommandScript({
      desktopRoot: "/repo/apps/desktop",
      environment: {
        npm_execpath: "/tool/pnpm.cjs",
        SCIENT_DEV_APP_ROLE: "stable",
        SCIENT_NEXT_HOME: "/tmp/scient-dev-stable",
      },
    });

    assert.include(script, "cd '/repo'");
    assert.include(script, process.execPath);
    assert.include(script, `export PATH='${NodePath.dirname(process.execPath)}':"$PATH"`);
    assert.include(script, "/tool/pnpm.cjs");
    assert.include(script, "export SCIENT_DEV_APP_ROLE='stable'");
    assert.include(script, "dev:app");
    assert.include(script, "export SCIENT_NEXT_HOME='/tmp/scient-dev-stable'");
    assert.include(script, "/tmp/scient-dev-stable/local-dev-app.log");
    assert.include(script, "2>&1");
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/Scient (Dev).app",
      "Scient (Dev)",
    );

    assert.equal(paths.launcherExecutableName, "Scient (Dev) Launcher");
    assert.equal(
      paths.launcherBinaryPath,
      "/repo/apps/desktop/.electron-runtime/Scient (Dev).app/Contents/MacOS/Scient (Dev) Launcher",
    );
    assert.equal(
      paths.runtimeElectronBinaryPath,
      "/repo/apps/desktop/.electron-runtime/Scient (Dev).app/Contents/MacOS/Electron",
    );

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: paths.runtimeElectronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {},
    });
    assert.include(
      script,
      "exec '/repo/apps/desktop/.electron-runtime/Scient (Dev).app/Contents/MacOS/Electron'",
    );
    assert.notInclude(script, "node_modules/electron");
  });
});
