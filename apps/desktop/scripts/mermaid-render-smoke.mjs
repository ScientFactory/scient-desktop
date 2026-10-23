// Real Chromium regression test; no visible windows or user profile. On Linux use xvfb-run.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const STATE_ENV = "SCIENT_MERMAID_SMOKE_STATE";
const RENDERER_PROGRESS_PREFIX = "[scient-mermaid-smoke] ";
const RENDERER_CLICK_PREFIX = "[scient-mermaid-smoke-click] ";

if (!process.versions.electron) {
  // Electron's Node entry auto-downloads missing binaries. Qualification must
  // inspect installed files without importing it or invoking candidate launchers.
  const electronRoot = NodePath.dirname(
    NodeModule.createRequire(import.meta.url).resolve("electron/package.json"),
  );
  const pathFile = NodePath.join(electronRoot, "path.txt");
  NodeAssert.ok(
    NodeFS.existsSync(pathFile),
    "Repository Electron runtime is not installed (missing path.txt); prepare it independently before running this gate.",
  );
  const electron = NodePath.resolve(
    electronRoot,
    "dist",
    NodeFS.readFileSync(pathFile, "utf8").trim(),
  );
  NodeAssert.ok(
    electron.startsWith(`${NodePath.join(electronRoot, "dist")}${NodePath.sep}`) &&
      NodeFS.existsSync(electron),
    "Repository Electron executable is missing or outside its installed dist directory.",
  );
  const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-mermaid-smoke-"));
  const environment = Object.fromEntries(
    ["PATH", "SystemRoot", "WINDIR", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "LANG"]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]]),
  );
  Object.assign(environment, {
    [STATE_ENV]: state,
    HOME: NodePath.join(state, "home"),
    USERPROFILE: NodePath.join(state, "home"),
    XDG_CONFIG_HOME: NodePath.join(state, "config"),
    XDG_CACHE_HOME: NodePath.join(state, "cache"),
    TMPDIR: state,
    TMP: state,
    TEMP: state,
  });
  NodeFS.mkdirSync(environment.HOME);
  let result;
  try {
    result = NodeChildProcess.spawnSync(electron, [NodeURL.fileURLToPath(import.meta.url)], {
      env: environment,
      stdio: "inherit",
      timeout: 420_000,
      killSignal: "SIGTERM",
    });
  } finally {
    // Vite and Electron own files in userData until the child is gone. Keeping
    // profile cleanup in the parent prevents races with Electron shutdown.
    NodeFS.rmSync(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

async function withTimeout(promise, timeoutMs, describeTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(describeTimeout())), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function run() {
  const { app, BrowserWindow } = NodeModule.createRequire(import.meta.url)("electron");
  const state = process.env[STATE_ENV];
  NodeAssert.ok(state, `Missing ${STATE_ENV}`);
  app.setPath("userData", state);
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  const webRoot = NodeURL.fileURLToPath(new URL("../../web/", import.meta.url));
  const webRequire = NodeModule.createRequire(new URL("../../web/package.json", import.meta.url));
  let server;
  let window;
  let phase = "starting Vite";
  try {
    const { createServer } = await import(webRequire.resolve("vite"));
    server = await createServer({
      configFile: false,
      envFile: false,
      root: webRoot,
      logLevel: "error",
      appType: "custom",
      cacheDir: NodePath.join(state, "vite"),
      resolve: { alias: { "~": NodePath.join(webRoot, "src") } },
      server: { host: "127.0.0.1", port: 0 },
      optimizeDeps: { include: ["pele/lazy", "dompurify", "react", "react/jsx-runtime"] },
      plugins: [
        {
          name: "scient-smoke-parser",
          resolveId: (id) => (id === "/__scient_pele_parser.js" ? id : null),
          load: (id) =>
            id === "/__scient_pele_parser.js"
              ? 'export { load, detectType, parse } from "pele/lazy";'
              : null,
        },
      ],
    });
    server.middlewares.use("/__mermaid_smoke", (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<!doctype html><html><head><title>Mermaid regression</title></head><body></body></html>",
      );
    });
    await withTimeout(server.listen(), 45_000, () => `Timed out while ${phase}`);
    phase = "loading the Mermaid fixture corpus";
    const markdown = await NodeFSP.readFile(
      new URL("../../../docs/fixtures/scient-chat-diagrams.md", import.meta.url),
      "utf8",
    );
    const fixtures = [...markdown.matchAll(/^```mermaid[^\n]*\n([\s\S]*?)^```/gm)].map(
      (match) => match[1],
    );
    NodeAssert.ok(fixtures.length >= 15, "Fixture corpus must not silently disappear");
    phase = "waiting for Electron";
    await withTimeout(app.whenReady(), 30_000, () => `Timed out while ${phase}`);
    phase = "creating the Chromium renderer";
    window = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const blockedRequests = [];
    const origin = new URL(server.resolvedUrls.local[0]);
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const local = ["http:", "ws:"].includes(url.protocol) && url.host === origin.host;
      const cancel =
        details.url.includes("__scient_native_diagram_probe__") ||
        (!local && !["blob:", "data:"].includes(url.protocol));
      if (cancel) blockedRequests.push(details.url);
      callback({ cancel });
    });
    window.webContents.on("console-message", (details) => {
      const message = details.message;
      if (typeof message === "string" && message.startsWith(RENDERER_PROGRESS_PREFIX))
        phase = message.slice(RENDERER_PROGRESS_PREFIX.length);
      if (typeof message === "string" && message.startsWith(RENDERER_CLICK_PREFIX)) {
        const { x, y } = JSON.parse(message.slice(RENDERER_CLICK_PREFIX.length));
        NodeAssert.ok(Number.isInteger(x) && Number.isInteger(y), "Invalid node input point");
        window.webContents.sendInputEvent({ type: "mouseMove", x, y });
        window.webContents.sendInputEvent({
          type: "mouseDown",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        window.webContents.sendInputEvent({
          type: "mouseUp",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      }
    });
    await withTimeout(
      window.loadURL(`${server.resolvedUrls.local[0]}__mermaid_smoke`),
      30_000,
      () => `Timed out while ${phase}`,
    );
    phase = "starting renderer assertions";
    const rendererPromise = window.webContents.executeJavaScript(
      `(${async function (sources, progressPrefix, clickPrefix) {
        const progress = (message) => console.info(`${progressPrefix}${message}`);
        progress("loading renderer modules");
        const { renderMermaidDiagram, MermaidRenderError, MERMAID_RENDERER } =
          await import("/src/scient/diagrams/mermaidRuntime.ts");
        const pele = await import("/__scient_pele_parser.js");
        async function parse(source) {
          await pele.load(pele.detectType(source));
          return pele.parse(source, { limit: 50_000, maxEdges: 500 });
        }
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
        progress("checking native failures and queue recovery");
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
            progress(`rendering native corpus ${theme}/${index + 1}/${sources.length - 2}`);
            const { svg, diagramType } = await renderMermaidDiagram(source, theme);
            // Match the card's HTML insertion; standalone XML is checked separately.
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
            check(
              !exported.querySelector("parsererror"),
              `Invalid standalone SVG export: ${theme}/${index}`,
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
        progress("checking concurrent native cache consumers");
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
        check(
          document.body.childElementCount === 0 && !document.querySelector("iframe"),
          "Snapshot measuring hosts or retired renderer frames leaked",
        );
        const { recoveryFixtures, unrecoverableFixtures, userRegressionFixtures } =
          await import("/src/scient/diagrams/mermaidRecovery.fixtures.ts");
        const { planMermaidRecovery } = await import("/src/scient/diagrams/mermaidRecovery.ts");
        const recoveryTimings = [];
        progress("checking user regression fixtures");
        for (const theme of ["light", "dark"]) {
          for (const fixture of userRegressionFixtures) {
            let result;
            let failure;
            try {
              result = await renderMermaidDiagram(fixture.source, theme);
            } catch (error) {
              failure = error;
            }
            const status = failure ? "error" : result.recovery ? "recovered" : "native";
            check(
              status === fixture.status,
              `User regression: ${fixture.name}/${theme}: ${status}`,
            );
            if (status === "recovered")
              check(
                result.recovery.source ===
                  fixture.source.replace("branchz feature", "branch feature"),
                "Git recovery changed more than the command typo",
              );
          }
        }
        progress("checking qualified recovery fixtures");
        for (const theme of ["light", "dark"]) {
          for (const fixture of recoveryFixtures) {
            progress(`recovering ${fixture.name}/${theme}`);
            const start = performance.now();
            let rendered;
            try {
              rendered = await renderMermaidDiagram(fixture.source, theme);
            } catch (error) {
              try {
                await parse(fixture.expected);
              } catch (candidateError) {
                throw new Error(
                  `${fixture.name}/${theme} candidate failed: ${candidateError.message}`,
                  { cause: candidateError },
                );
              }
              throw new Error(`${fixture.name}/${theme}: ${error.details ?? error.message}`, {
                cause: error,
              });
            }
            check(
              rendered.recovery?.source === fixture.expected,
              `Recovery mismatch: ${fixture.name}/${theme}`,
            );
            check(
              rendered.recovery.originalSource === fixture.source,
              "Recovery lost original source",
            );
            const svg = new DOMParser()
              .parseFromString(rendered.svg, "text/html")
              .querySelector("svg");
            const bounds = svg?.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
            check(
              bounds?.length === 4 &&
                bounds.every(Number.isFinite) &&
                bounds[2] > 0 &&
                bounds[3] > 0,
              `Invalid recovered SVG: ${fixture.name}`,
            );
            check(!svg.querySelector("script"), "Recovered SVG lost strict sanitization");
            recoveryTimings.push({
              name: fixture.name,
              theme,
              ms: Math.round(performance.now() - start),
            });
            const native = await renderMermaidDiagram(fixture.expected, theme);
            check(!native.recovery, `Already corrected source was changed: ${fixture.name}`);
            check(
              rendered.diagramType === native.diagramType,
              "Recovery changed the diagram family",
            );
            if (fixture.shape) {
              const diagram = await parse(rendered.recovery.source);
              const node = diagram.nodes.get("A");
              check(
                node.type === fixture.shape && node.text === fixture.label,
                `Recovery changed shape or text: ${fixture.name}`,
              );
            }
            if (["nested literal quotes", "escaped literal quotes"].includes(fixture.name)) {
              check(
                svg.textContent.includes('Click "Save" now'),
                "Recovered quotes changed the visible label",
              );
            }
            if (["parallel node expression", "edge ID expression"].includes(fixture.name)) {
              const diagram = await parse(fixture.expected);
              const edges = diagram.edges;
              if (fixture.name === "parallel node expression") {
                check(
                  JSON.stringify(edges.map(({ start, end }) => [start, end])) ===
                    JSON.stringify([
                      ["A", "C"],
                      ["B", "C"],
                    ]),
                  "Recovery changed parallel graph connectivity",
                );
              } else
                check(
                  edges.length === 1 &&
                    edges[0].id === "e1" &&
                    edges[0].start === "A" &&
                    edges[0].end === "B",
                  "Recovery lost named edge identity",
                );
            }
            if (fixture.name === "class short arrow") {
              const diagram = await parse(fixture.expected);
              const relations = diagram.relations;
              check(
                relations.length === 1 && relations[0].id1 === "A" && relations[0].id2 === "B",
                "Class recovery changed relation endpoints",
              );
            }
            if (fixture.name === "sequence fullwidth colon") {
              const diagram = await parse(fixture.expected);
              const messages = diagram.messages;
              check(
                messages.length === 1 &&
                  messages[0].from === "A" &&
                  messages[0].to === "B" &&
                  messages[0].message === "Hello",
                "Sequence recovery changed message routing or content",
              );
            }
            if (fixture.name === "pie spaced label") {
              const diagram = await parse(fixture.expected);
              const values = diagram.sections;
              check(
                values.size === 2 &&
                  values.get("Small dogs") === 10 &&
                  values.get("Big cats") === 20,
                "Pie recovery changed labels or values",
              );
            }
            if (fixture.name === "pie dash separator") {
              const diagram = await parse(fixture.expected);
              const values = diagram.sections;
              check(
                values.size === 3 &&
                  values.get("Dogs") === 40 &&
                  values.get("Cats") === 35 &&
                  values.get("Birds") === 25,
                "Pie dash recovery changed labels or values",
              );
            }
          }
        }
        progress("checking deliberately unrecoverable fixtures");
        for (const source of unrecoverableFixtures) {
          let error;
          try {
            await renderMermaidDiagram(source, "light");
          } catch (cause) {
            error = cause;
          }
          check(error instanceof Error, `Ambiguous source unexpectedly recovered: ${source}`);
          if (source.startsWith("flowchart LR\nN0 -> N1"))
            check(
              error.cause?.code === "syntax",
              "Candidate resource failure replaced the original syntax diagnostic",
            );
        }
        // Each correction alone still fails. Success requires the full plan.
        const combined = recoveryFixtures.find(
          (fixture) => fixture.name === "multiple independent issues",
        );
        const plan = planMermaidRecovery(combined.source);
        for (const change of plan.edits) {
          const partial =
            combined.source.slice(0, change.start) +
            change.replacement +
            combined.source.slice(change.end);
          let failure;
          try {
            await parse(partial);
          } catch (error) {
            failure = error;
          }
          check(
            failure?.code === "syntax",
            "Combined fixture no longer proves multiple required fixes",
          );
        }
        const literal = await parse("flowchart LR\nA[Use -> operator] --> B");
        check(
          literal.nodes.get("A").text === "Use -> operator",
          "Recovery changed a literal operator",
        );
        const styled = await parse(
          recoveryFixtures.find((fixture) => fixture.name === "comments and styles").expected,
        );
        check(styled.nodes.get("B").text === "C4Context", "Recovery renamed an unrelated label");
        check(styled.nodes.get("A").text === "Read (local)", "Quoting changed label text");
        const pie = await parse(
          recoveryFixtures.find((fixture) => fixture.name === "pie Unicode").expected,
        );
        check(pie.sections.get("שלום（עולם）") === 10, "Recovery changed Unicode label or value");
        const recoveryCopies = await Promise.all(
          Array.from({ length: 48 }, (_, index) =>
            renderMermaidDiagram(combined.source, index % 2 ? "light" : "dark"),
          ),
        );
        check(
          new Set(recoveryCopies.map((copy) => copy.svg)).size === 48,
          "Recovered cache reused DOM IDs",
        );
        const scanStart = performance.now();
        progress("checking bounded recovery scanning");
        const stressSource =
          "flowchart LR\n" + "A[Read (local)] -> B\n".repeat(120) + "%% " + "x".repeat(45_000);
        const stressPlan = JSON.stringify(planMermaidRecovery(stressSource));
        for (let iteration = 0; iteration < 200; iteration += 1)
          check(
            JSON.stringify(planMermaidRecovery(stressSource)) === stressPlan,
            "Bounded recovery scanning changed its deterministic plan",
          );
        check(
          planMermaidRecovery("flowchart LR\n" + "A -> B\n".repeat(257)) === null &&
            planMermaidRecovery(stressSource + "x".repeat(50_000)) === null,
          "Recovery edit/source bounds were lost",
        );
        const scanMs = performance.now() - scanStart;
        check(pngFailures.length === 0, `PNG export failed: ${pngFailures.join("; ")}`);
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
        progress("checking native resource refusal and cleanup");
        const probe = "/__scient_native_diagram_probe__/";
        const hostileSources = [
          `flowchart LR\nA["<img src='${probe}label.png'>"] --> B`,
          `flowchart LR\nA@{ img: "${probe}shape.png", h: 40 } --> B`,
          `sequenceDiagram\nparticipant A\nproperties A: {"icon":"${probe}actor.png"}\nA->>A: hi`,
          `flowchart LR\nA["<span style='background:url(${probe}style.png)'>text</span>"] --> B`,
          `stateDiagram-v2\nclassDef c background-image:url(${probe}state.png)\n[*] --> A:::c`,
          `%%{init: {"themeCSS":"@font-face{src:url(${probe}font.woff2)}"}}%%\nflowchart LR\nA --> B`,
          `flowchart LR\nA["<svg><path mask='url(${probe}mask.svg)'/></svg>"] --> B`,
        ];
        for (const theme of ["light", "dark"]) {
          for (const source of [
            `flowchart LR\nA["icon: 'https://example.org/reference'"] --> B`,
            `flowchart LR\n%% A@{ img: 'https://example.org/reference' }\nA["favicon: 'https://example.org/reference'"] --> B`,
          ]) {
            const result = await renderMermaidDiagram(source, theme);
            check(!result.blocked?.length, "Inert prose produced a false resource refusal");
            await copyMermaidPng(result.svg, theme);
          }
          for (const source of hostileSources) {
            const result = await renderMermaidDiagram(source, theme);
            check(result.blocked?.length > 0, "Authored resource lost its refusal notice");
            check(!result.svg.includes(probe), "Authored resource survived the snapshot");
            await copyMermaidPng(result.svg, theme);
          }
          const math = await renderMermaidDiagram(
            "sequenceDiagram\nA->>B: $$\\frac{1}{2} + \\sqrt{2}$$",
            theme,
          );
          const mathNode = new DOMParser().parseFromString(math.svg, "text/html");
          check(mathNode.querySelector("math mfrac, math msqrt"), "Generated MathML was lost");
          await copyMermaidPng(math.svg, theme);
        }
        let callbacks = 0;
        window.scientNativeDiagramCallback = () => {
          callbacks += 1;
        };
        const active = await renderMermaidDiagram(
          '%%{init: {"securityLevel":"loose","startOnLoad":true}}%%\nflowchart LR\nA["Authored callback target"] --> B["<math href=\'javascript:alert(1)\'><mi onclick=\'alert(1)\'>x</mi></math>"]\nclick A scientNativeDiagramCallback',
          "light",
        );
        const holder = document.createElement("div");
        try {
          holder.innerHTML = active.svg;
          document.body.append(holder);
          check(
            !holder.querySelector("script, style, a, img, image, [href], [onclick], [onerror]"),
            "Active content survived strict rendering",
          );
          const target = [...holder.querySelectorAll(".pele-node")].find(
            (node) => node.querySelector(".pele-label")?.textContent === "Authored callback target",
          );
          check(target, "The authored A node is missing");
          window.scientNativeDiagramCallback();
          check(callbacks === 1, "Callback positive control did not run");
          callbacks = 0;
          target.scrollIntoView({ block: "center", inline: "center" });
          const bounds = target.getBoundingClientRect();
          const point = {
            x: Math.round(bounds.x + bounds.width / 2),
            y: Math.round(bounds.y + bounds.height / 2),
          };
          check(
            bounds.width > 0 &&
              bounds.height > 0 &&
              point.x >= 0 &&
              point.x < innerWidth &&
              point.y >= 0 &&
              point.y < innerHeight,
            "The authored A node must have a visible native input target",
          );
          progress("checking calibrated native input on the authored A node");
          const click = await new Promise((resolve) => {
            target.addEventListener("click", resolve, { once: true });
            // Electron, not renderer dispatchEvent, supplies a trusted input event.
            console.info(`${clickPrefix}${JSON.stringify(point)}`);
          });
          check(
            click.isTrusted && target.contains(click.target),
            "Native input did not reach the authored A node",
          );
          check(callbacks === 0, "Diagram-authored callback executed");
          const unrelated = document.createElement("pre");
          unrelated.className = "mermaid";
          unrelated.textContent = "flowchart LR\nUnrelated --> Source";
          holder.append(unrelated);
          check(!unrelated.querySelector("svg"), "Renderer processed unrelated page content");
        } finally {
          holder.remove();
          delete window.scientNativeDiagramCallback;
        }
        check(
          document.body.childElementCount === 0,
          "Snapshot mounts, math measurement probes or error DOM leaked",
        );
        progress("renderer assertions complete");
        return {
          renderer: MERMAID_RENDERER,
          fixtures: output,
          concurrentCopies: copies.length,
          pngFailures,
          resourceRefusals: hostileSources.length * 2,
          callbackInteraction: {
            target: "A / Authored callback target",
            trustedNativeInput: true,
            callbackPositiveControl: true,
            authoredCallbackCalls: callbacks,
          },
          cleanup: true,
          recovery: {
            fixtures: recoveryTimings,
            declined: unrecoverableFixtures.length,
            concurrentCopies: recoveryCopies.length,
            scans: 200,
            scanMs: Math.round(scanMs),
          },
        };
      }.toString()})(${JSON.stringify(fixtures)}, ${JSON.stringify(RENDERER_PROGRESS_PREFIX)}, ${JSON.stringify(RENDERER_CLICK_PREFIX)})`,
    );
    const results = await withTimeout(
      rendererPromise,
      240_000,
      () => `Chromium Mermaid smoke test timed out while ${phase}`,
    );
    NodeAssert.deepEqual(blockedRequests, [], "Diagram rendering attempted a resource request");
    console.log(JSON.stringify(results, null, 2));
  } finally {
    phase = "closing the Chromium renderer";
    window?.destroy();
    if (server)
      await withTimeout(server.close(), 15_000, () => `Timed out while closing the Vite server`);
  }
}

void run().then(
  () => NodeModule.createRequire(import.meta.url)("electron").app.exit(0),
  (error) => {
    console.error(error);
    NodeModule.createRequire(import.meta.url)("electron").app.exit(1);
  },
);
