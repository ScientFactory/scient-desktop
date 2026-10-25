import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

import { MessageCopyButton } from "~/components/chat/MessageCopyButton";
import { MessagesTimeline } from "~/components/chat/MessagesTimeline";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
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

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.stack.use(
    vi.spyOn(navigator.clipboard, "write").mockImplementation(async (items) => {
      const item = items[0]!;
      _fixture.writes.push({
        text: await (await item.getType("text/plain")).text(),
        html: item.types.includes("text/html")
          ? await (await item.getType("text/html")).text()
          : null,
        flavors: [...item.types].toSorted(),
      });
    }),
  );
  _fixture.stack.use(
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
      _fixture.writeTexts.push(text);
    }),
  );
  _fixture.host = document.createElement("div");
  document.body.append(_ownDOM(_fixture, _fixture.host));
}

async function _cleanupFixture1(_fixture: _Fixture) {
  virtualized.rowIds.clear();
  await act(async () => await _fixture.root0?.unmount());
  _fixture.root0 = null;
  _clearOwnedDOM(_fixture);
  vi.unstubAllGlobals();
}

function timelineProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    runningRunId: null,
    turnDiffSummaries: [],
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    providerStatuses: [],
    runs: [],
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
    onAnchorSizeChanged: () => {},
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
      runId: role === "assistant" ? RunId.make("run-1") : null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
    },
  };
}

async function renderTimeline(_fixture: _Fixture, userText: string, assistantText: string) {
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await act(
    async () =>
      await _fixture.root0!.rerender(
        <MessagesTimeline
          emptyPlaceholderInset={0}
          {...timelineProps()}
          timelineEntries={[
            message("user-1", "user", userText),
            message("assistant-1", "assistant", assistantText),
          ]}
        />,
      ),
  );
}

function copyButtonFor(_fixture: _Fixture, messageId: string): HTMLButtonElement {
  const buttons = [
    ..._fixture.host.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy message"]'),
  ];
  const button = buttons.find(
    (candidate) =>
      candidate.closest("[data-message-id]")?.getAttribute("data-message-id") === messageId,
  );
  if (!button) throw new Error(`Missing copy button for ${messageId}`);
  return button;
}

async function click(_fixture: _Fixture, button: HTMLButtonElement) {
  const previousWrites = _fixture.writes.length + _fixture.writeTexts.length;
  await act(async () => {
    button.click();
  });
  await expect
    .poll(() => _fixture.writes.length + _fixture.writeTexts.length)
    .toBe(previousWrites + 1);
}

function parse(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("Copy message button", () => {
  it("copies Markdown only, exactly as before, when a message has no right-to-left text", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await renderTimeline(_fixture, "Plain English prompt.", "An **English** answer.");
    await click(_fixture, copyButtonFor(_fixture, "user-1"));
    await click(_fixture, copyButtonFor(_fixture, "assistant-1"));
    expect(_fixture.writeTexts).toEqual(["Plain English prompt.", "An **English** answer."]);
    expect(_fixture.writes).toEqual([]);
  });

  it("adds direction-marked HTML beside the Markdown for a right-to-left assistant reply", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await getSyntaxHighlighterPromise("ts");
    await renderTimeline(_fixture, "Please summarize.", HEBREW_ASSISTANT);
    const rendered = _fixture.host.querySelector('[data-message-id="assistant-1"] .chat-markdown')!;
    expect(rendered.querySelector(".chat-markdown-shiki")).not.toBeNull();
    const before = rendered.outerHTML;
    await click(_fixture, copyButtonFor(_fixture, "assistant-1"));
    expect(_fixture.writeTexts).toEqual([]);
    expect(_fixture.writes).toHaveLength(1);
    const [write] = _fixture.writes;
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await renderTimeline(_fixture, HEBREW_USER, "Done.");
    await click(_fixture, copyButtonFor(_fixture, "user-1"));
    expect(_fixture.writes).toHaveLength(1);
    expect(_fixture.writes[0]!.text).toBe(HEBREW_USER);
    const html = parse(_fixture.writes[0]!.html!);
    expect(html.querySelector("p")?.getAttribute("style")).toBe("direction:rtl;text-align:right");
    expect(
      [...html.querySelectorAll('span[dir="ltr"]')].map((island) => island.textContent),
    ).toEqual(["./src/app.ts"]);
  });
});

