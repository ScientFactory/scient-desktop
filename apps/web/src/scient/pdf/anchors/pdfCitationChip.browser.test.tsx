import "../../../index.css";

import { EnvironmentId, PdfCitation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../../test/render";

import { AssistantCitationChip } from "~/components/chat/AssistantCitationChip";

import { pdfCitationHash } from "./pdfCitationNavigation";

const quote = Schema.decodeUnknownSync(PdfCitation)({
  kind: "pdf",
  version: 1,
  environmentId: "environment",
  threadId: "thread",
  target: {
    version: 1,
    document: {
      authority: "environment",
      logicalDocumentKey: "workspace:/project/papers/smith-2024.pdf",
      title: "smith-2024.pdf",
      fileName: "smith-2024.pdf",
      locator: {
        _tag: "workspace",
        workspaceRoot: "/project",
        relativePath: "papers/smith-2024.pdf",
      },
    },
    material: null,
    extractor: { profile: "pdfjs-text-layer-utf16-eol-v1", version: "6.2.108" },
    selector: {
      type: "text",
      pages: [
        {
          page: 2,
          viewBox: [0, 0, 612, 792],
          rotation: 0,
          userUnit: 1,
          pageTextHash: "e".repeat(64),
          start: 0,
          end: 27,
          quote: "the coupling\nconstant rises",
          prefix: "",
          suffix: "",
        },
      ],
    },
  },
});

describe("PDF quote chips", () => {
  // The composer chip differs only in its link's styling, so one surface covers both.
  it("names the PDF and page and opens it", async () => {
    await using screen = await render(<AssistantCitationChip citation={quote} />);
    const { container } = screen;
    const chip = container.querySelector<HTMLElement>("[data-pdf-citation-chip]");
    expect(chip).not.toBeNull();
    expect(container.querySelector("[data-assistant-citation-chip]")).toBeNull();
    const link = container.querySelector<HTMLAnchorElement>("a")!;
    expect(link.textContent).toContain("smith-2024.pdf · p. 2 · the coupling constant rises");
    expect(link.getAttribute("aria-label")).toContain("View cited papers/smith-2024.pdf");
    expect(link.getAttribute("href")).toBe(
      `/${EnvironmentId.make("environment")}/thread#${pdfCitationHash(quote)}`,
    );

    await userEvent.hover(link);
    await expect.element(page.getByRole("tooltip")).toBeVisible();
    const popup = page.getByRole("tooltip").element();
    expect(popup.textContent).toContain("smith-2024.pdf");
    expect(popup.textContent).toContain("papers/smith-2024.pdf");
    expect(popup.textContent).toContain("PDF, p. 2");
    expect(popup.textContent).toContain("the coupling constant rises");

    await userEvent.click(link);
    await vi.waitFor(() => expect(screen.router?.state.location.hash).toBe(pdfCitationHash(quote)));
  });
});
