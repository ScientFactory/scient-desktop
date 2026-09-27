// Real Chromium qualification of Scient's document page PDF export. Renders a
// fixture set through the web client's document page (served by Vite) and the
// desktop's document-page renderer, then checks the PDFs with PDF.js: page
// structure, logical text order, bookmarks, tagging, and refusal cases.
// Writes the PDFs for visual review to $SCIENT_DOCUMENT_PDF_FIXTURE_OUT
// (default: <repo>/build/document-pdf-fixtures). On Linux use xvfb-run.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const STATE_ENV = "SCIENT_DOCUMENT_PDF_FIXTURE_STATE";
const OUT_ENV = "SCIENT_DOCUMENT_PDF_FIXTURE_OUT";
const SCHEME = "scient-fixture";
const repoRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));

if (!process.versions.electron) {
  const { resolveElectronBinaryPath } = await import("./electron-launcher.mjs");
  const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-document-pdf-"));
  const environment = { ...process.env, [STATE_ENV]: state };
  delete environment.ELECTRON_RUN_AS_NODE;
  let result;
  try {
    result = NodeChildProcess.spawnSync(
      resolveElectronBinaryPath(),
      [NodeURL.fileURLToPath(import.meta.url)],
      { env: environment, stdio: "inherit", timeout: 600_000, killSignal: "SIGTERM" },
    );
  } finally {
    NodeFS.rmSync(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const electron = NodeModule.createRequire(import.meta.url)("electron");
// Custom schemes must be privileged before Electron is ready.
electron.protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const sha256 = (text) => `sha256:${NodeCrypto.createHash("sha256").update(text).digest("hex")}`;

function lines(count, render) {
  return Array.from({ length: count }, (_, index) => render(index + 1)).join("\n");
}

const pad = (value) => String(value).padStart(3, "0");

/** Each fixture is one captured page input plus what its PDF must show. */
function fixtures(png) {
  const longCode = [
    "# Long code and tables",
    "",
    "SECTION_CODE_START introduces a long listing that must continue across pages.",
    "",
    "```python",
    lines(160, (n) => `value_${pad(n)} = compute(${n})  # CODE_LINE_${pad(n)}`),
    "```",
    "",
    "## A short block stays together",
    "",
    "```js",
    lines(6, (n) => `const short${n} = ${n}; // SHORT_${n}`),
    "```",
    "",
    "## A long table",
    "",
    "| Row | Measurement | Notes |",
    "| --- | ----------- | ----- |",
    lines(90, (n) => `| TABLE_ROW_${pad(n)} | ${(n * 1.5).toFixed(1)} | observation ${n} |`),
    "",
    "SECTION_AFTER_TABLE closes the document.",
  ].join("\n");

  const math = [
    "# Mathematics",
    "",
    "Inline math such as $E = mc^2$ and $\\alpha + \\beta = \\gamma$ sits in running text MATH_INLINE_MARKER.",
    "",
    "$$",
    "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
    "$$",
    "",
    "## Aligned equations",
    "",
    "$$",
    "\\begin{aligned}",
    "a &= b + c \\\\",
    "d &= e \\cdot f",
    "\\end{aligned}",
    "$$",
    "",
    "## A matrix",
    "",
    "$$",
    "A = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}",
    "$$",
    "",
    "MATH_END_MARKER",
  ].join("\n");

  const mermaid = [
    "# Diagrams",
    "",
    "DIAGRAM_INTRO_MARKER",
    "",
    "```mermaid",
    "flowchart LR",
    "  Capture[Capture source] --> Render[Render page]",
    "  Render --> Print[Print PDF]",
    "```",
    "",
    "## Sequence",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  Editor->>Server: Prepare capture",
    "  Server-->>Desktop: Render page",
    "```",
    "",
    "## A diagram with a syntax error",
    "",
    "```mermaid",
    "flowchart LR",
    "  A -->",
    "```",
    "",
    "DIAGRAM_END_MARKER",
  ].join("\n");

  const images = [
    "# Images",
    "",
    "IMAGE_INTRO_MARKER",
    "",
    '![Captured gradient](scient-asset:image-0001 "Figure 1. A captured workspace image")',
    "",
    "![Missing figure](scient-asset:image-0002)",
    "",
    "![Remote figure](https://example.com/remote.png)",
    "",
    "IMAGE_END_MARKER",
  ].join("\n");

  const bidi = [
    "# Mixed Hebrew and English",
    "",
    "BIDI_START_MARKER",
    "",
    "זהו משפט בעברית עם המילה Scient באמצע.",
    "",
    "This English paragraph mentions שלום inside it.",
    "",
    "- פריט ראשון",
    "- פריט שני with English",
    "",
    "| עמודה | Column |",
    "| ----- | ------ |",
    "| ערך | value |",
    "",
    "BIDI_END_MARKER",
  ].join("\n");

  // Sections of growing length move each heading down the page, so across
  // several pages some heading lands in the last lines of a page.
  const headings = [
    "# Headings near page ends",
    "",
    ...Array.from({ length: 30 }, (_, index) => {
      const n = index + 1;
      return [
        lines(
          3 + (n % 9),
          (line) => `FILLER_${pad(n)}_${line} This line moves the next heading down the page.`,
        ),
        "",
        `## HEADING_${pad(n)}`,
        "",
        `PARA_AFTER_${pad(n)} starts right after its heading.`,
        "",
      ].join("\n\n");
    }),
  ].join("\n");

  const conversation = [
    "# Long conversation",
    "",
    lines(120, (n) =>
      [
        n % 2 === 1
          ? `## You · 27 Sep 2026, ${String(8 + Math.floor(n / 20)).padStart(2, "0")}:${pad(n).slice(1)}`
          : `## Assistant · 27 Sep 2026, ${String(8 + Math.floor(n / 20)).padStart(2, "0")}:${pad(n).slice(1)}`,
        "",
        `MESSAGE_${pad(n)} ${n % 2 === 1 ? "Please check the next step." : "Here is what I found."}  `,
        `A second line kept as a hard break.`,
        "",
        n % 10 === 0 ? "```sh\npnpm test\n```\n" : "",
        n % 20 === 0
          ? `<!-- scient:part export=fixture n=${n} -->\n<details>\n<summary>Work log · 2 steps</summary>\n\nWORKLOG_${pad(n)} ran the tests.\n\n</details>\n`
          : "",
      ].join("\n"),
    ),
  ].join("\n");

  const asset = (id, fileName, content) => ({
    id,
    role: "image",
    fileName,
    mediaType: "image/png",
    content,
  });

  return [
    {
      name: "long-code-and-tables",
      markdown: longCode,
      expect: {
        minPages: 4,
        order: [
          "SECTION_CODE_START",
          "CODE_LINE_001",
          "CODE_LINE_160",
          "SHORT_1",
          "TABLE_ROW_001",
          "TABLE_ROW_090",
          "SECTION_AFTER_TABLE",
        ],
        all: [
          ...Array.from({ length: 160 }, (_, i) => `CODE_LINE_${pad(i + 1)}`),
          ...Array.from({ length: 90 }, (_, i) => `TABLE_ROW_${pad(i + 1)}`),
        ],
        splitAcrossPages: ["CODE_LINE_001", "CODE_LINE_160"],
        repeatedTableHeader: "Measurement",
        samePage: [["SHORT_1", "SHORT_6"]],
        outline: ["Long code and tables", "A short block stays together", "A long table"],
      },
    },
    {
      name: "math",
      markdown: math,
      expect: {
        order: ["MATH_INLINE_MARKER", "MATH_END_MARKER"],
        absent: ["$$", "\\int", "\\begin{aligned}"],
        blocks: { inlineMath: 2, displayMath: 3 },
        outline: ["Mathematics", "Aligned equations", "A matrix"],
      },
    },
    {
      name: "mermaid",
      markdown: mermaid,
      expect: {
        order: ["DIAGRAM_INTRO_MARKER", "Capture source", "Print PDF", "DIAGRAM_END_MARKER"],
        blocks: { diagrams: 3 },
        warnings: ["diagram-failed"],
        outline: ["Diagrams", "Sequence", "A diagram with a syntax error"],
      },
    },
    {
      name: "images",
      markdown: images,
      assets: [
        asset("image-0001", "gradient.png", { _tag: "captured", path: "assets/0001.png" }),
        asset("image-0002", "missing.png", { _tag: "unavailable", reason: "missing" }),
      ],
      files: { "assets/0001.png": png },
      warnings: [
        {
          code: "resource-unresolved",
          message: 'Image "figures/missing.png" was not found in the project.',
        },
      ],
      expect: {
        order: [
          "IMAGE_INTRO_MARKER",
          "Figure 1. A captured workspace image",
          "Image unavailable: missing.png",
          "Remote image not included",
          "IMAGE_END_MARKER",
          "Export notes",
        ],
        blocks: { images: 1 },
        warnings: ["remote-image-omitted"],
      },
    },
    {
      name: "hebrew-english",
      markdown: bidi,
      expect: {
        order: ["BIDI_START_MARKER", "Scient", "BIDI_END_MARKER"],
        hebrew: ["עברית", "שלום", "פריט"],
        outline: ["Mixed Hebrew and English"],
      },
    },
    {
      name: "headings-near-page-end",
      markdown: headings,
      expect: {
        minPages: 4,
        samePage: Array.from({ length: 30 }, (_, index) => [
          `HEADING_${pad(index + 1)}`,
          `PARA_AFTER_${pad(index + 1)}`,
        ]),
        order: ["HEADING_001", "PARA_AFTER_001", "HEADING_030", "PARA_AFTER_030"],
        outlineCount: 31,
      },
    },
    {
      name: "long-conversation",
      markdown: conversation,
      profile: "chat",
      documentKind: "conversation",
      expect: {
        minPages: 10,
        order: ["MESSAGE_001", "MESSAGE_002", "MESSAGE_060", "WORKLOG_060", "MESSAGE_120"],
        absent: ["scient:part"],
        all: Array.from({ length: 120 }, (_, i) => `MESSAGE_${pad(i + 1)}`),
        outlineCount: 121,
      },
    },
  ];
}

function pageInput(fixture) {
  const captureId = NodeCrypto.randomUUID();
  return {
    protocol: 1,
    captureId,
    documentKind: fixture.documentKind ?? "workspace-file",
    sourceDigest: sha256(fixture.markdown),
    profile: fixture.profile ?? "document",
    title: fixture.markdown.split("\n")[0].replace(/^#\s*/u, ""),
    language: null,
    direction: "auto",
    createdAt: null,
    markdown: fixture.markdown,
    assets: fixture.assets ?? [],
    warnings: fixture.warnings ?? [],
  };
}

async function withTimeout(promise, timeoutMs, describe) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(describe())), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  const { app, nativeImage } = electron;
  const state = process.env[STATE_ENV];
  NodeAssert.ok(state, `Missing ${STATE_ENV}`);
  app.setPath("userData", state);
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  if (process.env.SCIENT_DOCUMENT_PDF_FIXTURE_DEBUG === "1") {
    app.on("web-contents-created", (_event, contents) => {
      contents.on("console-message", (details) => console.log(`[page] ${details.message}`));
    });
  }
  const outDirectory =
    process.env[OUT_ENV] ?? NodePath.join(repoRoot, "build/document-pdf-fixtures");
  await NodeFSP.mkdir(outDirectory, { recursive: true });
  const webRoot = NodeURL.fileURLToPath(new URL("../../web/", import.meta.url));
  const webRequire = NodeModule.createRequire(new URL("../../web/package.json", import.meta.url));
  const serverRequire = NodeModule.createRequire(
    new URL("../../server/package.json", import.meta.url),
  );
  const captures = new Map();
  let server;
  let phase = "starting Vite";
  const report = [];
  try {
    const { createServer } = await import(webRequire.resolve("vite"));
    server = await createServer({
      configFile: false,
      root: webRoot,
      logLevel: "error",
      appType: "mpa",
      cacheDir: NodePath.join(state, "vite"),
      resolve: { alias: { "~": NodePath.join(webRoot, "src") } },
      server: { host: "127.0.0.1", port: 0, hmr: false },
      optimizeDeps: {
        include: ["mermaid", "katex", "react", "react-dom/client", "react-markdown"],
      },
      plugins: [
        {
          name: "scient-document-fixture-captures",
          configureServer(devServer) {
            // Stand-in for the server's signed capture route: one directory per token.
            devServer.middlewares.use("/api/assets", (request, response, next) => {
              const [, token, ...rest] = (request.url ?? "").split("?")[0].split("/");
              const capture = captures.get(token);
              const file = capture?.files[rest.join("/")];
              if (!file) return next();
              response.setHeader("Access-Control-Allow-Origin", "*");
              response.setHeader("Cache-Control", "no-store");
              response.setHeader(
                "Content-Type",
                rest.join("/").endsWith(".json") ? "application/json" : "image/png",
              );
              response.end(file);
            });
          },
        },
      ],
    });
    await withTimeout(server.listen(), 60_000, () => `Timed out while ${phase}`);
    const origin = new URL(server.resolvedUrls.local[0]).origin;

    phase = "waiting for Electron";
    await withTimeout(app.whenReady(), 30_000, () => `Timed out while ${phase}`);
    const { getDocument, GlobalWorkerOptions } = await import(
      serverRequire.resolve("pdfjs-dist/legacy/build/pdf.mjs")
    );
    GlobalWorkerOptions.workerSrc = serverRequire.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
    const { createDocumentPagePdfRenderer } =
      await import("../src/scient/documentExport/DocumentPagePdfRenderer.ts");
    const Effect = await import("effect/Effect");
    const render = createDocumentPagePdfRenderer({
      page: { scheme: SCHEME, files: { _tag: "development", targetOrigin: new URL(origin) } },
      fetchDevelopment: (url) => fetch(url),
    });

    const pixels = Buffer.alloc(320 * 180 * 4);
    for (let y = 0; y < 180; y += 1) {
      for (let x = 0; x < 320; x += 1) {
        const offset = (y * 320 + x) * 4;
        pixels[offset] = Math.round((x / 320) * 255);
        pixels[offset + 1] = Math.round((y / 180) * 255);
        pixels[offset + 2] = 160;
        pixels[offset + 3] = 255;
      }
    }
    const png = nativeImage.createFromBitmap(pixels, { width: 320, height: 180 }).toPNG();

    const register = (input, files = {}, rawInput) => {
      const token = `fixture-${NodeCrypto.randomUUID()}`;
      captures.set(token, {
        files: { "document.json": rawInput ?? JSON.stringify(input), ...files },
      });
      return `${origin}/api/assets/${token}/document.json`;
    };

    const extract = async (data) => {
      const loading = getDocument({ data, isEvalSupported: false });
      const pdf = await loading.promise;
      const pages = [];
      for (let number = 1; number <= pdf.numPages; number += 1) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
      }
      const flatten = (items, depth = 0) =>
        (items ?? []).flatMap((item) => [
          { title: item.title, depth },
          ...flatten(item.items, depth + 1),
        ]);
      const outline = flatten(await pdf.getOutline());
      const markInfo = await pdf.getMarkInfo();
      await loading.destroy();
      return { pages, outline, tagged: markInfo?.Marked === true };
    };

    for (const fixture of fixtures(png)) {
      phase = `rendering ${fixture.name}`;
      const input = pageInput(fixture);
      const inputUrl = register(input, fixture.files ?? {});
      const outcome = await withTimeout(
        Effect.runPromise(
          render({
            inputUrl,
            expected: {
              captureId: input.captureId,
              documentKind: input.documentKind,
              sourceDigest: input.sourceDigest,
            },
          }),
        ),
        120_000,
        () => `Timed out while ${phase}`,
      );
      NodeAssert.equal(
        outcome._tag,
        "rendered",
        `${fixture.name}: ${outcome._tag === "rejected" ? outcome.detail : ""}`,
      );
      const { artifact } = outcome;
      const outPath = NodePath.join(outDirectory, `${fixture.name}.pdf`);
      await NodeFSP.writeFile(outPath, artifact.data);
      const { pages, outline, tagged } = await extract(artifact.data);
      const text = pages.join("\n");
      const expectation = fixture.expect;
      NodeAssert.ok(tagged, `${fixture.name}: the PDF must be tagged`);
      NodeAssert.equal(artifact.readiness.status, "ready", fixture.name);
      NodeAssert.equal(artifact.blockedRequestCount, 0, `${fixture.name}: blocked requests`);
      if (expectation.minPages) {
        NodeAssert.ok(
          pages.length >= expectation.minPages,
          `${fixture.name}: expected at least ${expectation.minPages} pages, got ${pages.length}`,
        );
      }
      let cursor = -1;
      for (const marker of expectation.order ?? []) {
        const index = text.indexOf(marker, cursor + 1);
        NodeAssert.ok(index > cursor, `${fixture.name}: "${marker}" out of logical order`);
        cursor = index;
      }
      for (const marker of expectation.all ?? []) {
        NodeAssert.ok(text.includes(marker), `${fixture.name}: lost ${marker}`);
      }
      for (const marker of expectation.absent ?? []) {
        NodeAssert.ok(!text.includes(marker), `${fixture.name}: "${marker}" left unrendered`);
      }
      const pageOf = (marker) => pages.findIndex((page) => page.includes(marker));
      for (const [first, second] of expectation.samePage ?? []) {
        NodeAssert.equal(
          pageOf(first),
          pageOf(second),
          `${fixture.name}: ${first}/${second} split`,
        );
      }
      if (expectation.splitAcrossPages) {
        const [first, last] = expectation.splitAcrossPages;
        NodeAssert.ok(pageOf(last) > pageOf(first), `${fixture.name}: long block did not split`);
      }
      if (expectation.repeatedTableHeader) {
        const headerPages = pages.filter((page) => page.includes(expectation.repeatedTableHeader));
        NodeAssert.ok(headerPages.length >= 2, `${fixture.name}: table header did not repeat`);
      }
      for (const word of expectation.hebrew ?? []) {
        NodeAssert.ok(
          text.includes(word),
          `${fixture.name}: Hebrew "${word}" not in logical order`,
        );
      }
      for (const [key, count] of Object.entries(expectation.blocks ?? {})) {
        NodeAssert.equal(artifact.readiness.blocks[key], count, `${fixture.name}: ${key}`);
      }
      const warningCodes = artifact.readiness.diagnostics.map((diagnostic) => diagnostic.code);
      for (const code of expectation.warnings ?? []) {
        NodeAssert.ok(warningCodes.includes(code), `${fixture.name}: missing ${code} warning`);
      }
      for (const title of expectation.outline ?? []) {
        NodeAssert.ok(
          outline.some((entry) => entry.title === title),
          `${fixture.name}: bookmark "${title}" missing from ${JSON.stringify(outline)}`,
        );
      }
      if (expectation.outlineCount) {
        NodeAssert.equal(outline.length, expectation.outlineCount, `${fixture.name}: bookmarks`);
      }
      report.push({
        fixture: fixture.name,
        path: outPath,
        pages: pages.length,
        bookmarks: outline.length,
        tagged,
        warnings: warningCodes,
      });
      console.log(`PASS ${fixture.name}: ${pages.length} pages, ${outline.length} bookmarks`);
    }

    phase = "checking refusals";
    const stale = pageInput(fixtures(png)[1]);
    const staleOutcome = await Effect.runPromise(
      render({
        inputUrl: register(stale),
        expected: {
          captureId: stale.captureId,
          documentKind: stale.documentKind,
          sourceDigest: sha256("an older revision"),
        },
      }),
    );
    NodeAssert.equal(staleOutcome._tag, "rejected", "stale digest must be refused");
    NodeAssert.match(staleOutcome.detail, /different source revision/u);
    const wrongKind = await Effect.runPromise(
      render({
        inputUrl: register(stale),
        expected: {
          captureId: stale.captureId,
          documentKind: "conversation",
          sourceDigest: stale.sourceDigest,
        },
      }),
    );
    NodeAssert.equal(wrongKind._tag, "rejected", "wrong document kind must be refused");
    const invalid = await Effect.runPromise(
      render({
        inputUrl: register(null, {}, '{"protocol":1}'),
        expected: {
          captureId: stale.captureId,
          documentKind: stale.documentKind,
          sourceDigest: stale.sourceDigest,
        },
      }),
    );
    NodeAssert.equal(invalid._tag, "rejected", "an invalid capture must be refused");
    NodeAssert.match(invalid.detail, /not a valid Scient document page input/u);
    console.log("PASS refusals: stale digest, wrong kind, invalid capture");
    await NodeFSP.writeFile(
      NodePath.join(outDirectory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(`Fixture PDFs: ${outDirectory}`);
  } finally {
    if (server) await withTimeout(server.close(), 15_000, () => "Timed out closing Vite");
  }
}

void run().then(
  () => electron.app.exit(0),
  (error) => {
    console.error(error);
    electron.app.exit(1);
  },
);
