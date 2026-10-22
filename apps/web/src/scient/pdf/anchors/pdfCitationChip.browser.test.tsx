import { EnvironmentId, PdfCitation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => mocks.navigate,
  Link: (({
    children,
    to: _to,
    params,
    hash,
    resetScroll: _resetScroll,
    ...props
  }: ComponentProps<"a"> & {
    to?: string;
    params?: { environmentId: string; threadId: string };
    hash?: string;
    resetScroll?: boolean;
  }) => (
    <a
      {...props}
      href={params ? "/" + params.environmentId + "/" + params.threadId + "#" + (hash ?? "") : "#"}
    >
      {children}
    </a>
  )) as never,
}));

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
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.navigate.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it.each([false, true])("names the PDF and page and opens it (composer: %s)", async (composer) => {
    await act(async () =>
      root.render(<AssistantCitationChip citation={quote} composer={composer} />),
    );
    const chip = container.querySelector<HTMLElement>("[data-pdf-citation-chip]");
    expect(chip).not.toBeNull();
    expect(container.querySelector("[data-assistant-citation-chip]")).toBeNull();
    const link = container.querySelector<HTMLAnchorElement>("a")!;
    expect(link.textContent).toContain("smith-2024.pdf · p. 2 · the coupling constant rises");
    expect(link.getAttribute("aria-label")).toContain("View cited papers/smith-2024.pdf");
    expect(link.getAttribute("href")).toBe(
      `/${EnvironmentId.make("environment")}/thread#${pdfCitationHash(quote)}`,
    );

    await act(async () => userEvent.hover(link));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector('[data-slot="tooltip-popup"]')).not.toBeNull();
    });
    const popup = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]')!;
    expect(popup.textContent).toContain("smith-2024.pdf");
    expect(popup.textContent).toContain("papers/smith-2024.pdf");
    expect(popup.textContent).toContain("PDF, p. 2");
    expect(popup.textContent).toContain("the coupling constant rises");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => link.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ hash: pdfCitationHash(quote) }),
    );
  });
});
