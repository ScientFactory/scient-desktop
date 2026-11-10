import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PreviewManager } from "../../preview/Manager.ts";
import { libraryPdfFileName, readLibraryPage } from "./libraryPage.ts";

vi.mock("electron", () => ({
  BrowserWindow: {},
  app: {},
  webContents: {},
  session: {},
  nativeImage: {},
  shell: {},
  clipboard: {},
  ClipboardItem: {},
}));

function tab(input: {
  readonly url: string;
  readonly report: unknown;
  readonly response?: Response;
}): Electron.WebContents {
  return {
    isDestroyed: () => false,
    getURL: () => input.url,
    executeJavaScript: async () => input.report,
    session: { fetch: async () => input.response ?? new Response(null, { status: 404 }) },
  } as unknown as Electron.WebContents;
}

const withTab = (contents: Electron.WebContents) =>
  Effect.provide(
    Layer.mock(PreviewManager)({
      isBrowserPartition: () => true,
      accountsWebContents: () => Effect.succeed(contents),
    }),
  );

describe("reading a browser tab for the Library", () => {
  it.effect("uses the tab's own address with the page's title, selection and tags", () =>
    Effect.gen(function* () {
      const page = yield* readLibraryPage("tab-1").pipe(
        withTab(
          tab({
            url: "https://journal.example/articles/42",
            report: {
              title: "Article",
              selection: "Mortality fell.",
              meta: [{ name: "citation_doi", content: "10.1000/x" }],
              contentType: "text/html",
            },
          }),
        ),
      );
      expect(page).toEqual({
        _tag: "page",
        page: {
          url: "https://journal.example/articles/42",
          title: "Article",
          selection: "Mortality fell.",
          meta: [{ name: "citation_doi", content: "10.1000/x" }],
        },
      });
    }),
  );

  it.effect("fetches a PDF tab through its session and refuses what is not a PDF", () =>
    Effect.gen(function* () {
      const report = { title: null, selection: null, meta: [], contentType: "application/pdf" };
      const url = "https://journal.example/content/paper%201.pdf";
      const pdf = yield* readLibraryPage("tab-1").pipe(
        withTab(tab({ url, report, response: new Response("%PDF-1.7\nbody") })),
      );
      expect(pdf).toMatchObject({ _tag: "pdf", url, fileName: "paper 1.pdf" });
      const html = yield* readLibraryPage("tab-1").pipe(
        withTab(tab({ url, report, response: new Response("<html>Sign in</html>") })),
      );
      expect(html).toBeNull();
      const local = yield* readLibraryPage("tab-1").pipe(
        withTab(tab({ url: "file:///etc/passwd", report })),
      );
      expect(local).toBeNull();
    }),
  );

  it("names a PDF from its address", () => {
    expect(libraryPdfFileName("https://x.example/a/b/Smith-2024.PDF?download=1")).toBe(
      "Smith-2024.pdf",
    );
    expect(libraryPdfFileName("https://x.example/download")).toBe("download.pdf");
    expect(libraryPdfFileName("https://x.example/")).toBe("document.pdf");
  });
});
