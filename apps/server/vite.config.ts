import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";
import rootPackageJson from "../../package.json" with { type: "json" };
import packageJson from "./package.json" with { type: "json" };
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import { WeightedShardSequencer } from "./src/testUtils/weightedShardSequencer.ts";
// The bundle used to inline only workspace packages, leaving every third-party
// runtime dep external. External deps must exist on the real filesystem (the WSL
// backend runs plain `wsl.exe -- node`, which cannot read inside an asar), so the
// desktop build unpacked `**\/node_modules\/**` wholesale: 13,875 loose files to
// support 20 native binaries. NSIS install time tracks file count, not bytes.
//
// Inverted here — bundle everything except the packages that genuinely cannot be
// inlined. See scripts/lib/cli-external-packages.ts for what earns an exemption.
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

// `build:exe` wraps the same bundle in a Node single-executable. tsdown's exe
// step refuses multi-chunk output and counts the sourcemap as a chunk, and the
// executable needs a host Node that supports `--build-sea` (25.7+), so this is
// a separate mode rather than a second entry in the default build.
const packExecutable = process.env.T3CODE_PACK_EXE === "1";
const SEA_TARGETS = {
  "darwin-arm64": { platform: "darwin", arch: "arm64" },
  "darwin-x64": { platform: "darwin", arch: "x64" },
  "linux-arm64": { platform: "linux", arch: "arm64" },
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

export default mergeConfig(
  { ...baseConfig, test: baseTestConfig },
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
      entry: packExecutable
        ? ["src/bin.ts"]
        : [
            "src/bin.ts",
            "src/analytics-worker.ts",
            "src/claude-history-worker.ts",
            "src/pdf-validation-worker.ts",
            "src/pdf.worker.ts",
          ],
      outDir: packExecutable ? "dist-exe" : "dist",
      sourcemap: !packExecutable,
      clean: true,
      ...(packExecutable
        ? {
            exe: {
              fileName: SCIENT_DESKTOP_IDENTITY.cliCommandName,
              outDir: "dist-exe",
              ...(packExecutableTargets ? { targets: packExecutableTargets } : {}),
              seaConfig: { useCodeCache: false },
            },
          }
        : {}),
      deps: {
        // `neverBundle` forces the native packages out: returning false from
        // `alwaysBundle` only means "no opinion", so a transitive dependency
        // would still be bundled — which silently inlined native loaders such
        // as node-gyp-build, losing native acceleration.
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: (id: string) => isExternalCliDependency(id),
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
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      sequence: { sequencer: WeightedShardSequencer },
      // SCIENT-FORK:START — real measurements run in the maintained benchmark lane.
      benchmark: { include: ["src/**/*.bench.ts"] },
      // SCIENT-FORK:END
      // Appended to the root setup, which mergeConfig concatenates.
      setupFiles: [
        "./src/testUtils/gitConfig.setup.ts",
        // SCIENT-FORK:START — Git cannot reach the source checkout from a test.
        "./src/testUtils/checkoutIsolation.setup.ts",
        // SCIENT-FORK:END
      ],
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);
