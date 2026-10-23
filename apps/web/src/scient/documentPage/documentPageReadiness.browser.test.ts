import { fakeTimers } from "../../../test/render";
import {
  scientDocumentReadinessRejection,
  ScientDocumentPageReadiness,
  type ScientDocumentPageInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  collectDocumentPageReadiness,
  DocumentPageTracker,
  failedDocumentPageReadiness,
  renderWithCompleteNotes,
  resolveInternalLinks,
} from "./documentPageReadiness";
import {
  DocumentPageInputError,
  loadDocumentPageInput,
  readDocumentPageInputUrl,
} from "./documentPageInput";
import { cssStringLiteral, runningHeaderCss } from "./documentPageSetup";

const page = {
  protocol: 1,
  captureId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  documentKind: "workspace-file",
  sourceDigest: `sha256:${"a".repeat(64)}`,
  profile: "document",
  title: "Report",
  language: null,
  direction: "auto",
  createdAt: null,
  markdown: "# Report\n",
  assets: [],
  warnings: [],
} satisfies ScientDocumentPageInput;

/** A FontFaceSet stand-in: `ready` resolves and `status` is "loaded" even when a face failed. */
const isReadiness = Schema.is(ScientDocumentPageReadiness);

const fonts = (...faces: ReadonlyArray<{ family: string; status: string }>) =>
  Object.assign(faces, { ready: Promise.resolve(), status: "loaded" });

async function _setupFixture0(_fixture: _Fixture) {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: fonts(
      { family: "KaTeX_Main", status: "loaded" },
      { family: "Unused", status: "unloaded" },
    ),
  });
}

async function _cleanupFixture1(_fixture: _Fixture) {
  vi.unstubAllGlobals();
  _clearOwnedDOM(_fixture);
}

function article(_fixture: _Fixture, html: string) {
  const element = document.createElement("article");
  element.innerHTML = html;
  document.body.append(_ownDOM(_fixture, element));
  return element;
}

describe("document page tracker", () => {
  it("settles only after all tracked work, including work added later, finishes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    using _timers = fakeTimers();
    const tracker = new DocumentPageTracker();
    const first = tracker.track();
    let settled = false;
    const settling = tracker.settle(5_000).then((result) => {
      settled = result;
    });
    await vi.advanceTimersByTimeAsync(32);
    const second = tracker.track();
    first();
    await vi.advanceTimersByTimeAsync(32);
    expect(settled).toBe(false);
    second();
    await vi.advanceTimersByTimeAsync(32);
    await settling;
    expect(settled).toBe(true);
  });

  it("reports unfinished work at the deadline and de-duplicates diagnostics", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    using _timers = fakeTimers();
    const tracker = new DocumentPageTracker();
    tracker.track();
    const settling = tracker.settle(20);
    await vi.advanceTimersByTimeAsync(32);
    expect(await settling).toBe(false);
    tracker.warn("missing-image", "Same");
    tracker.warn("missing-image", "Same");
    expect(tracker.diagnostics).toHaveLength(1);
  });
});

describe("document page diagnostics limit", () => {
  it("never loses a fatal diagnostic behind many warnings", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const tracker = new DocumentPageTracker();
    for (let index = 0; index < 300; index += 1) {
      tracker.warn("missing-image", `Image ${index} is missing.`);
    }
    tracker.fatal("diagram-incomplete", "Mermaid failed while rendering a diagram.");
    const diagnostics = tracker.diagnostics;
    expect(diagnostics).toHaveLength(256);
    expect(diagnostics[0]).toEqual({
      severity: "fatal",
      code: "diagram-incomplete",
      detail: "Mermaid failed while rendering a diagram.",
    });
    expect(diagnostics.at(-1)?.detail).toBe("46 more limitations were found and are not listed.");
    const readiness = await collectDocumentPageReadiness({
      page,
      article: article(_fixture, "<p>Body</p>"),
      tracker,
      settled: true,
    });
    expect(readiness.status).toBe("failed");
    expect(readiness.diagnostics).toHaveLength(256);
    // The report still fits the contract the desktop decodes.
    expect(isReadiness(readiness)).toBe(true);
    expect(
      scientDocumentReadinessRejection(readiness, {
        captureId: page.captureId,
        documentKind: page.documentKind,
        sourceDigest: page.sourceDigest,
      }),
    ).toBe("Mermaid failed while rendering a diagram.");
  });
});

