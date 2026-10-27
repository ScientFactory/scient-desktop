// Scient timeline behavior in the real browser: fork, attachments, direction, Mermaid copy,
// sub-agent rows and reader ownership. Upstream's own cases stay in MessagesTimeline.browser.test.tsx.
import {
  NodeId,
  OrchestrationV2TurnItemJson,
  OrchestrationV2ContextTransfer,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { ContentDirectionScope } from "../../scient/bidi/ContentDirectionScope";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import {
  deriveAgentPanelModel,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextClipboardHtml,
  decodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { act, fakeTimers, render } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: "Pull request not found",
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));
// Expose which row the list reserves end space for, keeping LegendList's real layout.
vi.mock(import("@legendapp/list/react"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    LegendList: ((props: ComponentProps<typeof actual.LegendList>) => (
      <div style={{ display: "contents" }} data-anchor-index={props.anchoredEndSpace?.anchorIndex}>
        <actual.LegendList {...props} />
      </div>
    )) as typeof actual.LegendList,
  };
});
const liveThreadTitles = new Map<string, string>();
vi.mock(import("../../state/entities"), async (original) => {
  const entities = await original();
  return {
    ...entities,
    useQuietThreadShell: (ref: Parameters<typeof entities.useQuietThreadShell>[0]) => {
      const shell = entities.useQuietThreadShell(ref);
      const title = ref ? liveThreadTitles.get(ref.threadId) : undefined;
      return title === undefined
        ? shell
        : ({
            title,
            archivedAt: null,
            deletedAt: null,
          } as unknown as typeof shell);
    },
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

// Browser image fixtures must decode, unlike static-renderer placeholders.
const BROWSER_IMAGE_URL =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}
function message(
  text: string,
  overrides: Partial<
    Extract<
      Entry,
      {
        kind: "message";
      }
    >["message"]
  > = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}
function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: {
      id,
      createdAt: CREATED_AT,
      ...entry,
    },
  } as Entry;
}
function v2Item(type: string, fields: Record<string, unknown>) {
  const id = (fields.id as string | undefined) ?? type;
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: id,
    item: {
      id,
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type,
      ...fields,
    },
  } as never;
}

async function renderElement(element: ReactElement) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, {
    container,
  });
  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}
function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  return renderElement(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
  );
}
async function copyRange(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const clipboardData = new DataTransfer();
  const event = new ClipboardEvent("copy", {
    bubbles: true,
    cancelable: true,
    clipboardData,
  });
  const target = range.startContainer.parentElement!;
  try {
    await act(async () => target.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    return clipboardData;
  } finally {
    selection.removeAllRanges();
  }
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
describe("MessagesTimeline activity announcements", () => {
  it("keeps one announcer from the empty view into the first turn", async () => {
    const props = baseProps();
    await using screen = await render(<MessagesTimeline {...props} timelineEntries={[]} />);
    const region = screen.container.querySelector<HTMLElement>('[aria-live="polite"].sr-only')!;
    expect(region).not.toBeNull();
    expect(region.textContent).toBe("");
    const running = {
      ...props,
      isWorking: true,
      activeTurnInProgress: true,
      announcedRun: { runId: RunId.make("first-announced-run"), status: "running" as const },
    };
    await screen.rerender(<MessagesTimeline {...running} timelineEntries={[]} />);
    expect(screen.container.querySelector('[aria-live="polite"].sr-only')).toBe(region);
    await expect.element(region).toHaveTextContent("Working");
    await screen.rerender(
      <MessagesTimeline
        {...running}
        routeThreadKey="environment-local:another-thread"
        timelineEntries={[]}
      />,
    );
    await expect.element(region).toBeEmptyDOMElement();
    await screen.rerender(
      <MessagesTimeline
        {...running}
        routeThreadKey="environment-local:another-thread"
        timelineEntries={[]}
        awaitingUser="approval"
        awaitingRequestId="shown-request"
        announceTurnStatus={false}
      />,
    );
    await expect.element(region).toBeEmptyDOMElement();
  });
});

describe("MessagesTimeline work rows", () => {
  it("shows plain text for a V2 reasoning preview and the full trace when opened", async () => {
    const markdown =
      "**Viewing image first** with *care*, ~~old~~ `code` and [context](https://example.com)";
    const expected = "Viewing image first with care, old code and context";
    await using screen = await renderTimeline([
      work("reasoning-preview", {
        label: markdown,
        detail: markdown,
        tone: "thinking",
        itemType: "reasoning",
        toolLifecycleStatus: "completed",
      }),
    ]);
    const row = () => screen.container.querySelector<HTMLElement>("[role=button][aria-expanded]")!;
    const preview = () => row().textContent!.replace(/\s+/g, " ");
    expect(preview()).toContain(expected);
    expect(screen.container.querySelectorAll("strong")).toHaveLength(0);
    await click(row());
    expect(screen.container.querySelectorAll("strong")).toHaveLength(1);
    expect(screen.container.querySelectorAll("[data-scient-reasoning-trace]")).toHaveLength(1);
    await click(row());
    expect(preview()).toContain(expected);
    await vi.waitFor(() => expect(screen.container.querySelectorAll("strong")).toHaveLength(0));
  });
});
describe("MessagesTimeline messages", () => {
  it.each([
    {
      role: "assistant",
      selection: "across",
      findExpanded: false,
    },
    {
      role: "assistant",
      selection: "across",
      findExpanded: true,
    },
    {
      role: "user",
      selection: "across",
      findExpanded: false,
    },
    {
      role: "assistant",
      selection: "inside",
      findExpanded: false,
    },
    {
      role: "user",
      selection: "source",
      findExpanded: false,
    },
  ] as const)(
    "copies Mermaid selection $selection in $role messages (find expanded: $findExpanded)",
    async ({ role, selection, findExpanded }) => {
      const code = "flowchart LR\n    A[Select message] --> B[Copy Markdown]";
      const source = `\`\`\`mermaid\n${code}\n\`\`\``;
      await using screen = await renderTimeline(
        [
          message(`Before diagram.\n\n${source}\n\nAfter diagram.`, {
            role,
          }),
        ],
        {
          findExpanded,
        },
      );
      screen.container.querySelector(".scient-mermaid-card")!.scrollIntoView({
        block: "center",
      });
      const diagram = await vi.waitFor(() => {
        const svg = screen.container.querySelector(".scient-mermaid-inline svg");
        expect(svg).not.toBeNull();
        return svg!;
      });
      const range = document.createRange();
      let expected = source;
      if (selection === "across") {
        const paragraphs = [...screen.container.querySelectorAll("p")];
        const before = paragraphs.find((p) => p.textContent === "Before diagram.")!.firstChild!;
        const after = paragraphs.find((p) => p.textContent === "After diagram.")!.firstChild!;
        range.setStart(before, 2);
        range.setEnd(after, 5);
        expected = `fore diagram.\n\n${source}\n\nAfter`;
      } else if (selection === "inside") {
        const label = [...diagram.querySelectorAll("p, text")].find(
          (element) => element.textContent === "Select message",
        )!;
        const labelText = document.createTreeWalker(label, NodeFilter.SHOW_TEXT).nextNode()!;
        range.setStart(labelText, 2);
        range.setEnd(labelText, 5);
      } else {
        await userEvent.click(screen.button("More diagram actions"));
        await page
          .getByRole("menuitem", {
            name: "Show source",
          })
          .click();
        const code = screen.container.querySelector("pre code")!;
        const firstToken = document.createTreeWalker(code, NodeFilter.SHOW_TEXT).nextNode()!;
        range.setStart(firstToken, 0);
        range.setEnd(firstToken, 9);
        expected = "flowchart";
      }
      const clipboard = await copyRange(range);
      expect.soft(clipboard.getData("text/plain")).toBe(expected);
      if (selection !== "source") {
        const html = new DOMParser().parseFromString(clipboard.getData("text/html"), "text/html");
        html.querySelectorAll("[hidden]").forEach((element) => element.remove());
        expect(html.body.textContent).toContain(code);
      }
    },
  );
  // regression: dd5876e157 fix(web): preserve Mermaid source when copying selected text (#16249)
  it("exports context records only after selecting the chip, not its link in Mermaid source", async () => {
    const record = {
      version: 1 as const,
      kind: "image" as const,
      contextId: ComposerContextId.make("image-1"),
      label: "shot.png",
      attachmentId: "attachment-1",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };
    const link = `[shot.png](t3-context://v1/image/${record.contextId})`;
    const code = `flowchart LR\n    A --> B\n%% ${link}`;
    const source = `\`\`\`mermaid\n${code}\n\`\`\``;
    await using screen = await renderTimeline([
      message(`Before\n\n${source}\n\nAfter\n\n${link}`, {
        context: {
          version: 1,
          records: [record],
        },
        attachments: [
          {
            type: "image",
            id: record.attachmentId,
            name: record.name,
            mimeType: record.mimeType,
            sizeBytes: record.sizeBytes,
          },
        ],
      }),
    ]);
    screen.container.querySelector(".scient-mermaid-card")!.scrollIntoView({
      block: "center",
    });
    await vi.waitFor(() =>
      expect(screen.container.querySelector(".scient-mermaid-inline svg")).not.toBeNull(),
    );
    const paragraphs = [...screen.container.querySelectorAll("p")];
    const before = paragraphs.find((p) => p.textContent === "Before")!.firstChild!;
    const after = paragraphs.find((p) => p.textContent === "After")!.firstChild!;
    const chip = screen.button(/^Image attachment, shot\.png,/);
    const range = document.createRange();
    range.setStart(before, 0);
    range.setEnd(after, 5);
    const withoutChip = await copyRange(range);
    expect(withoutChip.getData("text/plain")).toBe(`Before\n\n${source}\n\nAfter`);
    expect(withoutChip.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)).toBe("");
    expect(decodeComposerContextClipboardHtml(withoutChip.getData("text/html"))).toBeNull();
    range.setEndAfter(chip);
    const withChip = await copyRange(range);
    expect(withChip.getData("text/plain")).toBe(`Before\n\n${source}\n\nAfter\n\n!${link}`);
    expect(
      decodeComposerContextFragment(withChip.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME))?.records,
    ).toEqual([record]);
    expect(decodeComposerContextClipboardHtml(withChip.getData("text/html"))?.records).toEqual([
      record,
    ]);
    const html = new DOMParser().parseFromString(withChip.getData("text/html"), "text/html");
    expect(html.body.textContent).toContain(code);
  });
});

