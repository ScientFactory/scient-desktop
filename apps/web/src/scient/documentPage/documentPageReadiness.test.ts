// @vitest-environment happy-dom
import type { ScientDocumentPageInput } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
const fonts = (...faces: ReadonlyArray<{ family: string; status: string }>) =>
  Object.assign(faces, { ready: Promise.resolve(), status: "loaded" });

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: fonts(
      { family: "KaTeX_Main", status: "loaded" },
      { family: "Unused", status: "unloaded" },
    ),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function article(html: string) {
  const element = document.createElement("article");
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

describe("document page tracker", () => {
  it("settles only after all tracked work, including work added later, finishes", async () => {
    const tracker = new DocumentPageTracker();
    const first = tracker.track();
    let settled = false;
    const settling = tracker.settle(5_000).then((result) => {
      settled = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = tracker.track();
    first();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    second();
    await settling;
    expect(settled).toBe(true);
  });

  it("reports unfinished work at the deadline and de-duplicates diagnostics", async () => {
    const tracker = new DocumentPageTracker();
    tracker.track();
    expect(await tracker.settle(20)).toBe(false);
    tracker.warn("missing-image", "Same");
    tracker.warn("missing-image", "Same");
    expect(tracker.diagnostics).toHaveLength(1);
  });
});

describe("document page readiness", () => {
  it("reports a finished page as ready with its identity and structure", async () => {
    const readiness = await collectDocumentPageReadiness({
      page,
      article: article("<h1>Report</h1><p>Body</p><div data-scient-diagram='rendered'></div>"),
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
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts({ family: "KaTeX_Main", status: "loading" }),
    });
    const element = article(
      "<div data-scient-diagram='pending'></div><img data-scient-asset='image-0001' alt='plot'>",
    );
    const image = element.querySelector("img")!;
    Object.defineProperty(image, "complete", { value: true });
    Object.defineProperty(image, "naturalWidth", { value: 0 });
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

  it("fails when a font the page used could not load, although fonts.ready resolved", async () => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fonts(
        { family: "KaTeX_Math", status: "error" },
        { family: "Inter", status: "loaded" },
      ),
    });
    const readiness = await collectDocumentPageReadiness({
      page,
      article: article("<p>$x$</p>"),
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

  it("describes a page that never rendered its input", () => {
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

  it("points in-document links at the ids the sanitizer emitted", () => {
    const element = article(
      "<a href='#fn-1'>1</a><a href='#missing'>x</a><li id='user-content-fn-1'></li>",
    );
    resolveInternalLinks(element);
    const [first, second] = element.querySelectorAll("a");
    expect(first?.getAttribute("href")).toBe("#user-content-fn-1");
    expect(second?.getAttribute("href")).toBe("#missing");
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
    const rendered: Array<ReadonlyArray<string>> = [];
    const inspections = [["Found while rendering."], ["Found while rendering.", "Found last."]];
    let pass = 0;
    const readiness = await renderWithCompleteNotes({
      render: (notes) => rendered.push(notes),
      tracker: new DocumentPageTracker(),
      inspect: async () => readinessWith(inspections[Math.min(pass++, 1)]!),
    });
    expect(rendered).toEqual([
      [],
      ["Found while rendering."],
      ["Found while rendering.", "Found last."],
    ]);
    expect(readiness.status).toBe("ready");
  });

  it("refuses a page whose notes never settle", async () => {
    let pass = 0;
    const tracker = new DocumentPageTracker();
    const readiness = await renderWithCompleteNotes({
      render: () => undefined,
      tracker,
      inspect: async () => readinessWith([`Note ${pass++}`]),
    });
    expect(readiness.status).toBe("failed");
    expect(readiness.diagnostics).toEqual([
      expect.objectContaining({ severity: "fatal", code: "render-crashed" }),
    ]);
  });
});

describe("document page input", () => {
  const inputUrl = "https://environment.test/api/assets/token/document.json";

  it("reads the capture URL from the fragment and nowhere else", () => {
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
  it("escapes the title into the page margin box and truncates long titles", () => {
    expect(cssStringLiteral('A "quoted" \\ title\nnext')).toBe('"A \\"quoted\\" \\\\ title next"');
    const css = runningHeaderCss("x".repeat(200));
    expect(css).toContain(`"${"x".repeat(89)}…"`);
    expect(css).toContain("@page :first { @top-center { content: none; } }");
  });
});
