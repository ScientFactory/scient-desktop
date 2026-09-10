// Real Chromium regression test; no visible windows or user profile. On Linux use xvfb-run.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

if (!process.versions.electron) {
  const { resolveElectronBinaryPath } = await import("./electron-launcher.mjs");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = NodeChildProcess.spawnSync(
    resolveElectronBinaryPath(),
    [NodeURL.fileURLToPath(import.meta.url)],
    { env: environment, stdio: "inherit", timeout: 120_000, killSignal: "SIGTERM" },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

async function run() {
  const { app, BrowserWindow } = NodeModule.createRequire(import.meta.url)("electron");
  const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-mermaid-smoke-"));
  app.setPath("userData", state);
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  const deadline = setTimeout(() => app.exit(1), 100_000);
  const webRoot = NodeURL.fileURLToPath(new URL("../../web/", import.meta.url));
  const webRequire = NodeModule.createRequire(new URL("../../web/package.json", import.meta.url));
  let server;
  let window;
  try {
    const { createServer } = await import(webRequire.resolve("vite"));
    server = await createServer({
      configFile: false,
      root: webRoot,
      logLevel: "error",
      appType: "custom",
      cacheDir: NodePath.join(state, "vite"),
      resolve: { alias: { "~": NodePath.join(webRoot, "src") } },
      server: { host: "127.0.0.1", port: 0 },
      optimizeDeps: { include: ["mermaid"] },
    });
    server.middlewares.use("/__mermaid_smoke", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<!doctype html><html><head><title>Mermaid regression</title></head><body></body></html>",
      );
    });
    await server.listen();
    const markdown = await NodeFSP.readFile(
      new URL("../../../docs/fixtures/scient-chat-diagrams.md", import.meta.url),
      "utf8",
    );
    const fixtures = [...markdown.matchAll(/^```mermaid[^\n]*\n([\s\S]*?)^```/gm)].map(
      (match) => match[1],
    );
    NodeAssert.ok(fixtures.length >= 15, "Fixture corpus must not silently disappear");
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await window.loadURL(`${server.resolvedUrls.local[0]}__mermaid_smoke`);
    const results = await window.webContents.executeJavaScript(
      `(${async function (sources) {
        const {
          renderMermaidDiagram,
          MermaidRenderError,
          MERMAID_VERSION,
          getMermaidRuntimePromise,
        } = await import("/src/scient/diagrams/mermaidRuntime.ts");
        const { prepareSvgForExport, copyMermaidPng } =
          await import("/src/scient/diagrams/mermaidExport.ts");
        function check(condition, message) {
          if (!condition) throw new Error(message);
        }
        const output = [];
        const pngFailures = [];
        window.desktopBridge = {
          copyPngToClipboard: async (bytes) => {
            check(
              bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71,
              "PNG encoding failed",
            );
          },
        };
        // The corpus ends with the two deliberately invalid cases. Exercise a
        // failed render first, proving it does not poison the shared render queue.
        for (const source of sources.slice(-2)) {
          let error;
          try {
            await renderMermaidDiagram(source, "light");
          } catch (cause) {
            error = cause;
          }
          check(error instanceof Error, "Malformed/empty source unexpectedly rendered");
          if (source.trim()) {
            check(
              error instanceof MermaidRenderError && error.details.includes("\n"),
              "Full parser diagnostic was lost",
            );
          }
        }
        for (const theme of ["light", "dark"]) {
          for (const [index, source] of sources.slice(0, -2).entries()) {
            const { svg, diagramType } = await renderMermaidDiagram(source, theme);
            // Match the card's HTML insertion, not XML parsing. Both Mermaid
            // 11 and 12 serialize HTML <br> labels that render correctly here
            // but are not well-formed standalone XML (recorded below).
            const node = new DOMParser().parseFromString(svg, "text/html");
            check(!node.querySelector("script"), "Script survived strict rendering");
            const dimensions = node
              .querySelector("svg")
              .getAttribute("viewBox")
              ?.split(/[ ,]+/)
              .map(Number);
            check(
              dimensions?.length === 4 &&
                dimensions.every(Number.isFinite) &&
                dimensions[2] > 0 &&
                dimensions[3] > 0,
              `Invalid dimensions: ${theme}/${index}`,
            );
            const exported = new DOMParser().parseFromString(
              prepareSvgForExport(svg, theme),
              "image/svg+xml",
            );
            // Known pre-existing limitation, isolated to authored HTML breaks.
            // Fail on any additional export failure introduced by an upgrade.
            check(
              Boolean(exported.querySelector("parsererror")) === source.includes("<br/>"),
              `Changed XML export behavior: ${theme}/${index}`,
            );
            output.push(`${theme}: ${diagramType}`);
            try {
              await copyMermaidPng(svg, theme);
            } catch (error) {
              pngFailures.push(`${theme}/${index}: ${error.message}`);
            }
          }
        }
        // Stress duplicates, theme serialization and cache ID rebasing together.
        const copies = await Promise.all(
          Array.from({ length: 48 }, (_, index) =>
            renderMermaidDiagram(
              `flowchart LR\n A --> B\n%% stress ${Math.floor(index / 4)}`,
              index % 2 ? "dark" : "light",
            ),
          ),
        );
        const ids = new Set();
        for (const { svg } of copies) {
          const node = new DOMParser().parseFromString(svg, "image/svg+xml");
          for (const element of node.querySelectorAll("[id]")) {
            check(!ids.has(element.id), "Cached diagrams reused DOM ids");
            ids.add(element.id);
          }
        }
        const { default: mermaid } = await getMermaidRuntimePromise();
        // Existing HTML-label export failures reproduced with 11.16.1. Keep
        // the rendering gate explicit and do not present this as export success.
        const baselinePngFailures = [0, 2, 3, 4, 5, 9, 10, 11, 12, 13];
        check(
          JSON.stringify(pngFailures.map((failure) => failure.split(":")[0])) ===
            JSON.stringify(
              ["light", "dark"].flatMap((theme) =>
                baselinePngFailures.map((index) => `${theme}/${index}`),
              ),
            ),
          "PNG export differs from the pre-upgrade baseline; inspect before accepting",
        );
        const config = mermaid.mermaidAPI.getConfig();
        check(
          config.layout === "dagre" && config.look === "classic",
          "Upgrade changed layout/look defaults",
        );
        check(config.securityLevel === "strict", "Strict mode was lost");
        // Frontmatter/comments before the declaration are valid: guidance must
        // not demand the diagram declaration be the literal first line.
        await renderMermaidDiagram(
          "---\ntitle: Metadata\n---\n%% comment\nflowchart LR\n A --> B",
          "light",
        );
        const untrusted = await renderMermaidDiagram(
          'flowchart LR\n A["<script>alert(1)</script>Safe"] --> B',
          "light",
        );
        check(
          !new DOMParser().parseFromString(untrusted.svg, "text/html").querySelector("script"),
          "Untrusted script survived rendering",
        );
        return {
          version: MERMAID_VERSION,
          fixtures: output,
          concurrentCopies: copies.length,
          pngFailures,
          knownLimitation:
            "Standalone XML export with HTML line-break labels (also reproduced on 11.16.1)",
        };
      }.toString()})(${JSON.stringify(fixtures)})`,
    );
    console.log(JSON.stringify(results, null, 2));
  } finally {
    clearTimeout(deadline);
    window?.destroy();
    await server?.close();
    await NodeFSP.rm(state, { recursive: true, force: true });
  }
}

void run().then(
  () => NodeModule.createRequire(import.meta.url)("electron").app.exit(0),
  (error) => {
    console.error(error);
    NodeModule.createRequire(import.meta.url)("electron").app.exit(1);
  },
);