describe("MessagesTimeline Scient messages", () => {
  it("does not show markdown titles in user messages", async () => {
    // same-origin media exercises the image renderer without a remote fetch.
    const localImageUrl = new URL("/favicon-16x16.png", window.location.href).href;
    await using screen = await renderTimeline([
      message(
        // remote images need consent; local images still exercise title stripping
        // (docs/internals/scient-chat-images.md, Contract and ownership).
        '[link](https://example.com "link tip") ![image](https://example.com/image.png "image tip") ' +
          `![local image](${localImageUrl} "image tip")`,
      ),
    ]);
    expect(screen.container.querySelector('a[href="https://example.com"]')).not.toBeNull();
    // the remote image remains a link card until Load image is chosen.
    expect(screen.container.querySelector('img[src="https://example.com/image.png"]')).toBeNull();
    expect(
      screen.container.querySelector('[data-scient-remote-image][aria-label="Web image: image"]'),
    ).not.toBeNull();
    expect(screen.button("Load image from example.com")).toBeDefined();
    expect(screen.container.querySelector('img[alt="local image"]')?.getAttribute("src")).toBe(
      localImageUrl,
    );
    expect(screen.container.querySelector('[title="link tip"], [title="image tip"]')).toBeNull();
  });
  it("forks from a completed assistant response", async () => {
    const onForkFromRun = vi.fn(async () => {});
    // the clicked message is the public fork boundary
    // (docs/internals/scient-fork-divergence.md, Native V2 reliability model).
    const onForkAssistantMessage = vi.fn();
    await using screen = await renderTimeline(
      [
        {
          ...message(
            "Done",
            {
              role: "assistant",
              runId: RunId.make("run-1"),
            },
            "assistant-1",
          ),
          projectedItem: v2Item("assistant_message", {
            id: "assistant-item-1",
            messageId: "assistant-1",
            text: "Done",
            streaming: false,
          }),
        } as Entry,
      ],
      // UPSTREAM.md preserves server-owned boundary resolution.
      {
        onForkFromRun,
        onForkAssistantMessage,
      },
    );
    // Scient fork V2 receives the message, not a client-chosen run boundary.
    await click(screen.button("Fork conversation from this response"));
    expect(onForkAssistantMessage).toHaveBeenCalledExactlyOnceWith("assistant-1");
    expect(onForkFromRun).not.toHaveBeenCalled();
  });
});
const MESSAGE_CREATED_AT = CREATED_AT;
const decodeNativeWorkflowItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const decodeTimelineTransfer = Schema.decodeUnknownSync(OrchestrationV2ContextTransfer);
const buildProps = baseProps;
function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      runId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}
function buildAssistantTimelineEntry(
  options:
    | string
    | {
        readonly id?: string;
        readonly runId?: string;
        readonly streaming?: boolean;
        readonly text?: string;
      } = {},
) {
  const {
    id = "assistant-1",
    runId = "turn-1",
    streaming = false,
    text = "Completed response",
  } = typeof options === "string"
    ? {
        text: options,
      }
    : options;
  return {
    id: `entry-${id}`,
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "assistant" as const,
      text,
      runId: RunId.make(runId),
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming,
    },
  };
}
function buildSnapShotTimelineEntry(previewUrl?: string) {
  const entry = buildUserTimelineEntry("First prompt.");
  return {
    ...entry,
    message: {
      ...entry.message,
      attachments: [
        {
          type: "image" as const,
          id: "attachment-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 1,
          ...(previewUrl
            ? {
                previewUrl,
              }
            : {}),
          source: {
            kind: "snap-shot" as const,
            capturedAt: "2026-03-17T19:12:28.000Z",
            appName: "Terminal",
            windowTitle: "t3code — Tests",
            appIconDataUrl: "data:image/png;base64,aWNvbg==",
          },
        },
      ],
    },
  };
}
async function renderScientMarkup(element: ReactElement) {
  await using host = await renderElement(element);
  await vi.waitFor(() => expect(host.container.textContent?.trim()).not.toBe(""));
  return host.container.innerHTML;
}
// Which handoffs count as fork initialization is decided in Node by
// packages/client-runtime/src/handoff.test.ts; these rows prove the timeline applies it.
it.each(["fork", "proven-inherited"] as const)(
  "renders one fork boundary while preserving %s handoff semantics",
  async (kind) => {
    const item = decodeNativeWorkflowItem({
      id: "fork-init-context-row",
      threadId: "thread-1",
      runId: "fork-first-run",
      nodeId: "first-root",
      providerThreadId: "provider-1",
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "completed",
      title: "Fork context",
      startedAt: MESSAGE_CREATED_AT,
      completedAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      type: "handoff",
      contextHandoffId: "context-1",
      ...(kind === "proven-inherited"
        ? {
            runId: null,
            nodeId: null,
            providerThreadId: null,
            inheritedFrom: {
              threadId: "child",
              itemId: "original-handoff",
              runId: "child-first-run",
              status: "completed",
            },
            forkInitialization: {
              transferId: "old-fork-transfer",
              contextHandoffId: "context-1",
              threadId: "child",
              runId: "child-first-run",
            },
          }
        : {}),
      fromProviderThreadIds: [],
      toProviderThreadId: "provider-1",
      fromProviderInstanceIds: [],
      toProviderInstanceId: "codex",
      strategy: "full_thread_summary",
    });
    const now = DateTime.makeUnsafe(MESSAGE_CREATED_AT);
    const transfer = decodeTimelineTransfer({
      id: "transfer-1",
      type: "fork",
      sourceThreadId: "source",
      targetThreadId: "thread-1",
      sourcePoint: {
        threadId: "source",
      },
      basePoint: null,
      sourceProviderInstanceId: "codex",
      targetProviderInstanceId: "codex",
      targetRunId: "fork-first-run",
      status: "consumed",
      resolution: {
        strategy: "portable_context",
        contextHandoffId: "context-1",
      },
      createdBy: "user",
      error: null,
      createdAt: now,
      updatedAt: now,
      consumedAt: now,
    });
    await using screen = await renderElement(
      <MessagesTimeline
        {...buildProps()}
        hasForkBaseline
        routeThreadKey="environment-local:thread-1"
        forkBaselineAssistantMessageId={null}
        contextTransfers={[transfer]}
        timelineEntries={[
          {
            kind: "event",
            id: item.id,
            createdAt: MESSAGE_CREATED_AT,
            projectedItem: {
              item,
              position: 2,
              visibility: kind === "proven-inherited" ? "inherited" : "local",
              sourceThreadId: ThreadId.make("thread-1"),
              sourceItemId: item.id,
            },
          },
          ...(kind === "proven-inherited"
            ? [
                {
                  kind: "event" as const,
                  id: "later-real-switch",
                  createdAt: MESSAGE_CREATED_AT,
                  projectedItem: {
                    item: decodeNativeWorkflowItem({
                      ...item,
                      id: "later-real-switch",
                      ordinal: 3,
                      startedAt: MESSAGE_CREATED_AT,
                      completedAt: MESSAGE_CREATED_AT,
                      updatedAt: MESSAGE_CREATED_AT,
                      contextHandoffId: "later-provider-context",
                      forkInitialization: undefined,
                      title: "Provider handoff",
                      toProviderInstanceId: "claudeAgent",
                      inheritedFrom: {
                        threadId: "child",
                        itemId: "later-real-switch",
                        runId: "child-second-run",
                        status: "completed",
                      },
                    }),
                    position: 3,
                    visibility: "inherited" as const,
                    sourceThreadId: ThreadId.make("child"),
                    sourceItemId: TurnItemId.make("later-real-switch"),
                  },
                },
              ]
            : []),
        ]}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
    );
    const markup = screen.container.innerHTML;
    expect(markup.match(/Conversation forked here/g)).toHaveLength(1);
    if (kind === "proven-inherited") expect(markup.match(/Context handoff/g)).toHaveLength(1);
    else expect(markup).not.toContain("Context handoff");
  },
);
it("shows Fork beside a completed assistant response, including while a newer turn runs", async () => {
  const userOnly = await renderScientMarkup(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[buildUserTimelineEntry("Fork from here")]}
      onForkAssistantMessage={() => {}}
    />,
  );
  const completedAssistant = await renderScientMarkup(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildAssistantTimelineEntry(),
        buildUserTimelineEntry("Start the next turn"),
      ]}
      runningRunId={RunId.make("turn-2")}
      onForkAssistantMessage={() => {}}
      isWorking
    />,
  );
  expect(userOnly).not.toContain('aria-label="Fork conversation from this response"');
  expect(completedAssistant).toContain('aria-label="Fork conversation from this response"');
});
it("does not expose Fork for a streaming assistant response", async () => {
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildAssistantTimelineEntry({
          streaming: true,
        }),
      ]}
      runningRunId={RunId.make("turn-1")}
      onForkAssistantMessage={() => {}}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).not.toContain('aria-label="Fork conversation from this response"');
});
it("renders assistant image attachments inline without an empty-response placeholder", async () => {
  const entry = buildAssistantTimelineEntry();
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          ...entry,
          message: {
            ...entry.message,
            text: "",
            attachments: [
              {
                type: "image",
                id: "generated-image-1",
                name: "generated-image.png",
                mimeType: "image/png",
                sizeBytes: 12,
                previewUrl: BROWSER_IMAGE_URL,
              },
            ],
          },
        },
      ]}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain('aria-label="Image attachment"');
  expect(markup).toContain('aria-label="Preview generated-image.png"');
  expect(markup).toContain('crossorigin="anonymous"');
  expect(markup).not.toContain("(empty response)");
});
it("renders the prior Scient fork separator once and retains outbound fork navigation", async () => {
  const { MessagesTimeline } = await import("./MessagesTimeline");
  const event = (id: string, targetThreadId: string) => ({
    kind: "event" as const,
    id,
    createdAt: MESSAGE_CREATED_AT,
    projectedItem: {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: ThreadId.make("thread-1"),
      sourceItemId: TurnItemId.make(id),
      item: decodeNativeWorkflowItem({
        id,
        threadId: "thread-1",
        type: "fork",
        runId: null,
        nodeId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: MESSAGE_CREATED_AT,
        source:
          targetThreadId === "thread-1"
            ? {
                type: "run",
                threadId: "original-thread",
                runId: "original-run",
              }
            : {
                type: "node",
                nodeId: "outgoing-source-node",
              },
        targetThreadId,
      }),
    },
  });
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      hasForkBaseline
      routeThreadKey="environment-local:thread-1"
      forkBaselineAssistantMessageId={null}
      timelineEntries={[event("incoming-fork", "thread-1"), event("outgoing-fork", "next-child")]}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup.match(/Conversation forked here/g)).toHaveLength(1);
  expect(markup).not.toContain("Forked from conversation");
  expect(markup).toContain("Open fork");
});
it("applies Scient BiDi to user messages while keeping HTML literal", async () => {
  const { MessagesTimeline } = await import("./MessagesTimeline");
  await using screen = await renderElement(
    <ContentDirectionScope direction="rtl">
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "הפסקה הראשונה",
              "",
              "- פריט אחד",
              "- English item",
              "",
              "שלב ראשון → שלב שני",
              "",
              "```",
              "שלום → עולם",
              "```",
              "",
              '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">',
            ].join("\n"),
          ),
        ]}
      />
    </ContentDirectionScope>,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain('dir="rtl"');
  expect(markup).toContain("<ul");
  expect(markup).toContain("שלב ראשון ← שלב שני");
  expect(markup).toContain("שלום → עולם");
  expect(markup).toContain("&lt;script&gt;globalThis.__t3Xss = 1&lt;/script&gt;");
  expect(markup).toContain("onerror=");
  expect(markup).not.toMatch(/<script(?:\s|>)/i);
  expect(markup).not.toMatch(/<img(?:\s|>)/i);
});
it("gives a kept earlier answer the final answer's copy button", async () => {
  const assistant = (id: string, text: string, second: number) => ({
    id: `${id}-entry`,
    kind: "message" as const,
    createdAt: `2026-01-01T00:00:0${second}Z`,
    message: {
      id: MessageId.make(id),
      role: "assistant" as const,
      text,
      runId: RunId.make("run-kept"),
      createdAt: `2026-01-01T00:00:0${second}Z`,
      updatedAt: `2026-01-01T00:00:0${second}Z`,
      streaming: false,
    },
  });
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        assistant("note", "Let me check the tests…", 1),
        assistant("answer", "## Diagnosis\nThe cache key ignores the locale.", 2),
        assistant("final", "Done.", 3),
      ]}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup.match(/aria-label="Copy message"/g)).toHaveLength(2);
  expect(markup).not.toContain('data-timeline-row-id="note-entry"');
});
it("renders trailing tool calls as part of the terminal assistant block", async () => {
  const runId = RunId.make("turn-trailing-tools");
  const assistantMessageId = MessageId.make("assistant-trailing-tools");
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      latestRun={{
        runId,
        status: "failed",
        startedAt: "2026-03-17T19:12:20.000Z",
        completedAt: "2026-03-17T19:12:30.000Z",
      }}
      onForkAssistantMessage={() => {}}
      timelineEntries={[
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: MESSAGE_CREATED_AT,
          message: {
            id: assistantMessageId,
            role: "assistant",
            text: "I’ll search for it now.",
            runId,
            createdAt: MESSAGE_CREATED_AT,
            updatedAt: "2026-03-17T19:12:29.000Z",
            streaming: false,
          },
        },
        {
          id: "trailing-work-entry",
          kind: "work",
          createdAt: "2026-03-17T19:12:30.000Z",
          entry: {
            id: "trailing-work",
            createdAt: "2026-03-17T19:12:30.000Z",
            runId,
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            toolLifecycleStatus: "failed",
          },
        },
      ]}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  const messageIndex = markup.indexOf('data-timeline-row-id="assistant-entry"');
  const toolIndex = markup.indexOf('data-timeline-row-id="trailing-work-entry"');
  const metaIndex = markup.indexOf(
    'data-timeline-row-id="assistant-meta:assistant-trailing-tools"',
  );
  expect(messageIndex).toBeGreaterThanOrEqual(0);
  expect(toolIndex).toBeGreaterThan(messageIndex);
  expect(metaIndex).toBeGreaterThan(toolIndex);
  expect(markup.match(/I’ll search for it now\./gu)).toHaveLength(1);
  expect(markup).not.toContain('aria-label="Fork conversation from this response"');
});
// regression: cdcacd8050 fix(chat): route capability failures to their owning controls
it("announces a runtime failure as an operation, preserving the concise label", async () => {
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "runtime-failure",
          kind: "work",
          createdAt: "2026-09-29T00:00:00.000Z",
          entry: {
            id: "runtime-failure",
            createdAt: "2026-09-29T00:00:00.000Z",
            label: "The agent encountered a problem",
            tone: "error",
            sourceActivityKind: "runtime.error",
            detail: "Internal diagnostic details",
          },
        },
      ]}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain('aria-label="Operation failed"');
  expect(markup).not.toContain("tool call failed");
  expect(markup).toContain("The agent encountered a problem");
});

