import * as NodeURL from "node:url";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Vite config runs before any Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeZlib from "node:zlib";

import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import compression from "compression";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import "vite-plus/test/config";
import { defineConfig, type Connect, type Plugin } from "vite-plus";
import * as Hash from "effect/Hash";
import pkg from "./package.json" with { type: "json" };
import pdfjsPkg from "pdfjs-dist/package.json" with { type: "json" };

import {
  DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES,
  DEV_PROXIED_PATH_PREFIXES,
} from "@t3tools/shared/devProxy";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";

import { loadRepoEnv } from "../../scripts/lib/public-config";
import { scientPdfAssets } from "./scripts/scientPdfAssets";
import { thirdPartyLicensesPlugin } from "../../scripts/lib/third-party-licenses";
import { tailwindPlugins } from "./vite/tailwind";
import { warmBundledDevPlugin } from "./vite/warmBundledDev";
// SCIENT-FORK:START — balance CI's fixed three web shards using recorded file durations.
import { WeightedShardSequencer } from "./src/testUtils/weightedShardSequencer";
// SCIENT-FORK:END
// SCIENT-FORK:START — opt-in CI-like CPU throttle for local browser runs.
import { applyCpuThrottle } from "./test/scientCpuThrottle";
// SCIENT-FORK:END

const repoEnv = loadRepoEnv();
Object.assign(process.env, repoEnv);

// Signal single-origin dev explicitly; loadRepoEnv can restore deleted URL keys from .env.
const isSingleOriginDev = process.env.T3CODE_SINGLE_ORIGIN_DEV === "1";

const port = Number(process.env.PORT ?? 5733);
const explicitHost = process.env.HOST?.trim();
const host = explicitHost || "localhost";
const configuredWsUrl = isSingleOriginDev ? undefined : process.env.VITE_WS_URL?.trim();
const configuredHttpUrl = isSingleOriginDev ? undefined : process.env.VITE_HTTP_URL?.trim();
const configuredRelayUrl = SCIENT_DESKTOP_IDENTITY.cloudEnabled
  ? repoEnv.VITE_T3CODE_RELAY_URL?.trim() || ""
  : "";
const configuredClerkPublishableKey = SCIENT_DESKTOP_IDENTITY.cloudEnabled
  ? repoEnv.VITE_CLERK_PUBLISHABLE_KEY?.trim() || ""
  : "";
const configuredClerkJwtTemplate = SCIENT_DESKTOP_IDENTITY.cloudEnabled
  ? repoEnv.VITE_CLERK_JWT_TEMPLATE?.trim() || ""
  : "";
const configuredClerkCliOAuthClientId = SCIENT_DESKTOP_IDENTITY.cloudEnabled
  ? repoEnv.VITE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || ""
  : "";
const configuredRelayTracingUrl = SCIENT_DESKTOP_IDENTITY.outboundTelemetryEnabled
  ? repoEnv.VITE_RELAY_OTLP_TRACES_URL?.trim() || ""
  : "";
const configuredRelayTracingDataset = SCIENT_DESKTOP_IDENTITY.outboundTelemetryEnabled
  ? repoEnv.VITE_RELAY_OTLP_TRACES_DATASET?.trim() || ""
  : "";
const configuredRelayTracingToken = SCIENT_DESKTOP_IDENTITY.outboundTelemetryEnabled
  ? repoEnv.VITE_RELAY_OTLP_TRACES_TOKEN?.trim() || ""
  : "";
const configuredHostedAppChannel = process.env.VITE_HOSTED_APP_CHANNEL?.trim() || "";
const configuredReleaseChannel =
  process.env.T3CODE_BUILT_DEV === "1" ? "dev" : process.env.VITE_RELEASE_CHANNEL?.trim() || "";
const configuredAppVersion = process.env.APP_VERSION?.trim() || pkg.version;
const configuredDesktopUpdateRepository =
  process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim() ||
  process.env.GITHUB_REPOSITORY?.trim() ||
  "";
const configuredHostedAppUrl = (() => {
  const explicitHostedAppUrl = process.env.VITE_HOSTED_APP_URL?.trim();
  if (explicitHostedAppUrl) {
    return explicitHostedAppUrl;
  }
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return undefined;
})();
const sourcemapEnv = process.env.T3CODE_WEB_SOURCEMAP?.trim().toLowerCase();

// `vp run dev --share --built` rebuilds on every change. The license manifest
// is about 2 s of each build, and nothing in that mode reads it.
const builtDev = process.env.T3CODE_BUILT_DEV === "1";

const bundledDevEnv = process.env.T3CODE_BUNDLED_DEV?.trim().toLowerCase();
const bundledDev = bundledDevEnv === "1" || bundledDevEnv === "true";

