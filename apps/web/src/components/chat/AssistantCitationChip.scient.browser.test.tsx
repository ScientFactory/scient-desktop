import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { assistantCitationHash } from "~/lib/assistantCitationNavigation";
import { fileCitationHash } from "~/scient/markdownEditor/fileCitationNavigation";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import "~/index.css";
import { act, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ observeSource: vi.fn(), dispose: vi.fn(), navigate: vi.fn() }));
vi.mock(import("./AssistantCitationSource"), async (importOriginal) => ({
  ...(await importOriginal()),
  observeAssistantCitationCommentSource: mocks.observeSource,
}));
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

import { AssistantCitationChip } from "./AssistantCitationChip";

const citation = {
  version: 1 as const,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};

// The mocked source observer is shared, so every test starts by resetting it.
function setup() {
  mocks.observeSource.mockReset().mockReturnValue(mocks.dispose);
  mocks.dispose.mockClear();
  mocks.navigate.mockClear();
  const source = document.createElement("p");
  source.textContent = "hello";
  document.body.append(source);
  const range = document.createRange();
  range.selectNodeContents(source);
  const sourceAnchor = { source, range, viewport: document.body } as AssistantCitationSourceAnchor;
  return { sourceAnchor, [Symbol.dispose]: () => source.remove() };
}

describe("citation hover content", () => {
  const fileCitation = {
    kind: "file" as const,
    version: 1 as const,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    cwd: "/Users/someone/project",
    path: "/Users/someone/project/apps/web/src/components/chat/workingPlaceholder.ts",
    revision: `sha256:${"a".repeat(64)}`,
    origin: "saved" as const,
    sourceStart: 0,
    sourceEnd: 20,
    startLine: 12,
    endLine: 18,
    from: 1,
    to: 21,
    text: "export  const\n placeholder = true;",
    prefix: "",
    suffix: "",
  };

  const sourceLink = (container: HTMLElement) => container.querySelector<HTMLAnchorElement>("a")!;
  async function hoverFile(container: HTMLElement) {
    await userEvent.hover(sourceLink(container));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector('[data-slot="tooltip-popup"]')).not.toBeNull();
    });
    return document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]')!;
  }
  // regression: 6a7466b588 fix(chat): show file-citation paths in a compact hover card
  it.each([false, true])(
    "renders a compact card instead of a native title (composer: %s)",
    async (composer) => {
      using _source = setup();
      await using screen = await render(
        <AssistantCitationChip citation={fileCitation} composer={composer} />,
      );
      expect(sourceLink(screen.container).hasAttribute("title")).toBe(false);
      const popup = await hoverFile(screen.container);
      expect(popup.textContent).toContain("workingPlaceholder.ts");
      expect(popup.textContent).toContain("/Users/someone/project/apps/web/src/components/chat/");
      expect(popup.textContent).toContain("Lines 12–18");
      expect(popup.textContent).toContain("export const placeholder = true;");
      expect(popup.textContent).not.toContain("View source");
      expect(popup.querySelectorAll("wbr").length).toBeGreaterThan(5);
    },
  );
  // regression: 6a7466b588 fix(chat): show file-citation paths in a compact hover card
  it("marks citations captured from unsaved drafts", async () => {
    using _source = setup();
    await using screen = await render(
      <AssistantCitationChip citation={{ ...fileCitation, origin: "draft" }} />,
    );
    expect((await hoverFile(screen.container)).textContent).toContain(
      "Lines 12–18 · unsaved at capture",
    );
  });
  it("shows the assistant quote, its saved comment and its source", async () => {
    using _source = setup();
    const quoted = {
      ...citation,
      text: "hello\nquoted source",
      comment: "Explain this result",
    };
    await using screen = await render(<AssistantCitationChip citation={quoted} />);
    const trigger = screen.container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Quoted assistant text:"]',
    )!;
    await act(async () => trigger.click());
    const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
    expect(popup.querySelector("blockquote")?.textContent).toBe(quoted.text);
    expect(popup.querySelector("p")?.textContent).toBe("Explain this result");
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();
    const source = [...popup.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("Go to source"),
    )!;
    expect(source.getAttribute("href")).toBe(
      "/" + quoted.environmentId + "/" + quoted.threadId + "#" + assistantCitationHash(quoted),
    );
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => source.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { environmentId: quoted.environmentId, threadId: quoted.threadId },
        hash: assistantCitationHash(quoted),
        resetScroll: false,
        state: { assistantCitationActivation: expect.any(String) },
      }),
    );
  });
  // regression: 3c9d211d0a fix(find): preserve scientific citation and formula lifecycle
  it.each([false, true])(
    "keeps file citations navigating to their exact captured source (composer: %s)",
    async (composer) => {
      using _source = setup();
      await using screen = await render(
        <AssistantCitationChip citation={fileCitation} composer={composer} />,
      );
      expect(document.querySelector('[data-slot="popover-popup"]')).toBeNull();
      const source = sourceLink(screen.container);
      expect(source.getAttribute("href")).toBe(
        "/" +
          fileCitation.environmentId +
          "/" +
          fileCitation.threadId +
          "#" +
          fileCitationHash(fileCitation),
      );
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      await act(async () => source.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(mocks.navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { environmentId: fileCitation.environmentId, threadId: fileCitation.threadId },
          hash: fileCitationHash(fileCitation),
          resetScroll: false,
          state: { fileCitationActivation: expect.any(String) },
        }),
      );
      mocks.navigate.mockClear();
      const modified = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        metaKey: true,
      });
      let preventedByChip = false;
      document.addEventListener(
        "click",
        (e) => {
          preventedByChip = e.defaultPrevented;
          e.preventDefault();
        },
        { once: true },
      );
      await act(async () => source.dispatchEvent(modified));
      expect(preventedByChip).toBe(false);
      expect(mocks.navigate).not.toHaveBeenCalled();
    },
  );
});