it("opens the native workflow roster from its timeline row without reading V1 activities", async () => {
  const now = DateTime.makeUnsafe(MESSAGE_CREATED_AT);
  const common = {
    prompt: "Audit",
    title: "Audit",
    model: null,
    status: "running" as const,
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  const model = deriveAgentPanelModel({
    agents: [],
    v2Projection: projectedSubagentsToRuntime([
      {
        ...common,
        id: "workflow",
        presentation: {
          kind: "workflow",
          workflowName: "Evidence audit",
          phases: [
            {
              index: 0,
              title: "Review",
            },
          ],
        },
      },
      {
        ...common,
        id: "member",
        title: "Source reader",
        presentation: {
          kind: "workflow_agent",
          workflowId: NodeId.make("workflow"),
          phaseIndex: 0,
          role: "researcher",
        },
      },
    ]),
  });
  const item = decodeNativeWorkflowItem({
    id: "native-workflow-item",
    threadId: "thread-1",
    runId: "run-1",
    nodeId: "workflow",
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "running",
    title: "Audit",
    startedAt: MESSAGE_CREATED_AT,
    completedAt: null,
    updatedAt: MESSAGE_CREATED_AT,
    type: "subagent",
    subagentId: "workflow",
    origin: "provider_native",
    driver: "claude-code",
    providerInstanceId: "claude-code",
    childThreadId: null,
    prompt: "Audit",
    result: null,
  });
  const onOpenAgents = vi.fn();
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      isWorking
      runningRunId={RunId.make("run-1")}
      agentPanelModel={model}
      onOpenAgents={onOpenAgents}
      timelineEntries={[
        {
          id: "native-workflow-item",
          kind: "event",
          createdAt: MESSAGE_CREATED_AT,
          projectedItem: {
            item,
            position: 0,
            visibility: "local",
            sourceThreadId: ThreadId.make("thread-1"),
            sourceItemId: item.id,
          },
        },
      ]}
    />,
  );
  await click(screen.container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);
  expect(screen.text()).toContain("Evidence audit");
  expect(screen.text()).toContain("Source reader");
  expect(screen.text()).toContain("researcher");
  await click(screen.button(/Agents/));
  expect(onOpenAgents).toHaveBeenCalledOnce();
});
describe("sub-agent rows: what runs, whether it is alive, how it ended", () => {
  // V2 turn items as the server projects them for two Droid Task calls and a TaskOutput wait.
  const START = Date.parse(MESSAGE_CREATED_AT);
  const at = (seconds: number) => new Date(START + seconds * 1_000).toISOString();
  const runId = RunId.make("turn-subagents");
  const threadId = ThreadId.make("thread-subagents");
  const itemBase = {
    threadId,
    runId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
  };
  const note = "Droid reports a sub-agent's steps only when it finishes.";
  const subagent = (
    id: string,
    title: string,
    ordinal: number,
    status: "running" | "cancelled",
  ): Extract<
    OrchestrationV2TurnItem,
    {
      type: "subagent";
    }
  > => ({
    ...itemBase,
    id: TurnItemId.make(id),
    nodeId: NodeId.make(id),
    ordinal,
    type: "subagent",
    subagentId: NodeId.make(id),
    origin: "provider_native",
    driver: ProviderDriverKind.make("droid"),
    providerInstanceId: ProviderInstanceId.make("droid"),
    childThreadId: null,
    title,
    prompt: title,
    progress: note,
    result: status === "cancelled" ? "Cancelled when you sent a follow-up message." : null,
    status,
    startedAt: DateTime.makeUnsafe(at(60)),
    completedAt: status === "cancelled" ? DateTime.makeUnsafe(at(90)) : null,
    updatedAt: DateTime.makeUnsafe(at(status === "cancelled" ? 90 : 60)),
  });
  const subagents = [
    subagent("task-ci", "Audit build, CI, and release pipeline", 0, "running"),
    subagent("task-code", "Audit scient-desktop code smells", 1, "cancelled"),
  ];
  const waiting: OrchestrationV2TurnItem = {
    ...itemBase,
    id: TurnItemId.make("wait-1"),
    nodeId: NodeId.make("root"),
    ordinal: 2,
    type: "dynamic_tool",
    toolName: "TaskOutput",
    input: {
      taskId: "task-ci",
      timeout: 600_000,
    },
    status: "running",
    title: "Waiting for sub-agent · Review OMP host integration (up to 10 min)",
    startedAt: DateTime.makeUnsafe(at(100)),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(at(100)),
  };
  const timeline = (items: ReadonlyArray<OrchestrationV2TurnItem>) => ({
    isWorking: true,
    runningRunId: runId,
    activeTurnStartedAt: MESSAGE_CREATED_AT,
    latestRun: {
      runId,
      status: "running" as const,
      startedAt: MESSAGE_CREATED_AT,
      completedAt: null,
    },
    agentPanelModel: deriveAgentPanelModel({
      agents: [],
      v2Projection: projectedSubagentsToRuntime(
        items.flatMap((item) =>
          item.type === "subagent"
            ? [
                {
                  ...item,
                  model: null,
                  presentation: {
                    kind: "subagent",
                    role: "explorer",
                  },
                },
              ]
            : [],
        ),
      ),
    }),
    timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
      optimisticMessages: [],
      visibleTurnItems: items.map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      })),
    }),
  });
  function setupSubagentClock() {
    const clock = fakeTimers();
    vi.setSystemTime(START + 125_000);
    return clock;
  }
  it("says on the collapsed row how many sub-agents work and for how long", async () => {
    await using screen = await renderElement(<></>);
    using _clock = setupSubagentClock();

    await screen.rerender(<MessagesTimeline {...buildProps()} {...timeline(subagents)} />);
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
    );
    const markup = screen.container.innerHTML;
    expect(markup).toContain("Kicked off 2 subagents · 1 working");
    // Since the launch, not since the turn began ("Working for 2m 5s").
    expect(markup).toContain("1m 5s");
  });
  it("lists each sub-agent with its type, a live timer, and why it stopped", async () => {
    await using screen = await renderElement(<></>);
    using _clock = setupSubagentClock();

    await screen.rerender(<MessagesTimeline {...buildProps()} {...timeline(subagents)} />);
    await click(screen.container.querySelector<HTMLElement>('[aria-expanded="false"]')!);
    expect(screen.text()).toContain("Audit build, CI, and release pipeline");
    expect(screen.text()).toContain("explorer");
    expect(screen.text()).toContain("Working");
    expect(screen.text()).toContain("1m 5s");
    expect(screen.text()).toContain(note);
    expect(screen.text()).toContain("Audit scient-desktop code smells");
    expect(screen.text()).toContain("Stopped");
    expect(screen.text()).toContain("Cancelled when you sent a follow-up message.");
  });
  it("keeps explicitly opened Scient members visible when the last background child settles", async () => {
    const members = subagents.map((item) => ({
      ...item,
      driver: ProviderDriverKind.make("scient"),
      status: "running" as const,
      result: null,
      completedAt: null,
      childThreadId: ThreadId.make(`child-${item.subagentId}`),
    }));
    const parentSettled = {
      isWorking: false,
      runningRunId: null,
      latestRun: {
        runId,
        status: "completed" as const,
        startedAt: MESSAGE_CREATED_AT,
        completedAt: at(120),
      },
    };
    const props = buildProps();
    await using screen = await renderElement(<></>);
    using _clock = setupSubagentClock();

    await screen.rerender(
      <MessagesTimeline {...props} {...timeline(members)} {...parentSettled} />,
    );
    const host = screen.container;
    const group = () =>
      [...host.querySelectorAll<HTMLElement>("button[aria-expanded]")].find((row) =>
        row.textContent?.includes("2 subagents"),
      )!;
    await click(group());
    expect(host.querySelectorAll('[role="button"]')).toHaveLength(2);
    const completed = members.map((item) => ({
      ...item,
      status: "completed" as const,
      result: "Observed child result",
      completedAt: DateTime.makeUnsafe(at(125)),
    }));
    await screen.rerender(
      <MessagesTimeline {...props} {...timeline(completed)} {...parentSettled} />,
    );
    expect(host.querySelectorAll('[role="button"]')).toHaveLength(2);
    expect(group().getAttribute("aria-expanded")).toBe("true");
    await click(group());
    await vi.waitFor(() => expect(host.querySelectorAll('[role="button"]')).toHaveLength(0));
  });
  it("shows what a long-running step waits for and how long it has run", async () => {
    await using screen = await renderElement(<></>);
    using _clock = setupSubagentClock();

    await screen.rerender(<MessagesTimeline {...buildProps()} {...timeline([waiting])} />);
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
    );
    const markup = screen.container.innerHTML;
    expect(markup).toContain("Waiting for sub-agent · Review OMP host integration (up to 10 min)");
    // 25 s since the wait began.
    expect(markup).toContain(" · 25s");
  });
  it("keeps a step that has only just begun free of a timer", async () => {
    await using screen = await renderElement(<></>);
    using _clock = setupSubagentClock();
    vi.setSystemTime(START + 104_000);
    await screen.rerender(<MessagesTimeline {...buildProps()} {...timeline([waiting])} />);
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
    );
    const markup = screen.container.innerHTML;
    expect(markup).toContain("Waiting for sub-agent");
    expect(markup).not.toContain(" · 4s");
  });
});