const buildSourcemap: boolean | "hidden" =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["src/**/*.browser.test.{ts,tsx}"],
    // SCIENT-FORK:START — native DOM benchmarks belong to the browser project.
    benchmark: {
      include: ["src/**/*.bench.{ts,tsx}"],
      exclude: ["src/**/*.browser.bench.{ts,tsx}"],
    },
    // SCIENT-FORK:END
    hookTimeout: 15_000,
    testTimeout: 15_000,
    setupFiles: [
      "../../packages/shared/src/testing/longTempDir.ts",
      "../../packages/shared/src/testing/providerEnv.ts",
    ],
  },
} satisfies TestProjectInlineConfiguration;

// Hash checkout paths to ports 61000-64999; Vitest's fixed port collides under inherited strictPort.
const browserTestApiPort = 61_000 + ((Hash.string(import.meta.dirname) >>> 0) % 4_000);

const browserTestProject = {
  extends: true,
  // Pre-bundle lazy browser and worker dependencies to avoid mid-run reloads.
  optimizeDeps: {
    include: [
      "vite-plus/test/browser",
      "@base-ui/react/autocomplete",
      "saxes",
      "@betteroffice/docx/editor",
      "@betteroffice/docx/layout",
      "@betteroffice/docx/layout/render",
      "@betteroffice/docx/yrs",
      "@betteroffice/fonts",
      "@betteroffice/pptx",
      "@betteroffice/xlsx",
      "@betteroffice/xlsx/headless",
      "fast-xml-parser",
      "entities",
      "dompurify",
      "heic-to/next",
      "jszip",
      "pdfjs-dist",
      "sql.js",
      "tiff",
    ],
  },
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.{ts,tsx}"],
    // SCIENT-FORK:START — opt-in benchmarks retain real browser performance budgets.
    benchmark: { include: ["src/**/*.browser.bench.{ts,tsx}"] },
    // SCIENT-FORK:END
    hookTimeout: 15_000,
    // SCIENT-FORK:START — Cold document construction shares the native-input budget.
    testTimeout: 30_000,
    // SCIENT-FORK:END
    // SCIENT-FORK:START — CI runners lay out 4-7x slower than a Mac; 1 s waits are too tight.
    // test/scientBrowserSetup.ts gives vi.waitFor the same 5 s default and applies
    // SCIENT_TEST_CPU_THROTTLE. A wait that checks responsiveness states its own timeout.
    expect: { poll: { timeout: 5_000 } },
    setupFiles: ["./test/browserSetup.ts", "./test/scientBrowserSetup.ts"],
    // SCIENT-FORK:END
    api: { port: browserTestApiPort, strictPort: false },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      screenshotFailures: false,
      commands: {
        // Playwright's mouse outlives each test, so whatever mounts under its last
        // position starts hovered. test/browserSetup.ts parks it off the page before each test.
        resetPointer: async ({ page }) => {
          await page.mouse.move(-1, -1);
        },
        // SCIENT-FORK:START — SCIENT_TEST_CPU_THROTTLE (test/scientCpuThrottle.ts).
        applyCpuThrottle,
        // SCIENT-FORK:END
      },
    },
  },
} satisfies TestProjectInlineConfiguration;

// Render scenarios count React commits; they run only through scripts/render-metrics.ts,
// which reads the per-scenario reports this command writes.
const renderScenariosProject = {
  ...browserTestProject,
  test: {
    ...browserTestProject.test,
    name: "renders",
    include: ["test/*.renders.tsx"],
    // App scenarios mount the whole app per test, which outlasts 15s on a loaded machine.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: ["./test/renderCounter.ts", ...browserTestProject.test.setupFiles],
    browser: {
      ...browserTestProject.test.browser,
      // Vitest names each instance in place, so a shared array would clash with the browser project.
      instances: [{ browser: "chromium" }],
      commands: {
        ...browserTestProject.test.browser.commands,
        writeRenderReport: async (_context, scenario: string, json: string) => {
          const directory = process.env.T3CODE_RENDER_REPORT_DIR;
          if (!directory) throw new Error("T3CODE_RENDER_REPORT_DIR is not set");
          await NodeFSP.writeFile(`${directory}/${scenario}.json`, json);
        },
      },
    },
  },
} satisfies TestProjectInlineConfiguration;