describe("Copy message button content", () => {
  it("still copies direction-marked HTML when the answer's row is virtualized away", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const runId = RunId.make("run-trailing-tools");
    virtualized.rowIds.add("assistant-entry");
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
    await act(
      async () =>
        await _fixture.root0!.rerender(
          <MessagesTimeline
            emptyPlaceholderInset={0}
            {...timelineProps()}
            latestRun={{
              runId,
              // A settled run that ended in a failed tool stays unfolded.
              status: "failed" as const,
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
                  runId,
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
                  runId,
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
    expect(_fixture.host.querySelector('[data-timeline-row-id="assistant-entry"]')).toBeNull();
    const meta = _fixture.host.querySelector(
      '[data-timeline-row-id="assistant-meta:assistant-trailing"]',
    );
    const button = meta?.querySelector<HTMLButtonElement>('button[aria-label="Copy message"]');
    expect(button).toBeTruthy();
    await click(_fixture, button!);
    expect(_fixture.writes).toHaveLength(1);
    expect(_fixture.writes[0]!.text).toBe(HEBREW_ASSISTANT);
    const html = parse(_fixture.writes[0]!.html!);
    expect(html.querySelector("h2")?.getAttribute("style")).toBe("direction:rtl;text-align:right");
    expect(html.querySelector("ul")?.getAttribute("dir")).toBe("rtl");
    expect(html.querySelector("pre")?.getAttribute("dir")).toBe("ltr");
  });
});

describe("messageCopyHtml", () => {
  const ASSISTANT_PROFILE = { lineBreaks: false, parseRawHtml: true } as const;

  function renderedRow(
    _fixture: _Fixture,
    messageId: string,
    body: string,
    dir = "rtl",
  ): HTMLElement {
    const row = document.createElement("div");
    row.setAttribute("data-timeline-row-kind", "message");
    row.setAttribute("data-message-id", messageId);
    row.innerHTML = `<div class="chat-markdown" dir="${dir}" data-scient-content-direction="${dir}">${body}</div>`;
    document.body.append(_ownDOM(_fixture, row));
    return row;
  }

  function detachedAnchor(_fixture: _Fixture): HTMLButtonElement {
    return document.body.appendChild(_ownDOM(_fixture, document.createElement("button")));
  }

  it("uses the displayed direction of the message from a separate metadata row", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    // The message displays right-to-left even though its prose alone would not decide it.
    renderedRow(_fixture, "m-1", '<p dir="rtl">x</p>');
    const meta = document.createElement("div");
    meta.setAttribute("data-message-id", "m-1");
    meta.setAttribute("data-timeline-row-kind", "assistant-meta");
    const anchor = meta.appendChild(document.createElement("button"));
    document.body.append(_ownDOM(_fixture, meta));
    const html = messageCopyHtml({
      anchor,
      messageId: "m-1",
      markdown: "Run the tests with Python and שלום.",
      ...ASSISTANT_PROFILE,
    })!;
    expect(parse(html).querySelector("p")?.getAttribute("dir")).toBe("ltr");
    expect(parse(html).querySelector("[data-scient-message-copy]")).not.toBeNull();
  });

  it("renders the message when its row is not mounted", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const html = messageCopyHtml({
      anchor: detachedAnchor(_fixture),
      messageId: "missing",
      markdown: "שלום עולם.",
      ...ASSISTANT_PROFILE,
    });
    expect(parse(html!).querySelector("p")?.getAttribute("style")).toBe(
      "direction:rtl;text-align:right",
    );
  });

  it("keeps every chip, collapsed details body, and diagram source from the Markdown", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
      _fixture,
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

  it("keeps the full TeX of raw-HTML math whose source has nested elements", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const html = parse(
      messageCopyHtml({
        anchor: detachedAnchor(_fixture),
        messageId: "m-6",
        markdown: [
          'שלום <code class="language-math"><span>x</span> + y</code> סוף.',
          "",
          '<pre><code class="language-math"><span>a</span> = b</code></pre>',
        ].join("\n"),
        ...ASSISTANT_PROFILE,
      })!,
    );
    expect(
      [...html.querySelectorAll('span[dir="ltr"]')].map((island) => island.textContent),
    ).toEqual(["$$x + y$$"]);
    expect([...html.querySelectorAll('p[dir="ltr"]')].map((p) => p.textContent)).toEqual([
      "$$\na = b\n$$",
    ]);
  });

  it("keeps math source and replaces images with their description", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const html = parse(
      messageCopyHtml({
        anchor: detachedAnchor(_fixture),
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const row = renderedRow(_fixture, "m-3", '<p dir="rtl">שלום עם הקשר</p>');
    const buttonHost = row.appendChild(document.createElement("div"));
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: buttonHost, router: false }),
    );
    await act(
      async () =>
        await _fixture.root0!.rerender(
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
    await click(_fixture, buttonHost.querySelector("button")!);
    expect(_fixture.writes).toHaveLength(1);
    const html = _fixture.writes[0]!.html!;
    expect(_fixture.writes[0]!.flavors).toContain(COMPOSER_CONTEXT_CLIPBOARD_MIME);
    expect(decodeComposerContextClipboardHtml(html)).toEqual(JSON.parse(CONTEXT_FRAGMENT));
    expect(parse(html).querySelector("p")?.getAttribute("dir")).toBe("rtl");
  });

  it("keeps the context copy unchanged for a message without right-to-left text", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const row = renderedRow(_fixture, "m-4", '<p dir="ltr">Hello</p>', "ltr");
    const buttonHost = row.appendChild(document.createElement("div"));
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: buttonHost, router: false }),
    );
    await act(
      async () =>
        await _fixture.root0!.rerender(
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
    await click(_fixture, buttonHost.querySelector("button")!);
    expect(_fixture.writes[0]!.html).toBe(
      `<pre data-t3-context-fragment="${encodeURIComponent(CONTEXT_FRAGMENT)}">Hello</pre>`,
    );
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    writes: [] as ClipboardWrite[],
    writeTexts: [] as string[],
    _ownedDOM: [] as Node[],

    host: undefined! as HTMLElement,
    stack,
    cleanup,
    root0: null as Screen | null,
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