it("anchors the first user message using its measured height", async () => {
  const onAnchorReady = vi.fn();
  const onAnchorSizeChanged = vi.fn();
  const firstEntry = buildSnapShotTimelineEntry(BROWSER_IMAGE_URL);
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      anchorMessageId={firstEntry.message.id}
      onAnchorReady={onAnchorReady}
      onAnchorSizeChanged={onAnchorSizeChanged}
      contentInsetEndAdjustment={144}
      timelineEntries={[firstEntry]}
    />,
  );
  // The image load and the list's measurement can outlast a second on a busy runner.
  await vi.waitFor(() => {
    const image = screen.container.querySelector<HTMLImageElement>('img[alt="screenshot.png"]');
    expect(image?.complete).toBe(true);
    expect(image?.naturalWidth).toBe(1);
    expect(onAnchorReady).toHaveBeenCalledWith(firstEntry.message.id, 0);
    expect(onAnchorSizeChanged).toHaveBeenCalledWith(firstEntry.message.id, expect.any(Number));
    expect(onAnchorSizeChanged.mock.lastCall?.[1]).toBeGreaterThan(0);
  });
  const markup = screen.container.innerHTML;
  expect(markup).toContain('data-anchor-index="0"');
  // Snapshot window details appear once the decoded image resolves.
  expect(markup).toContain("Terminal");
  expect(markup).toContain("t3code — Tests");
  expect(markup).toContain('src="data:image/png;base64,aWNvbg=="');
  // Decoding the image can trigger another real LegendList measurement.
  expect(onAnchorReady.mock.calls).toEqual(
    Array.from(
      {
        length: onAnchorReady.mock.calls.length,
      },
      () => [firstEntry.message.id, 0],
    ),
  );
});

