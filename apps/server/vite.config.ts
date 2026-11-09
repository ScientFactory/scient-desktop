import "vite-plus/test/config";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- tsdown needs the asset path when it reads this config.
import * as NodePath from "node:path";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import rootPackageJson from "../../package.json" with { type: "json" };
import packageJson from "./package.json" with { type: "json" };
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import { WeightedShardSequencer } from "./src/testUtils/weightedShardSequencer.ts";
// WSL's plain Node cannot read inside asar; external packages must exist on disk.
// Bundle everything except cli-external-packages exemptions to bound installer file count.
import {
  isExternalCliDependency,
  shouldBundleCliDependency,
} from "../../scripts/lib/cli-external-packages.ts";
import { CLI_BUNDLE_ALIASES } from "../../scripts/lib/cli-bundle-aliases.ts";

export { shouldBundleCliDependency };

const repoEnv = loadRepoEnv();
const cliBuildChannel = packageJson.version.includes("-beta.")
  ? "beta"
  : /^[^-+]+-(?:nightly|preview)\./.test(packageJson.version)
    ? "nightly"
    : "latest";

// tsdown SEA needs one chunk (sourcemaps count) and Node >=25.7, so package separately.
// "bundle" emits the embedded CLI. "1" builds dist-exe/t3 from the bootstrap.
// TEMPORARY one-time Node fix. Remove when fixed: https://github.com/nodejs/node/issues/67048
// "bootstrap" stops at bin.mjs for scripts/cli.ts to inject (linux-arm64).
const packMode = process.env.T3CODE_PACK_EXE;
const packBootstrap = packMode === "1" || packMode === "bootstrap";
const packExecutable = packBootstrap || packMode === "bundle";
const cliAssetDir = process.env.T3CODE_CLI_ASSET_DIR ?? "";
if (packExecutable && !cliAssetDir) throw new Error("Build the executable with build:exe.");
// TEMPORARY one-time Node fix. Remove when fixed: https://github.com/nodejs/node/issues/67048
// No linux-arm64: --build-sea output cannot load on 16/64 KiB page kernels, so it builds natively.
const SEA_TARGETS = {
  "darwin-arm64": { platform: "darwin", arch: "arm64" },
  "darwin-x64": { platform: "darwin", arch: "x64" },
  "linux-x64": { platform: "linux", arch: "x64" },
  "win-arm64": { platform: "win", arch: "arm64" },
  "win-x64": { platform: "win", arch: "x64" },
} as const;
const packExecutableTarget = process.env.T3CODE_PACK_EXE_TARGET?.trim();
const cliNodeVersion = rootPackageJson.engines.node;
if (packExecutable && !packExecutableTarget && process.versions.node !== cliNodeVersion) {
  throw new Error(
    `Native CLI executables must be built with Node ${cliNodeVersion}; running ${process.versions.node}.`,
  );
}
if (packExecutableTarget && !Object.hasOwn(SEA_TARGETS, packExecutableTarget)) {
  throw new Error(
    `T3CODE_PACK_EXE_TARGET must be one of ${Object.keys(SEA_TARGETS).join(", ")}, got "${packExecutableTarget}".`,
  );
}
const packExecutableTargets = packExecutableTarget
  ? [
      {
        ...SEA_TARGETS[packExecutableTarget as keyof typeof SEA_TARGETS],
        nodeVersion: cliNodeVersion,
      },
    ]
  : undefined;

// The root config's `projects` route repo-root runs to package configs,
// including this one. Inheriting them would make this config a container.
const { projects: _rootTestProjects, ...baseTestConfig } = baseConfig.test ?? {};
// Workspace cache configuration is invalid on a package config.
const { run: _rootRunConfig, ...basePackageConfig } = baseConfig;

