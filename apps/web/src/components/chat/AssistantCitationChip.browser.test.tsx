import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { userEvent } from "vite-plus/test/browser";
import { assistantCitationHash } from "~/lib/assistantCitationNavigation";
import { fileCitationHash } from "~/scient/markdownEditor/fileCitationNavigation";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
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

function mount(sourceAnchor: AssistantCitationSourceAnchor, onSave: () => boolean) {
  function Composer() {
    const [open, setOpen] = useState(true);
    return (
      <AssistantCitationChip
        citation={citation}
        composer
        commentEditor={{ open, sourceAnchor, onOpenChange: setOpen, onSave }}
      />
    );
  }
  return render(<Composer />);
}

const textarea = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment on selected text"]');

async function typeComment(value: string) {
  const input = textarea()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function removeSource() {
  const { onUnavailable } = mocks.observeSource.mock.lastCall![0];
  await act(async () => onUnavailable());
}

async function clickButton(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  await act(async () => button!.click());
}

describe("citation comment source disappearance", () => {
  it("preserves an over-length draft at the composer until it can be shortened and saved", async () => {
    using source = setup();
    const onSave = vi.fn(() => true);
    await using _screen = await mount(source.sourceAnchor, onSave);
    const draft = "x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1);
    await typeComment(draft);
    await removeSource();

    expect(textarea()?.value).toBe(draft);
    expect(textarea()?.getAttribute("aria-invalid")).toBe("true");
    expect(onSave).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.observeSource).toHaveBeenCalledTimes(1);

    await typeComment("shortened comment");
    await clickButton("Save");
    expect(onSave).toHaveBeenCalledWith("shortened comment");
    expect(textarea()).toBeNull();
  });

  it("preserves a rejected save and allows a later retry", async () => {
    using source = setup();
    const onSave = vi.fn(() => false);
    await using _screen = await mount(source.sourceAnchor, onSave);
    await typeComment("keep this draft");
    await removeSource();

    expect(onSave).toHaveBeenCalledWith("keep this draft");
    expect(textarea()?.value).toBe("keep this draft");
    onSave.mockReturnValue(true);
    await clickButton("Save");
    expect(onSave).toHaveBeenLastCalledWith("keep this draft");
    expect(textarea()).toBeNull();
  });
});

// SCIENT-FORK:START - captured file and assistant quotes keep their source and hover content.
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
  it("marks citations captured from unsaved drafts", async () => {
    using _source = setup();
    await using screen = await render(
      <AssistantCitationChip citation={{ ...fileCitation, origin: "draft" }} />,
    );
    expect((await hoverFile(screen.container)).textContent).toContain(
      "Lines 12–18 · unsaved at capture",
    );
  });
  it.each([true, false])(
    "shows the assistant quote and source with saved comment: %s",
    async (withComment) => {
      using _source = setup();
      const quoted = {
        ...citation,
        text: "hello\nquoted source",
        ...(withComment ? { comment: "Explain this result" } : {}),
      };
      await using screen = await render(<AssistantCitationChip citation={quoted} />);
      const trigger = screen.container.querySelector<HTMLButtonElement>(
        'button[aria-label^="Quoted assistant text:"]',
      )!;
      await act(async () => trigger.click());
      const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
      expect(popup.querySelector("blockquote")?.textContent).toBe(quoted.text);
      expect(popup.querySelector("p")?.textContent ?? null).toBe(
        withComment ? "Explain this result" : null,
      );
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
    },
  );
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
// SCIENT-FORK:END