// regression: 2274444e92 fix(chat): stop pushing follow-up messages to the top (#7897)
it("does not reserve end space for a follow-up user message", async () => {
  const onAnchorReady = vi.fn();
  const firstEntry = buildUserTimelineEntry("First prompt.");
  const secondEntry = {
    ...buildUserTimelineEntry("Newest prompt."),
    id: "entry-2",
    message: {
      ...buildUserTimelineEntry("Newest prompt.").message,
      id: MessageId.make("message-2"),
    },
  };
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      anchorMessageId={secondEntry.message.id}
      onAnchorReady={onAnchorReady}
      timelineEntries={[firstEntry, secondEntry]}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  expect(screen.container.innerHTML).not.toContain("data-anchor-index=");
  expect(onAnchorReady).not.toHaveBeenCalled();
});
it("renders T3 MCP dynamic tools with the product logo and pretty name", async () => {
  const { MessagesTimeline } = await import("./MessagesTimeline");
  const item = {
    id: "tool-t3-thread-read",
    threadId: "thread-source",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: {},
    type: "dynamic_tool",
    toolName: "mcp__t3-code__t3_thread_read",
    input: {
      threadId: "thread-child",
    },
    output: {
      messages: [],
    },
  } as const;
  const projectedItem = {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-source",
    sourceItemId: item.id,
    item,
  } as const;
  const markup = await renderScientExpandedMarkup(
    true,
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={
        [
          {
            id: "context-info-entry",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "context-info",
              createdAt: MESSAGE_CREATED_AT,
              label: "Session started",
              tone: "info",
            },
          },
          {
            id: item.id,
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: item.id,
              createdAt: MESSAGE_CREATED_AT,
              runId: null,
              label: item.toolName,
              tone: "tool",
              itemType: item.type,
              toolTitle: item.toolName,
              toolLifecycleStatus: "completed",
              toolData: {
                input: item.input,
                output: item.output,
              },
              structuredPayload: item,
              projectedItem,
            },
          },
        ] as never
      }
    />,
  );

  // Known historical MCP namespaces use the current Scient trace symbol.
  expect(markup).toContain("scient-trace-symbol.svg");
  expect(markup).toContain("Read a Scient thread");
  expect(markup).not.toContain("mcp__t3-code__t3_thread_read");

  // With a live title, screen readers hear it too.
  liveThreadTitles.set("thread-child", "Review auth flow");
  try {
    const titled = await renderScientExpandedMarkup(
      true,
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={
          [
            {
              id: item.id,
              kind: "work",
              createdAt: MESSAGE_CREATED_AT,
              entry: {
                id: item.id,
                createdAt: MESSAGE_CREATED_AT,
                runId: null,
                label: item.toolName,
                tone: "tool",
                itemType: item.type,
                toolTitle: item.toolName,
                toolLifecycleStatus: "completed",
                toolData: {
                  input: item.input,
                  output: item.output,
                },
                structuredPayload: item,
                projectedItem,
              },
            },
          ] as never
        }
      />,
    );
    expect(titled).toMatch(/aria-label="[^"]*Review auth flow/);
  } finally {
    liveThreadTitles.clear();
  }
});
async function renderScientExpandedMarkup(expand: boolean, element: ReactElement) {
  await using host = await renderElement(element);
  await vi.waitFor(() =>
    expect(host.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  if (expand) {
    const toggle = host.container.querySelector<HTMLElement>(
      'button[aria-expanded="false"], [role="button"][aria-expanded="false"]',
    );
    if (toggle) {
      await click(toggle);
      const toolCalls = host.container.querySelector('[role="region"][aria-label="Tool calls"]');
      if (toolCalls) await vi.waitFor(() => expect(toolCalls.textContent).not.toBe(""));
    }
  }
  return host.container.innerHTML;
}
it("draws website tool icons locally instead of fetching a web favicon", async () => {
  const websiteEntry = (
    id: string,
    toolIcon: {
      pageUrl: string;
      faviconUrl?: string;
    },
  ) => ({
    id: `entry-${id}`,
    kind: "work" as const,
    createdAt: "2026-03-17T19:12:28.000Z",
    entry: {
      id: `work-${id}`,
      createdAt: "2026-03-17T19:12:28.000Z",
      label: `Opened page ${id}`,
      tone: "tool" as const,
      toolIcon: {
        _tag: "website" as const,
        ...toolIcon,
      },
    },
  });
  const render = (entry: ReturnType<typeof websiteEntry>) =>
    renderScientMarkup(<MessagesTimeline {...buildProps()} timelineEntries={[entry]} />);

  // A page's /favicon.ico, a provider-supplied web favicon, and GitHub's hosted assets.
  for (const markup of [
    await render(
      websiteEntry("plain", {
        pageUrl: "https://example.org/report",
      }),
    ),
    await render(
      websiteEntry("explicit", {
        pageUrl: "https://example.org/report",
        faviconUrl: "https://cdn.example.org/icon.png",
      }),
    ),
    await render(
      websiteEntry("github", {
        pageUrl: "https://github.com/pingdotgg/t3code",
      }),
    ),
  ]) {
    expect(markup).toContain("Opened page");
    expect(markup).not.toMatch(/<img[^>]*src="(?:https?:)?\/\//u);
    expect(markup).not.toContain('rel="preload"');
  }
  // Icon bytes the provider already delivered still draw.
  expect(
    await render(
      websiteEntry("inline", {
        pageUrl: "https://example.org/report",
        faviconUrl: "data:image/png;base64,iVBORw0KGgo=",
      }),
    ),
  ).toContain('src="data:image/png;base64,iVBORw0KGgo="');
});

it("collapses settled tool runs behind a generated summary toggle", async () => {
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          ...buildUserTimelineEntry(
            "![shot.png](t3-context://v1/image/img-1) [notes.txt](t3-context://v1/file/file-1) [legacy.txt](t3-context://v1/file/legacy)",
          ),
          id: "attachment-message",
          message: {
            ...buildUserTimelineEntry(
              "![shot.png](t3-context://v1/image/img-1) [notes.txt](t3-context://v1/file/file-1) [legacy.txt](t3-context://v1/file/legacy)",
            ).message,
            context: {
              version: 1,
              records: [
                {
                  version: 1,
                  contextId: ComposerContextId.make("img-1"),
                  kind: "image",
                  label: "shot.png",
                  attachmentId: "img-1",
                  name: "shot.png",
                  mimeType: "image/png",
                  sizeBytes: 1024,
                },
                {
                  version: 1,
                  contextId: ComposerContextId.make("file-1"),
                  kind: "file",
                  label: "notes.txt",
                  attachmentId: "file-1",
                  name: "notes.txt",
                  mimeType: "text/plain",
                  sizeBytes: 1024,
                },
              ],
            },
            attachments: [
              {
                type: "image",
                id: "img-1",
                name: "shot.png",
                mimeType: "image/png",
                sizeBytes: 1024,
                previewUrl: "data:image/png;base64,aA==",
              },
              {
                type: "file",
                id: "file-1",
                name: "notes.txt",
                mimeType: "text/plain",
                sizeBytes: 1024,
                downloadable: false,
              },
            ],
          },
        },
        {
          id: "entry-1",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-1",
            runId: RunId.make("run-1"),
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Ran command",
            command: "vp lint",
            tone: "tool",
            itemType: "command_execution",
            toolLifecycleStatus: "completed",
          },
        },
        {
          id: "entry-2",
          kind: "work",
          createdAt: "2026-03-17T19:12:29.000Z",
          entry: {
            id: "work-2",
            runId: RunId.make("run-1"),
            createdAt: "2026-03-17T19:12:29.000Z",
            label: "Ran command",
            command: "vp test run",
            tone: "tool",
            itemType: "command_execution",
            toolLifecycleStatus: "completed",
          },
        },
      ]}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;

  // Images report their size like every other attachment chip.
  expect(markup).toContain('aria-label="Image attachment, shot.png, 1 KB"');
  // Selection copy re-emits chips as their canonical links.
  expect(markup).toContain('data-markdown-copy="![shot.png](t3-context://v1/image/img-1)"');
  expect(markup).toContain('aria-label="File attachment, notes.txt, 1 KB"');
  expect(markup).toContain(">1 KB</span>");
  expect(markup).not.toContain('aria-label="Download notes.txt"');
  expect(markup).toContain("legacy.txt");
  expect(markup).not.toContain('href="t3-context://');

  // The static test forced expandedRunIds; open the actual outer fold in the browser.
  const turnFold = screen.button(/^Worked for/);
  expect(turnFold.getAttribute("aria-expanded")).toBe("false");
  expect(screen.text()).not.toContain("Ran 2 commands");
  await click(turnFold);
  await vi.waitFor(() =>
    expect(screen.button("Ran 2 commands").getAttribute("aria-expanded")).toBe("false"),
  );
  expect(screen.text()).not.toContain("vp lint");
  expect(screen.text()).not.toContain("vp test run");
  await click(screen.button("Ran 2 commands"));
  await vi.waitFor(() => {
    expect(screen.text()).toContain("vp lint");
    expect(screen.text()).toContain("vp test run");
  });
});