export default mergeConfig(
  { ...basePackageConfig, test: baseTestConfig },
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          dependsOn: ["@t3tools/web#build"],
          cache: false,
        },
        // SCIENT-FORK:START — desktop development renders from the Vite dev server, so its
        // server build skips the web production build and its copy (minutes per launch).
        "build:dev": {
          command: "node scripts/cli.ts build --skip-web-client",
          cache: false,
        },
        // SCIENT-FORK:END
      },
    },
    pack: {
      alias: CLI_BUNDLE_ALIASES,
      // SEA embeds one entry; expose the history worker as a hidden subcommand.
      entry: packBootstrap
        ? ["src/bin.ts"]
        : packExecutable
          ? ["src/binMain.ts"]
          : [
              "src/bin.ts",
              // SCIENT-FORK:START — execute the real bundled engine from installed qualification.
              "src/overleaf-packaging-probe.ts",
              // SCIENT-FORK:END
              "src/analytics-worker.ts",
              "src/claude-history-worker.ts",
              "src/pdf-validation-worker.ts",
              "src/tool-discovery-worker.ts",
              "src/pdf.worker.ts",
            ],
      outDir: packBootstrap ? "dist-exe" : packExecutable ? cliAssetDir : "dist",
      sourcemap: !packExecutable,
      clean: true,
      // SEA can only resolve built-ins; keep dynamic imports inside each emitted module.
      ...(packExecutable ? { outputOptions: { codeSplitting: false } } : {}),
      ...(packMode === "1"
        ? {
            exe: {
              fileName: SCIENT_DESKTOP_IDENTITY.cliCommandName,
              outDir: "dist-exe",
              ...(packExecutableTargets ? { targets: packExecutableTargets } : {}),
              // Node SEA useCodeCache breaks import(), which the server needs.
              seaConfig: {
                useCodeCache: false,
                // The bootstrap loads the embedded CLI with require(esm).
                execArgv: ["--require-module"],
                assets: { "binMain.mjs": NodePath.join(cliAssetDir, "binMain.mjs") },
              },
            },
          }
        : {}),
      deps: {
        // alwaysBundle=false has no opinion; neverBundle must retain transitive native acceleration.
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: (id: string) =>
          (packBootstrap && id === "./binMain.ts") || isExternalCliDependency(id),
        onlyBundle: false,
      },
      banner: {
        js: "#!/usr/bin/env node\n",
      },
      define: {
        __T3CODE_BUILD_CHANNEL__: JSON.stringify(cliBuildChannel),
        __T3CODE_BUILD_RELAY_URL__: JSON.stringify(
          SCIENT_DESKTOP_IDENTITY.cloudEnabled ? (repoEnv.T3CODE_RELAY_URL?.trim() ?? "") : "",
        ),
        __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
          SCIENT_DESKTOP_IDENTITY.cloudEnabled
            ? (repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "")
            : "",
        ),
        __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(
          SCIENT_DESKTOP_IDENTITY.cloudEnabled
            ? (repoEnv.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "")
            : "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: JSON.stringify(
          SCIENT_DESKTOP_IDENTITY.outboundTelemetryEnabled
            ? (repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() ?? "")
            : "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: JSON.stringify(
          SCIENT_DESKTOP_IDENTITY.outboundTelemetryEnabled
            ? (repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() ?? "")
            : "",
        ),
        __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: JSON.stringify(
          SCIENT_DESKTOP_IDENTITY.outboundTelemetryEnabled
            ? (repoEnv.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() ?? "")
            : "",
        ),
      },
    },
    test: {
      // Parallel sqlite/git/worktree/orchestration tests introduce load-sensitive flakes.
      fileParallelism: false,
      sequence: { sequencer: WeightedShardSequencer },
      // SCIENT-FORK:START — real measurements run in the maintained benchmark lane.
      benchmark: { include: ["src/**/*.bench.ts"] },
      // SCIENT-FORK:END
      setupFiles: [
        "./src/testUtils/gitConfig.setup.ts",
        "./src/testUtils/managedServiceEnv.setup.ts",
        // SCIENT-FORK:START — Git cannot reach the source checkout from a test.
        "./src/testUtils/checkoutIsolation.setup.ts",
        // SCIENT-FORK:END
      ],
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);
