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
import { messageCopyHtml } from "./messageCopyHtml";
import { isScientMessageCopyHtml } from "./messageCopyMarker";

/** Rows the mocked list leaves unmounted, as LegendList does for rows out of view. */
const virtualized = vi.hoisted(() => ({ rowIds: new Set<string>() }));
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
      {props.data
        .filter((item) => !virtualized.rowIds.has(props.keyExtractor(item)))
        .map((item) => (
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
  virtualized.rowIds.clear();
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

const HEBREW_WITH_CARDS = [
  "## סיכום",
  "",
  "<details>",
  "<summary>פרטים נוספים</summary>",
  "",
  "גוף מוסתר של הפרטים.",
  "",
  "</details>",
  "",
  "```mermaid",
  "graph TD; A-->B",
  "```",
].join("\n");

describe("Copy message button content", () => {
  it("carries a collapsed details body and a diagram's source", async () => {
    await renderTimeline("Please summarize.", HEBREW_WITH_CARDS);
    // The rendered details are collapsed, so their body is not in the page.
    expect(host.textContent).not.toContain("גוף מוסתר של הפרטים.");
    await click(copyButtonFor("assistant-1"));
    const html = parse(writes[0]!.html!);
    expect(html.querySelector("strong")?.textContent).toBe("פרטים נוספים");
    expect(html.textContent).toContain("גוף מוסתר של הפרטים.");
    expect(html.querySelector("pre")?.textContent).toBe("graph TD; A-->B\n");
  });

  it("still copies direction-marked HTML when the answer's row is virtualized away", async () => {
    const turnId = TurnId.make("turn-trailing-tools");
    virtualized.rowIds.add("assistant-entry");
    root = createRoot(host);
    await act(() =>
      root!.render(
        <MessagesTimeline
          {...timelineProps()}
          latestTurn={{
            turnId,
            // A settled turn that ended in a failed tool stays unfolded.
            state: "error",
            startedAt: "2026-09-29T07:59:50.000Z",
            completedAt: "2026-09-29T08:00:10.000Z",
          }}
          timelineEntries={[
            {
              id: "assistant-entry",
              kind: "message",
              createdAt: CREATED_AT,
              message: {
                id: MessageId.make("assistant-trailing"),
                role: "assistant",
                text: HEBREW_ASSISTANT,
                turnId,
                createdAt: CREATED_AT,
                updatedAt: CREATED_AT,
                streaming: false,
              },
            },
            {
              id: "trailing-work-entry",
              kind: "work",
              createdAt: "2026-09-29T08:00:05.000Z",
              entry: {
                id: "trailing-work",
                createdAt: "2026-09-29T08:00:05.000Z",
                turnId,
                label: "Ran command",
                tone: "tool",
                itemType: "command_execution",
                toolLifecycleStatus: "failed",
              },
            },
          ]}
        />,
      ),
    );
    expect(host.querySelector('[data-timeline-row-id="assistant-entry"]')).toBeNull();
    const meta = host.querySelector('[data-timeline-row-id="assistant-meta:assistant-trailing"]');
    const button = meta?.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]');
    expect(button).toBeTruthy();
    await click(button!);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toBe(HEBREW_ASSISTANT);
    const html = parse(writes[0]!.html!);
    expect(html.querySelector("h2")?.getAttribute("style")).toBe("direction:rtl;text-align:right");
    expect(html.querySelector("ul")?.getAttribute("dir")).toBe("rtl");
    expect(html.querySelector("pre")?.getAttribute("dir")).toBe("ltr");
  });
});

describe("messageCopyHtml", () => {
  const ASSISTANT_PROFILE = { lineBreaks: false, parseRawHtml: true } as const;

  function renderedRow(messageId: string, body: string, dir = "rtl"): HTMLElement {
    const row = document.createElement("div");
    row.setAttribute("data-timeline-row-kind", "message");
    row.setAttribute("data-message-id", messageId);
    row.innerHTML = `<div class="chat-markdown" dir="${dir}" data-scient-content-direction="${dir}">${body}</div>`;
    document.body.append(row);
    return row;
  }

  function detachedAnchor(): HTMLButtonElement {
    return document.body.appendChild(document.createElement("button"));
  }

  it("uses the displayed direction of the message from a separate metadata row", () => {
    // The message displays right-to-left even though its prose alone would not decide it.
    renderedRow("m-1", '<p dir="rtl">x</p>');
    const meta = document.createElement("div");
    meta.setAttribute("data-message-id", "m-1");
    meta.setAttribute("data-timeline-row-kind", "assistant-meta");
    const anchor = meta.appendChild(document.createElement("button"));
    document.body.append(meta);
    const html = messageCopyHtml({
      anchor,
      messageId: "m-1",
      markdown: "Run the tests with Python and שלום.",
      ...ASSISTANT_PROFILE,
    })!;
    expect(parse(html).querySelector("p")?.getAttribute("dir")).toBe("ltr");
    expect(parse(html).querySelector("[data-scient-message-copy]")).not.toBeNull();
  });

  it("renders the message when its row is not mounted", () => {
    const html = messageCopyHtml({
      anchor: detachedAnchor(),
      messageId: "missing",
      markdown: "שלום עולם.",
      ...ASSISTANT_PROFILE,
    });
    expect(parse(html!).querySelector("p")?.getAttribute("style")).toBe(
      "direction:rtl;text-align:right",
    );
  });

  it("keeps every chip, collapsed details body, and diagram source from the Markdown", () => {
    const markdown = [
      "ראו את [app.ts](t3-context://mention-1) ואת `notes/plan.md` ואת @src/data.csv.",
      "",
      "<details>",
      "<summary>פרטים נוספים</summary>",
      "",
      "גוף מוסתר של הפרטים.",
      "",
      "</details>",
      "",
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "",
      "```vega-lite",
      '{"mark":"bar"}',
      "```",
    ].join("\n");
    // The mounted row shows chips as buttons and the details collapsed.
    const row = renderedRow(
      "m-5",
      '<p dir="rtl">ראו <button data-markdown-copy="[app.ts](t3-context://mention-1)"><svg></svg><span>app.ts</span></button></p>' +
        '<div data-markdown-details=""><button data-markdown-details-summary=""><span>פרטים נוספים</span></button></div>',
    );
    const anchor = row.appendChild(document.createElement("button"));
    const html = parse(
      messageCopyHtml({ anchor, messageId: "m-5", markdown, ...ASSISTANT_PROFILE })!,
    );
    const text = html.textContent ?? "";
    expect(text).toContain("app.ts");
    expect(text).toContain("notes/plan.md");
    expect(text).toContain("@src/data.csv");
    expect(html.querySelector("strong")?.textContent).toBe("פרטים נוספים");
    expect(text).toContain("גוף מוסתר של הפרטים.");
    const [mermaid, vega] = [...html.querySelectorAll("pre")];
    expect(mermaid?.textContent).toBe("graph TD; A-->B\n");
    expect(mermaid?.getAttribute("dir")).toBe("ltr");
    expect(vega?.textContent).toBe('{"mark":"bar"}\n');
    // Scient-only destinations do not become broken links.
    expect(html.querySelector("a")).toBeNull();
    expect(html.querySelector("button, svg, details")).toBeNull();
  });

  it("keeps math source and replaces images with their description", () => {
    const html = parse(
      messageCopyHtml({
        anchor: detachedAnchor(),
        messageId: "m-2",
        markdown: "גרף ![עקומת תגובה](plot.png) לפי $E = mc^2$.",
        ...ASSISTANT_PROFILE,
      })!,
    );
    expect(html.querySelector("img")).toBeNull();
    // Math copies as chat's own copy source, the same as a selection copy.
    expect(html.querySelector("p")?.textContent).toBe("גרף עקומת תגובה לפי $$E = mc^2$$.");
    expect(
      [...html.querySelectorAll('span[dir="ltr"]')].map((island) => island.textContent),
    ).toEqual(["$$E = mc^2$$"]);
  });

  it("keeps the composer context fragment round-tripping through the rich flavour", async () => {
    const row = renderedRow("m-3", '<p dir="rtl">שלום עם הקשר</p>');
    const buttonHost = row.appendChild(document.createElement("div"));
    root = createRoot(buttonHost);
    await act(() =>
      root!.render(
        <MessageCopyButton
          text="שלום עם הקשר"
          extraFlavors={{ [COMPOSER_CONTEXT_CLIPBOARD_MIME]: CONTEXT_FRAGMENT }}
          resolveHtml={(anchor) =>
            messageCopyHtml({
              anchor,
              messageId: "m-3",
              markdown: "שלום עם הקשר",
              lineBreaks: true,
              parseRawHtml: false,
            })
          }
        />,
      ),
    );
    await click(buttonHost.querySelector("button")!);
    expect(writes).toHaveLength(1);
    const html = writes[0]!.html!;
    expect(writes[0]!.flavors).toContain(COMPOSER_CONTEXT_CLIPBOARD_MIME);
    expect(decodeComposerContextClipboardHtml(html)).toEqual(JSON.parse(CONTEXT_FRAGMENT));
    expect(parse(html).querySelector("p")?.getAttribute("dir")).toBe("rtl");
  });

  it("keeps the context copy unchanged for a message without right-to-left text", async () => {
    const row = renderedRow("m-4", '<p dir="ltr">Hello</p>', "ltr");
    const buttonHost = row.appendChild(document.createElement("div"));
    root = createRoot(buttonHost);
    await act(() =>
      root!.render(
        <MessageCopyButton
          text="Hello"
          extraFlavors={{ [COMPOSER_CONTEXT_CLIPBOARD_MIME]: CONTEXT_FRAGMENT }}
          resolveHtml={(anchor) =>
            messageCopyHtml({
              anchor,
              messageId: "m-4",
              markdown: "Hello",
              lineBreaks: true,
              parseRawHtml: false,
            })
          }
        />,
      ),
    );
    await click(buttonHost.querySelector("button")!);
    expect(writes[0]!.html).toBe(
      `<pre data-t3-context-fragment="${encodeURIComponent(CONTEXT_FRAGMENT)}">Hello</pre>`,
    );
  });
});
