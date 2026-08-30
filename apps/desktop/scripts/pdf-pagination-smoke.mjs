// Real Chromium regression test. Run with Node; on Linux use xvfb-run.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

if (!process.versions.electron) {
  const { resolveElectronBinaryPath } = await import("./electron-launcher.mjs");
  const electronPath = resolveElectronBinaryPath();
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = NodeChildProcess.spawnSync(
    electronPath,
    [NodeURL.fileURLToPath(import.meta.url)],
    {
      env: environment,
      stdio: "inherit",
      timeout: 60_000,
      killSignal: "SIGTERM",
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

// Do not await this at module scope: Electron waits for ESM evaluation before
// emitting ready, so a top-level app.whenReady() would deadlock startup.
async function run() {
  // Set the disposable profile synchronously, before Electron can emit ready.
  const { app, BrowserWindow } = NodeModule.createRequire(import.meta.url)("electron");
  const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-pdf-pagination-"));
  app.setPath("userData", state);
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  const deadline = setTimeout(() => app.exit(1), 45_000);

  const table = (caption = "") =>
    `<table>${caption}<tr><td style="height:170pt">TABLE_CONTENT</td></tr></table>`;
  const figure = (top) =>
    `<figure>${top ? "<figcaption>FIGURE_CAPTION</figcaption>" : ""}<div style="height:150pt">FIGURE_CONTENT</div>${top ? "" : "<figcaption>FIGURE_CAPTION</figcaption>"}</figure>`;
  const intro = '<div style="height:450pt">INTRODUCTION</div>';
  const cases = [
    {
      name: "bottom figure caption",
      body: intro + figure(false) + table(),
      first: ["FIGURE_CONTENT", "FIGURE_CAPTION"],
      second: ["TABLE_CONTENT"],
    },
    {
      name: "top figure caption",
      body: intro + figure(true) + table(),
      first: ["FIGURE_CONTENT", "FIGURE_CAPTION"],
      second: ["TABLE_CONTENT"],
    },
    {
      name: "bottom table caption",
      body:
        intro +
        table('<caption style="caption-side:bottom">TABLE_CAPTION</caption>') +
        '<figure style="height:180pt">NEXT_FIGURE</figure>',
      first: ["TABLE_CONTENT", "TABLE_CAPTION"],
      second: ["NEXT_FIGURE"],
    },
    {
      name: "top table caption",
      body:
        intro +
        table("<caption>TABLE_CAPTION</caption>") +
        '<figure style="height:180pt">NEXT_FIGURE</figure>',
      first: ["TABLE_CONTENT", "TABLE_CAPTION"],
      second: ["NEXT_FIGURE"],
    },
    {
      name: "authored page break",
      body: '<p>FIRST_PAGE</p><p style="break-before:page">SECOND_PAGE</p>',
      first: ["FIRST_PAGE"],
      second: ["SECOND_PAGE"],
    },
    {
      name: "oversized table",
      body: `<table>${Array.from({ length: 45 }, (_, index) => `<tr><td style="height:24pt">ROW_${String(index).padStart(2, "0")}_END</td></tr>`).join("")}</table>`,
      first: ["ROW_00_END"],
      all: Array.from({ length: 45 }, (_, index) => `ROW_${String(index).padStart(2, "0")}_END`),
    },
  ];

  try {
    const Effect = await import("effect/Effect");
    const { createBrowserPdfRenderer } =
      await import("../src/scient/documentExport/BrowserPdfRenderer.ts");
    // Reuse the server's PDF parser without adding a production dependency.
    const serverRequire = NodeModule.createRequire(
      new URL("../../server/package.json", import.meta.url),
    );
    const { getDocument, GlobalWorkerOptions } = await import(
      serverRequire.resolve("pdfjs-dist/legacy/build/pdf.mjs")
    );
    GlobalWorkerOptions.workerSrc = serverRequire.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    await app.whenReady();
    for (const marginPolicy of ["readable-fallback", "source-authored"]) {
      for (const fixture of cases) {
        const window = new BrowserWindow({
          show: false,
          width: 1280,
          height: 900,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        try {
          const stoppedLoading = NodeEvents.once(window.webContents, "did-stop-loading");
          await window.loadURL(
            `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html lang="en"><head><title>Pagination regression</title><style>@page{size:Letter;margin:36pt}body{margin:0;font:12pt/16pt sans-serif}figure,table{margin:0}table{width:100%;border-collapse:collapse}td{padding:0}figcaption,caption{height:20pt}</style></head><body>${fixture.body}</body></html>`)}`,
          );
          await stoppedLoading;
          const result = await Effect.runPromise(
            createBrowserPdfRenderer({ marginPolicy })(window.webContents),
          );
          const loading = getDocument({ data: result.data, isEvalSupported: false });
          try {
            const pdf = await loading.promise;
            const pages = [];
            for (let number = 1; number <= pdf.numPages; number += 1) {
              const page = await pdf.getPage(number);
              const content = await page.getTextContent();
              pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
            }
            for (const word of fixture.first)
              NodeAssert.ok(
                pages[0]?.includes(word),
                `${fixture.name}: ${word} must fit on page 1 (${marginPolicy})`,
              );
            for (const word of fixture.second ?? [])
              NodeAssert.ok(
                pages[1]?.includes(word),
                `${fixture.name}: ${word} must start on page 2 (${marginPolicy})`,
              );
            for (const word of fixture.all ?? [])
              NodeAssert.ok(pages.join(" ").includes(word), `${fixture.name}: lost ${word}`);
            NodeAssert.ok(
              pages.every((page) => page.trim().length > 0),
              `${fixture.name}: empty page`,
            );
            if (fixture.second)
              NodeAssert.equal(pdf.numPages, 2, `${fixture.name}: unexpected extra page`);
            console.log(`PASS ${marginPolicy}: ${fixture.name} (${pdf.numPages} pages)`);
          } finally {
            await loading.destroy();
          }
        } finally {
          window.destroy();
        }
      }
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    await NodeFSP.rm(state, { recursive: true, force: true });
    app.exit(process.exitCode ?? 0);
  }
}

void run().catch((error) => {
  console.error(error);
  process.exit(1);
});