it.each([true, false])(
  "keeps the reading row in place when tool output toggles at the end: %s",
  async (isAtEnd) => {
    const props = buildProps();
    const history = Array.from(
      {
        length: 12,
      },
      (_, i) =>
        message(
          "Earlier response " + i + "\n\n" + "Long paragraph. ".repeat(80),
          {
            role: "assistant",
          },
          "history-" + i,
        ),
    );
    const tool = (detail: string) =>
      work("tool", {
        label: "Run command",
        tone: "tool",
        toolLifecycleStatus: "completed",
        detail,
      });
    const timeline = (detail: string) => (
      <MessagesTimeline {...props} timelineEntries={[...history, tool(detail)]} />
    );
    await using screen = await renderElement(timeline("Command output"));
    await vi.waitFor(() => expect(props.listRef.current?.getScrollableNode()).not.toBeNull());
    const viewport = props.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight));
    await act(async () => {
      viewport.scrollTop = viewport.scrollHeight;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await vi.waitFor(() => expect(screen.button("Command output")).toBeDefined());
    if (!isAtEnd)
      await userEvent.wheel(viewport, {
        delta: {
          y: -100,
        },
      });
    const advanceLayout = () => act(() => vi.advanceTimersByTimeAsync(64));
    using _clock = fakeTimers();
    await advanceLayout();
    const offset = viewport.scrollTop;
    for (const expanded of [true, false]) {
      await click(screen.container.querySelector<HTMLElement>('[role="button"][aria-expanded]')!);
      await advanceLayout();
      expect(viewport.scrollTop).toBeCloseTo(offset, 0);
      // A late detail update uses the same reader owner as the initial disclosure.
      if (expanded) {
        await screen.rerender(timeline("Command output\n" + "Late output\n".repeat(8)));
        await advanceLayout();
        expect(viewport.scrollTop).toBeCloseTo(offset, 0);
      }
    }
  },
);