describe("document page readiness", () => {
  it("reports a finished page as ready with its identity and structure", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const readiness = await collectDocumentPageReadiness({
      page,
      article: article(
        _fixture,
        "<h1>Report</h1><p>Body</p><div data-scient-diagram='rendered'></div>",
      ),
      tracker: new DocumentPageTracker(),
      settled: true,
    });
    expect(readiness).toMatchObject({
      status: "ready",
      captureId: page.captureId,
      documentKind: "workspace-file",
      sourceDigest: page.sourceDigest,
      settled: { fonts: true, math: true, diagrams: true, images: true },
      blocks: { headings: 1, paragraphs: 1, diagrams: 1 },
      diagnostics: [],
    });
  });

  it("fails for unfinished diagrams, unloaded captured images, fonts, and timeouts", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts({ family: "KaTeX_Main", status: "loading" }),
    });
    const element = article(
      _fixture,
      "<div data-scient-diagram='pending'></div><img data-scient-asset='image-0001' alt='plot'>",
    );
    const image = element.querySelector("img")!;
    expect(image.complete).toBe(true);
    expect(image.naturalWidth).toBe(0);
    const readiness = await collectDocumentPageReadiness({
      page,
      article: element,
      tracker: new DocumentPageTracker(),
      settled: false,
    });
    expect(readiness.status).toBe("failed");
    expect(readiness.unresolvedAssets).toEqual(["image-0001"]);
    expect(readiness.settled).toEqual({ fonts: false, math: true, diagrams: false, images: true });
    expect(readiness.diagnostics.map((diagnostic) => diagnostic.code).toSorted()).toEqual([
      "diagram-incomplete",
      "fonts-unsettled",
      "render-crashed",
      "resource-unresolved",
    ]);
  });

  it("fails for a shown captured image that was never checked against its digest", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const element = article(_fixture, "<img data-scient-asset='image-0001' alt='plot'>");
    const image = element.querySelector("img")!;
    image.src = new URL("/test/fixtures/assets/0001.png", window.location.href).href;
    await image.decode();
    expect(image.naturalWidth).toBe(16);
    const withCapturedImage = {
      ...page,
      assets: [
        {
          id: "image-0001",
          role: "image",
          fileName: "plot.png",
          mediaType: "image/png",
          content: {
            _tag: "captured",
            path: "assets/0001.png",
            sha256: `sha256:${"c".repeat(64)}`,
          },
        },
      ],
    } satisfies ScientDocumentPageInput;
    const unchecked = await collectDocumentPageReadiness({
      page: withCapturedImage,
      article: element,
      tracker: new DocumentPageTracker(),
      settled: true,
    });
    expect(unchecked.status).toBe("failed");
    expect(unchecked.diagnostics).toEqual([
      {
        severity: "fatal",
        code: "resource-unresolved",
        detail: 'The captured image "plot.png" was not checked against the capture.',
      },
    ]);
    const checked = new DocumentPageTracker();
    checked.verifiedAssets.add("image-0001");
    expect(
      (
        await collectDocumentPageReadiness({
          page: withCapturedImage,
          article: element,
          tracker: checked,
          settled: true,
        })
      ).status,
    ).toBe("ready");
  });

  it("fails when a font the page used could not load, although fonts.ready resolved", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts(
        { family: "KaTeX_Math", status: "error" },
        { family: "Inter", status: "loaded" },
      ),
    });
    const readiness = await collectDocumentPageReadiness({
      page,
      article: article(_fixture, "<p>$x$</p>"),
      tracker: new DocumentPageTracker(),
      settled: true,
    });
    expect(readiness.status).toBe("failed");
    expect(readiness.settled.fonts).toBe(false);
    expect(readiness.diagnostics).toEqual([
      {
        severity: "fatal",
        code: "fonts-unsettled",
        detail: 'The font "KaTeX_Math" failed to load.',
      },
    ]);
  });

  it("describes a page that never rendered its input", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const tracker = new DocumentPageTracker();
    tracker.fatal("input-invalid", "Not a page input.");
    expect(failedDocumentPageReadiness(tracker, null)).toMatchObject({
      status: "failed",
      captureId: null,
      documentKind: null,
      sourceDigest: null,
      diagnostics: [{ severity: "fatal", code: "input-invalid" }],
    });
  });

  it("points in-document links at the ids the sanitizer emitted", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const element = article(
      _fixture,
      "<a href='#fn-1'>1</a><a href='#missing'>x</a><li id='user-content-fn-1'></li>",
    );
    resolveInternalLinks(element);
    const [first, second] = element.querySelectorAll("a");
    expect(first?.getAttribute("href")).toBe("#user-content-fn-1");
    expect(second?.getAttribute("href")).toBe("#missing");
  });

  it("keeps malformed fragment links as written and still reports the page ready", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const element = article(
      _fixture,
      [
        "<a href='#%ZZ'>jump</a>",
        "<a href='#%E0%A4%A'>cut</a>",
        "<a href='#caf%C3%A9'>café</a>",
        "<a href='#50%25'>half</a>",
        "<h2 id='user-content-café'>Café</h2>",
        "<h2 id='user-content-%ZZ'>Raw</h2>",
      ].join(""),
    );
    const readiness = await collectDocumentPageReadiness({
      page,
      article: element,
      tracker: new DocumentPageTracker(),
      settled: true,
    });
    expect(readiness.status).toBe("ready");
    expect(readiness.diagnostics).toEqual([]);
    expect(Array.from(element.querySelectorAll("a"), (link) => link.getAttribute("href"))).toEqual(
      // A fragment that is not valid encoding is compared as written.
      ["#user-content-%ZZ", "#%E0%A4%A", "#user-content-café", "#50%25"],
    );
  });
});

