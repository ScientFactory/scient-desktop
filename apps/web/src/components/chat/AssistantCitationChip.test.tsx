import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import { act, useState, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";

const mocks = vi.hoisted(() => ({ observeSource: vi.fn(), dispose: vi.fn() }));
vi.mock("./AssistantCitationSource", () => ({
  observeAssistantCitationCommentSource: mocks.observeSource,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
// Keep the real chip/editor lifecycle while replacing DOM positioning and floating layers.
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  PopoverPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));

import { PopoverPopup } from "../ui/popover";
import { TooltipPopup } from "../ui/tooltip";
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
// The observer owns DOM access; these identities let us check which anchor survives.
const sourceAnchor = {
  source: {},
  range: {},
  viewport: {},
} as AssistantCitationSourceAnchor;

let renderer: ReactTestRenderer;

function mount(onSave = vi.fn(() => true)) {
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
  act(() => {
    renderer = create(<Composer />);
  });
  return onSave;
}

function typeComment(value: string) {
  act(() => renderer.root.findByType("textarea").props.onChange({ currentTarget: { value } }));
}

function removeSource() {
  const { onUnavailable } = mocks.observeSource.mock.lastCall![0];
  act(() => onUnavailable());
}

function clickButton(label: string) {
  act(() =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === label)!
      .props.onClick(),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.observeSource.mockReset().mockReturnValue(mocks.dispose);
  mocks.dispose.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

describe("citation comment source disappearance", () => {
  it("preserves an over-length draft at the composer until it can be shortened and saved", () => {
    const onSave = mount();
    const draft = "x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1);
    typeComment(draft);
    removeSource();

    expect(renderer.root.findByType("textarea").props.value).toBe(draft);
    expect(renderer.root.findByType("textarea").props["aria-invalid"]).toBe(true);
    expect(renderer.root.findByType(PopoverPopup).props.anchor).toBeUndefined();
    expect(renderer.root.findByType(PopoverPopup).props.side).toBe("top");
    expect(onSave).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.observeSource).toHaveBeenCalledTimes(1);

    typeComment("shortened comment");
    clickButton("Save");
    expect(onSave).toHaveBeenCalledWith("shortened comment");
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  });

  it("preserves a rejected save and allows a later retry", () => {
    const onSave = mount(vi.fn(() => false));
    typeComment("keep this draft");
    removeSource();

    expect(onSave).toHaveBeenCalledWith("keep this draft");
    expect(renderer.root.findByType("textarea").props.value).toBe("keep this draft");
    expect(renderer.root.findByType(PopoverPopup).props.anchor).toBeUndefined();
    onSave.mockReturnValue(true);
    clickButton("Save");
    expect(onSave).toHaveBeenLastCalledWith("keep this draft");
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  });

  it("still allows explicit cancellation after source disappearance", () => {
    const onSave = mount(vi.fn(() => false));
    typeComment("discard this draft");
    removeSource();
    onSave.mockClear();
    clickButton("Cancel");
    expect(onSave).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  });

  it("saves and closes when the source disappears with a valid draft", () => {
    const onSave = mount();
    typeComment("saved comment");
    removeSource();
    expect(onSave).toHaveBeenCalledWith("saved comment");
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
  });
});

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

  // Each rendered element's own text, so a line like "Lines 12–18" reads as one entry.
  function popupLines(): string[] {
    return renderer.root
      .findByType(TooltipPopup)
      .findAll((node) => typeof node.type === "string")
      .map((node) => node.children.filter((child) => typeof child === "string").join(""));
  }

  it.each([false, true])(
    "renders a compact card instead of a native title (composer: %s)",
    (composer) => {
      act(() => {
        renderer = create(<AssistantCitationChip citation={fileCitation} composer={composer} />);
      });

      expect(renderer.root.findByProps({ resetScroll: false }).props.title).toBeUndefined();
      const text = popupLines();
      expect(text).toContain("workingPlaceholder.ts");
      expect(text.join("")).toContain("/Users/someone/project/apps/web/src/components/chat/");
      expect(text).toContain("Lines 12–18");
      expect(text).toContain("export const placeholder = true;");
      expect(text.join("")).not.toContain("View source");
      expect(renderer.root.findByType(TooltipPopup).findAllByType("wbr").length).toBeGreaterThan(5);
    },
  );

  it("marks citations captured from unsaved drafts", () => {
    act(() => {
      renderer = create(<AssistantCitationChip citation={{ ...fileCitation, origin: "draft" }} />);
    });
    expect(popupLines()).toContain("Lines 12–18 · unsaved at capture");
  });

  it("keeps the View source tooltip for assistant citations", () => {
    act(() => {
      renderer = create(<AssistantCitationChip citation={citation} />);
    });
    expect(renderer.root.findByType(TooltipPopup).props.children).toBe("View source");
  });
});
