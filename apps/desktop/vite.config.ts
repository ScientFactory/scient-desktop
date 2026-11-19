import "vite-plus/test/config";
import * as NodeOS from "node:os";

import { defaultExclude, defaultInclude, defineConfig } from "vite-plus";

import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import { isDesktopRuntimeExternalDependency } from "../../scripts/lib/desktop-external-packages.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

const repoEnv = loadRepoEnv();
const domTests = ["src/preview/PickPreload.test.ts"];

// Install only bundle externals; the server bundle already carries its dependency tree.
const isMainProcessExternal = (id: string) =>
  id === "electron" || id.startsWith("electron/") || isDesktopRuntimeExternalDependency(id);
const shouldLaunchElectronAfterPack = process.env.T3CODE_DESKTOP_DEV === "1";
// tsdown runs onSuccess through a shell. dash forks instead of exec'ing the last command, which
// would leave an `sh` between `vp pack` and the supervisor and hide `vp pack` dying from it.
const devElectronCommand =
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Build config has no Effect runtime.
  NodeOS.platform() === "win32"
    ? "node scripts/dev-electron.mjs"
    : "exec node scripts/dev-electron.mjs";
const publicConfigDefine = {
  __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
    SCIENT_DESKTOP_IDENTITY.cloudEnabled
      ? (repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "")
      : "",
  ),
};
const preloadTests = [
  "src/scient/spelling/preloadSampler.test.ts",
  // SCIENT-FORK:START — Scient Accounts: exercise login forms in the guest preload environment.
  "src/scient/accounts/loginForm.test.ts",
  // SCIENT-FORK:END
];

export default defineConfig({
  run: {
    tasks: {
      build: {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-preview-annotation-css.mjs && vp pack",
        dependsOn: ["t3#build"],
        cache: false,
      },
      // CI bundle jobs skip the Linux browser secret helper; packaging stages one per arch.
      "build:bundle": {
        command: "node scripts/build-preview-annotation-css.mjs && vp pack",
        dependsOn: ["t3#build"],
        cache: false,
      },
      dev: {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-preview-annotation-css.mjs && cross-env T3CODE_DESKTOP_DEV=1 vp pack --watch",
        // SCIENT-FORK:START — see t3#build:dev in apps/server/vite.config.ts.
        dependsOn: ["t3#build:dev"],
        // SCIENT-FORK:END
        cache: false,
      },
      "dev:bundle": {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-preview-annotation-css.mjs && vp pack --watch",
        cache: false,
      },
      "dev:electron": {
        command: "node scripts/dev-electron.mjs",
        // SCIENT-FORK:START — see t3#build:dev in apps/server/vite.config.ts.
        dependsOn: ["t3#build:dev"],
        // SCIENT-FORK:END
        cache: false,
      },
      // A local tsbuildinfo is leftover build state, not a typecheck input.
      typecheck: {
        command: "effect-tsgo tsrs --noEmit",
        cache: { input: [{ auto: true }, "!*.tsbuildinfo"] },
      },
    },
  },
  pack: [
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      outputOptions: { codeSplitting: false },
      entry: ["src/main.ts"],
      clean: true,
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:") && !isMainProcessExternal(id),
        neverBundle: isMainProcessExternal,
        onlyBundle: false,
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: devElectronCommand } : {}),
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: [
        "src/electron/WindowsForegroundFocusWorker.ts",
        "src/snapShot/GlobalShiftShortcutWorker.ts",
        "src/snapShot/RegionSnapShotWorker.ts",
        "src/snapShot/SnapShotAccessibilityWorker.ts",
      ],
      clean: false,
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:") && !isMainProcessExternal(id),
        neverBundle: isMainProcessExternal,
        onlyBundle: false,
      },
    },
    {
      // boot.cjs requires the other two at runtime, so all three stay separate files.
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/boot.ts", "src/compileCache.ts", "src/serverCompileCache.ts"],
      clean: false,
      deps: {
        neverBundle: (id) => id === "./main.cjs" || id === "./compileCache.cjs",
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: ["src/preload.ts"],
      deps: {
        // Sandboxed preloads cannot resolve imports inside ASAR; bundle Clerk's bridge.
        alwaysBundle: (id) => id === "@clerk/electron" || id.startsWith("@clerk/electron/"),
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pick-preload.ts"],
      deps: {
        // SCIENT-FORK:START — A sandboxed preload can only require electron, so nothing else may stay external.
        alwaysBundle: (id) => id !== "electron" && !id.startsWith("electron/"),
        // SCIENT-FORK:END
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pip-preload.ts"],
    },
    {
      // Sandboxed preloads must be self-contained, without shared runtime chunks.
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/mac-permission-preload.ts"],
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/conversation-review-preload.ts"],
      clean: false,
    },
  ],
  test: {
    // The Windows lane runs workspace suites concurrently; filesystem-heavy
    // desktop integration tests can exceed Vitest's 5 second default there.
    testTimeout: 15_000,
    // `require("electron")` downloads a missing binary, so concurrent workers race to
    // extract it into the same dist/. Install it once before any worker starts.
    globalSetup: ["./scripts/ensure-electron-runtime.mjs"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [...defaultInclude, "../../native/kde-snap-shot/src/*.test.ts"],
          // SCIENT-FORK: Scient's preload sampler tests run in their own project.
          exclude: [...defaultExclude, ...domTests, ...preloadTests],
          setupFiles: [
            "../../packages/shared/src/testing/longTempDir.ts",
            "../../packages/shared/src/testing/providerEnv.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          include: domTests,
          // Guest preloads run in the page; these tests drive them against a DOM.
          environment: "jsdom",
          setupFiles: ["../../packages/shared/src/testing/providerEnv.ts"],
        },
      },
      // SCIENT-FORK:START — the sampler runs inside Electron's isolated preload, not the web renderer.
      {
        extends: true,
        test: {
          name: "preload",
          include: preloadTests,
          environment: "happy-dom",
          setupFiles: [
            "../../packages/shared/src/testing/longTempDir.ts",
            "../../packages/shared/src/testing/providerEnv.ts",
          ],
        },
      },
      // SCIENT-FORK:END
    ],
  },
});