// regression: cf7bfd1c93 fix(web): preserve XML-like tags in user messages (#4133)
it("preserves XML-like source inside user code spans and fences", async () => {
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildUserTimelineEntry(
          [
            'Inline `<tag attr="x">`',
            "",
            "```xml",
            '<root><child enabled="true" /></root>',
            "```",
          ].join("\n"),
        ),
      ]}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain("data-inline-code");
  expect(screen.container.querySelector("code[data-inline-code]")?.textContent).toBe(
    '<tag attr="x">',
  );
  expect(screen.container.textContent).toContain('<root><child enabled="true" /></root>');
});
// regression: cf7bfd1c93 fix(web): preserve XML-like tags in user messages (#4133)
// The only timeline test that fails when the sanitizer is removed from the render pipeline.
it("sanitizes executable HTML while preserving supported assistant markup", async () => {
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildAssistantTimelineEntry({
          text: [
            '<details open onclick="globalThis.__t3Xss = 1">',
            "<summary>Safe details</summary>",
            "<script>globalThis.__t3Xss = 2</script>",
            '<img src="x" onerror="globalThis.__t3Xss = 3">',
            '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
            "</details>",
          ].join(""),
        }),
      ]}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain('data-markdown-details=""');
  expect(markup).toContain("Safe details");
  expect(markup).not.toMatch(/<script(?:\s|>)/i);
  expect(markup).not.toContain("onclick=");
  expect(markup).not.toContain("onerror=");
  expect(markup).not.toContain("javascript:");
  expect(markup).not.toContain("globalThis.__t3Xss");
});