describe("printed export notes", () => {
  const readinessWith = (notes: ReadonlyArray<string>) =>
    ({
      ...failedDocumentPageReadiness(new DocumentPageTracker(), page),
      status: "ready",
      diagnostics: notes.map((detail) => ({
        severity: "warning" as const,
        code: "missing-image" as const,
        detail,
      })),
    }) as const;

  it("re-renders until the notes list what the final inspection found", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const rendered: Array<ReadonlyArray<string>> = [];
    const inspections = [["Found while rendering."], ["Found while rendering.", "Found last."]];
    let pass = 0;
    using _timers = fakeTimers();
    const rendering = renderWithCompleteNotes({
      render: (notes) => rendered.push(notes),
      tracker: new DocumentPageTracker(),
      inspect: async () => readinessWith(inspections[Math.min(pass++, 1)]!),
    });
    await vi.runAllTimersAsync();
    const readiness = await rendering;
    expect(rendered).toEqual([
      [],
      ["Found while rendering."],
      ["Found while rendering.", "Found last."],
    ]);
    expect(readiness.status).toBe("ready");
  });

  it("refuses a page whose notes never settle", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let pass = 0;
    const tracker = new DocumentPageTracker();
    using _timers = fakeTimers();
    const rendering = renderWithCompleteNotes({
      render: () => undefined,
      tracker,
      inspect: async () => readinessWith([`Note ${pass++}`]),
    });
    await vi.runAllTimersAsync();
    const readiness = await rendering;
    expect(readiness.status).toBe("failed");
    expect(readiness.diagnostics).toEqual([
      expect.objectContaining({ severity: "fatal", code: "render-crashed" }),
    ]);
  });
});

describe("document page input", () => {
  const inputUrl = "https://environment.test/api/assets/token/document.json";

  it("reads the capture URL from the fragment and nowhere else", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    // The desktop builds this fragment; see DocumentPagePdfRenderer.documentPageUrl.
    const hash = `#input=${encodeURIComponent(inputUrl)}`;
    expect(readDocumentPageInputUrl(hash).href).toBe(inputUrl);
    for (const hash of [
      "",
      "#input=",
      `#input=${encodeURIComponent("file:///etc/document.json")}`,
      `#input=${encodeURIComponent("https://environment.test/api/assets/token/other.json")}`,
    ]) {
      expect(() => readDocumentPageInputUrl(hash)).toThrow(DocumentPageInputError);
    }
  });

  it("classifies unavailable and invalid captures", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const url = new URL(inputUrl);
    await expect(
      loadDocumentPageInput(url, async () => new Response(null, { status: 404 })),
    ).rejects.toMatchObject({ code: "input-unavailable" });
    await expect(
      loadDocumentPageInput(url, async () => Response.json({ protocol: 1 })),
    ).rejects.toMatchObject({ code: "input-invalid" });
    await expect(
      loadDocumentPageInput(url, async () => {
        throw new TypeError("network");
      }),
    ).rejects.toMatchObject({ code: "input-unavailable" });
    const fetchInput = vi.fn(async () => Response.json(page));
    expect(await loadDocumentPageInput(url, fetchInput)).toEqual(page);
    expect(fetchInput).toHaveBeenCalledWith(url, { credentials: "omit", cache: "no-store" });
  });
});

describe("document page running header", () => {
  it("escapes the title into the page margin box and truncates long titles", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(cssStringLiteral('A "quoted" \\ title\nnext')).toBe('"A \\"quoted\\" \\\\ title next"');
    const css = runningHeaderCss("x".repeat(200));
    expect(css).toContain(`"${"x".repeat(89)}…"`);
    expect(css).toContain("@page :first { @top-center { content: none; } }");
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