function resolveDevProxyTarget(
  backendPort: string | undefined,
  wsUrl: string | undefined,
): string | undefined {
  const port = Number(backendPort?.trim());
  if (Number.isInteger(port) && port > 0) {
    return `http://localhost:${port}/`;
  }

  // dev:desktop connects directly to the backend; derive its target from the explicit WebSocket URL.
  if (!wsUrl) {
    return undefined;
  }

  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const devProxyTarget = resolveDevProxyTarget(process.env.T3CODE_PORT, configuredWsUrl);

// Brotli quality 5 encodes in hundreds of ms; default quality 11 would replace transfer stalls with encode stalls.
function devCompressionPlugin(): Plugin {
  return {
    name: "t3code:dev-compression",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(
        compression({
          brotli: { params: { [NodeZlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
        }) as unknown as Connect.NextHandleFunction,
      );
    },
  };
}

// A static import cycle between chunks can run a chunk before the values it imports exist,
// which blanks the app at boot. Fail the build instead of shipping it.
function chunkCycleGuardPlugin(): Plugin {
  return {
    name: "t3code:chunk-cycle-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const done = new Set<string>();
      const visit = (fileName: string, path: string[]) => {
        if (done.has(fileName)) return;
        const start = path.indexOf(fileName);
        if (start !== -1) {
          this.error(`Chunk import cycle: ${[...path.slice(start), fileName].join(" -> ")}`);
        }
        const chunk = bundle[fileName];
        if (chunk?.type !== "chunk") return;
        for (const imported of chunk.imports) visit(imported, [...path, fileName]);
        done.add(fileName);
      };
      for (const fileName of Object.keys(bundle)) visit(fileName, []);
    },
  };
}

// Allow Tailnet hosts for sharing; Tailscale-controlled DNS prevents attacker rebinding.
const configuredAllowedHosts = (process.env.T3CODE_DEV_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const allowedHosts = [".ts.net", ...configuredAllowedHosts];

export default defineConfig(({ mode }) => {
  return {
    run: {
      tasks: {
        // tsc (tsc-rs) rewrites the tsbuildinfo it reads, which keeps a task out of the cache.
        typecheck: {
          command: "tsc --noEmit",
          cache: { input: [{ auto: true }, "!*.tsbuildinfo"] },
        },
      },
    },
    assetsInclude: ["**/*.wasm"],
    plugins: [
      scientPdfAssets(),
      devCompressionPlugin(),
      chunkCycleGuardPlugin(),
      builtDev
        ? undefined
        : thirdPartyLicensesPlugin({
            bundleName: "web",
            configFile: new URL("../../third-party-licenses.config.json", import.meta.url),
            packageManifests: [
              { bundle: "web", path: new URL("./package.json", import.meta.url) },
              { bundle: "server", path: new URL("../server/package.json", import.meta.url) },
              { bundle: "desktop", path: new URL("../desktop/package.json", import.meta.url) },
            ],
          }),
      tanstackRouter({ autoCodeSplitting: true }),
      react({ compiler: true }),
      tailwindPlugins(bundledDev),
      warmBundledDevPlugin(),
    ],
    optimizeDeps: {
      // Keep the barrel, icon factory and icons together: splitting only the
      // icons can create a cycle back to an uninitialized factory in the barrel.
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: "lucide-icons",
                test: /[/\\]lucide-react[/\\]dist[/\\]esm[/\\]/,
                includeDependenciesRecursively: false,
              },
            ],
          },
        },
      },
      include: [
        "@clerk/clerk-js",
        "@clerk/react/internal",
        "@pierre/diffs",
        "@pierre/diffs/edit",
        "@pierre/diffs/react",
        "@pierre/diffs/worker",
        "@pierre/diffs/worker/worker.js",
        "effect/Array",
        "effect/Order",
        "react-dom/client",
        // The passive math converter loads in a module worker. Discovering its
        // dependency after the page starts can leave that worker waiting on a
        // new optimizer pass; prepare both MathLive entry points up front.
        "mathlive",
        "mathlive/ssr",
        // Page editing starts in a worker; prepare its dependency before a document action.
        "pdf-lib",
        ...(process.env.VITEST
          ? [
              "@base-ui/react/alert-dialog",
              "@base-ui/react/autocomplete",
              "@base-ui/react/collapsible",
              "@base-ui/react/combobox",
              "@base-ui/react/direction-provider",
              "@base-ui/react/number-field",
              "@base-ui/react/radio",
              "@base-ui/react/radio-group",
              "@base-ui/react/scroll-area",
              "@base-ui/react/toggle",
              "@base-ui/react/toggle-group",
              "@daypicker/react",
              "@pierre/diffs/utils/parsePatchFiles",
              "@pierre/trees",
              "effect/reactivity/AsyncResult",
              "heic-to/csp",
              "@scientfactory/conversation > mdast-util-from-markdown",
              "@scientfactory/conversation > mdast-util-frontmatter",
              "@scientfactory/conversation > mdast-util-gfm",
              "@scientfactory/conversation > mdast-util-math",
              "@scientfactory/conversation > micromark-extension-frontmatter",
              "@scientfactory/conversation > micromark-extension-gfm",
              "@scientfactory/conversation > micromark-extension-math",
              "@scientfactory/conversation > yaml",
              "zustand/vanilla/shallow",
            ]
          : []),
      ],
    },
    define: {
      "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
      // Override .env URLs with empty values in single-origin dev so clients use window.location.origin.
      "import.meta.env.VITE_HTTP_URL": JSON.stringify(configuredHttpUrl ?? ""),
      "import.meta.env.VITE_T3CODE_RELAY_URL": JSON.stringify(configuredRelayUrl),
      "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify(configuredClerkPublishableKey),
      "import.meta.env.VITE_CLERK_JWT_TEMPLATE": JSON.stringify(configuredClerkJwtTemplate),
      "import.meta.env.VITE_CLERK_CLI_OAUTH_CLIENT_ID": JSON.stringify(
        configuredClerkCliOAuthClientId,
      ),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_URL": JSON.stringify(configuredRelayTracingUrl),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET": JSON.stringify(
        configuredRelayTracingDataset,
      ),
      "import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN": JSON.stringify(configuredRelayTracingToken),
      "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(configuredHostedAppUrl ?? ""),
      "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify(configuredHostedAppChannel),
      "import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY": JSON.stringify(
        configuredDesktopUpdateRepository,
      ),
      "import.meta.env.VITE_RELEASE_CHANNEL": JSON.stringify(configuredReleaseChannel),
      "import.meta.env.APP_VERSION": JSON.stringify(configuredAppVersion),
    },
    resolve: {
      tsconfigPaths: true,
      alias: {
        "@betteroffice/fonts-cjk": new URL(
          "./src/components/files/office/fonts-cjk.ts",
          import.meta.url,
        ).pathname,
      },
      dedupe: ["react", "react-dom"],
    },
    experimental: {
      bundledDev,
    },
    server: {
      host,
      port,
      strictPort: true,
      allowedHosts,
      // Warm the module graph before first request to avoid serial import transforms over tailnet.
      // Bundled dev ignores this; warmBundledDevPlugin handles it there.
      warmup: {
        // Component fixtures load their own entry. Warming the entire chat app
        // can hold their test page behind unrelated transforms and time it out.
        clientFiles: mode === "test" ? [] : ["./src/main.tsx"],
      },
      ...(devProxyTarget
        ? {
            // Share prefixes with the backend catch-all so the proxy and 404 lists cannot drift.
            proxy: Object.fromEntries(
              DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
                prefix,
                {
                  target: devProxyTarget,
                  changeOrigin: !DEV_PROXIED_ORIGIN_PRESERVING_PREFIXES.has(prefix),
                  ...(prefix === "/ws" || prefix === "/api" ? { ws: true } : {}),
                },
              ]),
            ),
          }
        : {}),
      // Electron needs an explicit HMR host; elsewhere derive it from page origin for Tailscale/LAN.
      ...(explicitHost
        ? {
            hmr: {
              protocol: "ws",
              host: explicitHost,
              clientPort: port,
            },
          }
        : {}),
    },
    // Tailwind needs devSourcemap to avoid Rolldown SOURCEMAP_BROKEN on sourcemapped builds.
    css: {
      devSourcemap: buildSourcemap !== false,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      manifest: true,
      sourcemap: buildSourcemap,
      // SCIENT-FORK:START — the standalone document page the desktop prints
      // for PDF export ships beside the app entry.
      rolldownOptions: {
        input: {
          main: NodeURL.fileURLToPath(new URL("./index.html", import.meta.url)),
          "scient-document": NodeURL.fileURLToPath(
            new URL("./scient-document.html", import.meta.url),
          ),
        },
        output: {
          // PDF.js resolves decoder modules and ICC data relative to wasmUrl.
          assetFileNames: (asset) =>
            asset.originalFileNames.some((path) => /[/\\]pdfjs-dist[/\\]wasm[/\\]/.test(path))
              ? `assets/pdfjs-${pdfjsPkg.version}/[name][extname]`
              : "assets/[name]-[hash][extname]",
        },
      },
      // SCIENT-FORK:END
    },
    worker: { format: "es" },
    test: {
      projects: [
        defineProject(unitTestProject),
        defineProject(browserTestProject),
        defineProject(renderScenariosProject),
      ],
      // SCIENT-FORK:START — balance both test projects by recorded duration.
      sequence: { sequencer: WeightedShardSequencer },
      // SCIENT-FORK:END
    },
  };
});