// regression: f1e6f0c9bb fix(web): stop showing red x summaries for ordinary tool failures (#8395)
it("keeps the collapsed summary icon neutral when the group ends in a failure", async () => {
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-completed",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-completed",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Run tests",
            tone: "tool",
            itemType: "command_execution",
            toolLifecycleStatus: "completed",
          },
        },
        {
          id: "entry-failed",
          kind: "work",
          createdAt: "2026-03-17T19:12:29.000Z",
          entry: {
            id: "work-failed",
            createdAt: "2026-03-17T19:12:29.000Z",
            label: "Run lint",
            tone: "tool",
            itemType: "command_execution",
            toolLifecycleStatus: "failed",
          },
        },
      ]}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain("Ran 2 commands");
  expect(markup).toContain("lucide-square-terminal-lowered");
  expect(markup).not.toContain("lucide-circle-x");
  expect(markup).not.toContain("text-destructive");
  expect(markup).toContain("tool call failed");
});
// regression: f1e6f0c9bb fix(web): stop showing red x summaries for ordinary tool failures (#8395)
it("renders a muted failure marker for failed tool lifecycle entries", async () => {
  const markup = await renderScientExpandedMarkup(
    true,
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-info",
          kind: "work",
          createdAt: "2026-03-17T19:12:27.000Z",
          entry: {
            id: "work-info",
            createdAt: "2026-03-17T19:12:27.000Z",
            label: "Status updated",
            tone: "info",
          },
        },
        {
          id: "entry-1",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-1",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Glob",
            tone: "tool",
            toolLifecycleStatus: "failed",
            detail: "No files found",
          },
        },
      ]}
    />,
  );
  expect(markup).toContain("lucide-folder-open");
  expect(markup).toContain('aria-label="Tool call failed"');
  expect(markup).not.toContain("text-destructive");
});
// regression: cac738b234 fix(timeline): refine trace symbols and thought typography
// An expanded group draws both the group summary icon and each entry's icon.
it("marks generic dynamic tools with a wrench in an expanded group", async () => {
  const count = 2;
  const markup = await renderScientExpandedMarkup(
    true,
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={Array.from(
        {
          length: count,
        },
        (_, index) => ({
          id: `entry-dynamic-tool-${index}`,
          kind: "work" as const,
          createdAt: MESSAGE_CREATED_AT,
          entry: {
            id: `work-dynamic-tool-${index}`,
            createdAt: MESSAGE_CREATED_AT,
            toolCallId: `call-dynamic-tool-${index}`,
            label: "lsp",
            toolTitle: "lsp",
            tone: "tool" as const,
            itemType: "dynamic_tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        }),
      )}
    />,
  );
  expect(markup.match(/\blucide-wrench\b/g)).toHaveLength(count + 1);
  expect(markup).not.toContain('data-scient-symbol="mono"');
  expect(markup).not.toContain("lucide-hammer");
  expect(markup).not.toContain("lucide-blocks");
});

// regression: e0e4158af1 Merge official T3 through d8e9fd267e with Scient policy composition
it("renders elapsed time for a completed turn", async () => {
  const runId = RunId.make("turn-with-fold");
  const assistantEntry = buildAssistantTimelineEntry({
    text: "Done.",
  });
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      latestRun={{
        runId,
        status: "completed",
        startedAt: "2026-03-17T19:12:20.000Z",
        completedAt: "2026-03-17T19:12:28.000Z",
      }}
      timelineEntries={[
        {
          id: "work-entry-with-fold",
          kind: "work",
          createdAt: "2026-03-17T19:12:22.000Z",
          entry: {
            id: "work-with-fold",
            createdAt: "2026-03-17T19:12:22.000Z",
            runId,
            label: "Ran command",
            tone: "tool",
            toolLifecycleStatus: "completed",
          },
        },
        {
          ...assistantEntry,
          message: {
            ...assistantEntry.message,
            runId,
          },
        },
      ]}
    />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain("Worked for 8.0s");
});
