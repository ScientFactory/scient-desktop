// @vitest-environment happy-dom
import { EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { MessageCopyButton } from "~/components/chat/MessageCopyButton";
import { MessagesTimeline } from "~/components/chat/MessagesTimeline";
import { isScientMessageCopyHtml, messageCopyHtml } from "./messageCopyHtml";

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  ),
}));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));
vi.mock("~/components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("~/components/ui/anchoredCopyToast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/ui/anchoredCopyToast")>()),
  showAnchoredCopySuccessToast: () => {},
  showAnchoredCopyErrorToast: () => {},
}));

const CREATED_AT = "2026-09-29T08:00:00.000Z";
const CONTEXT_FRAGMENT = JSON.stringify({
  version: 1,
  source: { environmentId: "environment-local", messageId: "m-3" },
  records: [],
});
const HEBREW_USER = "שלום, בדקתי את הקובץ ./src/app.ts והכול עובד.";
const HEBREW_ASSISTANT =
  "## סיכום\n\nהרצנו את הבדיקות עם Python.\n\n- פריט ראשון\n- פריט שני\n\n```ts\nconst x = 1;\n```";

interface ClipboardWrite {
  readonly text: string;
  readonly html: string | null;
  readonly flavors: ReadonlyArray<string>;
}

let root: Root | null = null;
let host: HTMLElement;
let writes: ClipboardWrite[];
let writeTexts: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  writes = [];
  writeTexts = [];
  vi.stubGlobal(
    "ClipboardItem",
    class {
      constructor(readonly data: Record<string, Blob>) {}
    },
  );
  vi.stubGlobal("navigator", {
    clipboard: {
      write: async (items: Array<{ data: Record<string, Blob> }>) => {
        const data = items[0]!.data;
        writes.push({
          text: await data["text/plain"]!.text(),
          html: data["text/html"] ? await data["text/html"].text() : null,
          flavors: Object.keys(data).toSorted(),
        });
      },
      writeText: async (text: string) => {
        writeTexts.push(text);
      },
    },
  });
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function timelineProps() {
  return {
    isWorking: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaries: [],
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function message(id: string, role: "user" | "assistant", text: string) {
  return {
    id: `entry-${id}`,
    kind: "message" as const,
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role,
      text,
      turnId: role === "assistant" ? TurnId.make("turn-1") : null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
    },
  };
}

async function renderTimeline(userText: string, assistantText: string) {
  root = createRoot(host);
  await act(() =>
    root!.render(
      <MessagesTimeline
        {...timelineProps()}
        timelineEntries={[
          message("user-1", "user", userText),
          message("assistant-1", "assistant", assistantText),
        ]}
      />,
    ),
  );
}

function copyButtonFor(messageId: string): HTMLButtonElement {
  const buttons = [
    ...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy message"]'),
  ];
  const button = buttons.find(
    (candidate) =>
      candidate.closest("[data-message-id]")?.getAttribute("data-message-id") === messageId,
  );
  if (!button) throw new Error(`Missing copy button for ${messageId}`);
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function parse(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("Copy message button", () => {
  it("copies Markdown only, exactly as before, when a message has no right-to-left text", async () => {
    await renderTimeline("Plain English prompt.", "An **English** answer.");
    await click(copyButtonFor("user-1"));
    await click(copyButtonFor("assistant-1"));
    expect(writeTexts).toEqual(["Plain English prompt.", "An **English** answer."]);
    expect(writes).toEqual([]);
  });

  it("adds direction-marked HTML beside the Markdown for a right-to-left assistant reply", async () => {
    await renderTimeline("Please summarize.", HEBREW_ASSISTANT);
    const rendered = host.querySelector('[data-message-id="assistant-1"] .chat-markdown')!;
    const before = rendered.outerHTML;
    await click(copyButtonFor("assistant-1"));
    expect(writeTexts).toEqual([]);
    expect(writes).toHaveLength(1);
    const [write] = writes;
    expect(write!.text).toBe(HEBREW_ASSISTANT);
    expect(write!.flavors).toEqual(["text/html", "text/plain"]);
    expect(isScientMessageCopyHtml(write!.html!)).toBe(true);
    const html = parse(write!.html!);
    expect(html.querySelector("h2, h3")?.getAttribute("style")).toBe(
      "direction:rtl;text-align:right",
    );
    expect(html.querySelector("p")?.getAttribute("dir")).toBe("rtl");
    expect(html.querySelector("ul")?.getAttribute("style")).toBe("direction:rtl");
    expect(html.querySelector("pre")?.getAttribute("dir")).toBe("ltr");
    expect(html.querySelector("button, svg")).toBeNull();
    // The Copy button's click only reads the rendered message.
    expect(rendered.outerHTML).toBe(before);
  });

  it("adds direction-marked HTML for a right-to-left user message", async () => {
    await renderTimeline(HEBREW_USER, "Done.");
    await click(copyButtonFor("user-1"));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toBe(HEBREW_USER);
    const html = parse(writes[0]!.html!);
    expect(html.querySelector("p")?.getAttribute("style")).toBe("direction:rtl;text-align:right");
    expect(
      [...html.querySelectorAll('span[dir="ltr"]')].map((island) => island.textContent),
    ).toEqual(["./src/app.ts"]);
  });
});

describe("messageCopyHtml", () => {
  function renderedRow(messageId: string, body: string): HTMLElement {
    const row = document.createElement("div");
    row.setAttribute("data-timeline-row-kind", "message");
    row.setAttribute("data-message-id", messageId);
    row.innerHTML = `<div class="chat-markdown" dir="rtl" data-scient-content-direction="rtl">${body}</div>`;
    document.body.append(row);
    return row;
  }

  it("finds the message from a separate metadata row", () => {
    renderedRow("m-1", '<p dir="rtl">שלום</p>');
    const meta = document.createElement("div");
    meta.setAttribute("data-message-id", "m-1");
    meta.setAttribute("data-timeline-row-kind", "assistant-meta");
    const anchor = document.createElement("button");
    meta.append(anchor);
    document.body.append(meta);
    const html = messageCopyHtml({ anchor, messageId: "m-1", markdown: "שלום" });
    expect(parse(html!).querySelector("p")?.getAttribute("style")).toBe(
      "direction:rtl;text-align:right",
    );
  });

  it("keeps the plain copy when the message is not rendered", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    expect(messageCopyHtml({ anchor, messageId: "missing", markdown: "שלום" })).toBeNull();
  });

  it("replaces images with their description rather than their signed address", () => {
    const row = renderedRow(
      "m-2",
      '<p dir="rtl">גרף <img alt="עקומת תגובה" src="http://127.0.0.1:1/asset?token=secret"></p>',
    );
    const anchor = row.appendChild(document.createElement("button"));
    const html = messageCopyHtml({
      anchor,
      messageId: "m-2",
      markdown: "גרף ![עקומת תגובה](a.png)",
    })!;
    expect(html).not.toContain("token=secret");
    expect(parse(html).querySelector("p")?.textContent).toBe("גרף עקומת תגובה");
    // The rendered message keeps its image.
    expect(row.querySelector("img")?.getAttribute("src")).toContain("token=secret");
  });

  it("keeps the composer context fragment round-tripping through the rich flavour", async () => {
    const row = renderedRow("m-3", '<p dir="rtl">שלום עם הקשר</p>');
    const fragment = CONTEXT_FRAGMENT;
    const buttonHost = row.appendChild(document.createElement("div"));
    root = createRoot(buttonHost);
    await act(() =>
      root!.render(
        <MessageCopyButton
          text="שלום עם הקשר"
          extraFlavors={{ [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment }}
          resolveHtml={(anchor) =>
            messageCopyHtml({ anchor, messageId: "m-3", markdown: "שלום עם הקשר" })
          }
        />,
      ),
    );
    await click(buttonHost.querySelector("button")!);
    expect(writes).toHaveLength(1);
    const html = writes[0]!.html!;
    expect(writes[0]!.flavors).toContain(COMPOSER_CONTEXT_CLIPBOARD_MIME);
    expect(decodeComposerContextClipboardHtml(html)).toEqual(JSON.parse(fragment));
    expect(parse(html).querySelector("p")?.getAttribute("dir")).toBe("rtl");
  });

  it("keeps the context copy unchanged for a message without right-to-left text", async () => {
    const row = renderedRow("m-4", '<p dir="ltr">Hello</p>');
    const fragment = CONTEXT_FRAGMENT;
    const buttonHost = row.appendChild(document.createElement("div"));
    root = createRoot(buttonHost);
    await act(() =>
      root!.render(
        <MessageCopyButton
          text="Hello"
          extraFlavors={{ [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment }}
          resolveHtml={(anchor) => messageCopyHtml({ anchor, messageId: "m-4", markdown: "Hello" })}
        />,
      ),
    );
    await click(buttonHost.querySelector("button")!);
    expect(writes[0]!.html).toBe(
      `<pre data-t3-context-fragment="${encodeURIComponent(fragment)}">Hello</pre>`,
    );
  });
});
