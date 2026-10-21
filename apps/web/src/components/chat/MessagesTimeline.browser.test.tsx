import { RegistryProvider } from "@effect/atom-react";
import {
  ApprovalRequestId,
  NodeId,
  OrchestrationV2TurnItemJson,
  OrchestrationV2ContextTransfer,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  CheckpointRef,
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
import { createRef, Profiler, type ComponentProps, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { serverEnvironment } from "../../state/server";
import { PullRequestLinkPreview } from "../pullRequest/PullRequestLinkPreview";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "../ui/tooltip";
import { act, fakeTimers, render } from "../../../test/render";
import timelineVideoUrl from "../../../test/fixtures/silent-video.mp4?url";
import { MessagesTimeline, remarkThoughtPreview } from "./MessagesTimeline";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { CHAT_MARKDOWN_REMARK_PLUGINS } from "../../scient/markdown/scientMarkdownPipeline";
import {
  scientMathMarkdownText,
  scientMathRemarkPluginsForMessage,
} from "../../scient/math/scientMathText";
import { readTimelinePosition } from "./timelineScrollAnchoring";
import { useComposerFocusState } from "./useComposerFocusState";

const pullRequestQuery = vi.hoisted(() => ({ error: "Pull request not found" }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: pullRequestQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

// Inspect configuration while retaining LegendList's actual browser layout and effects.
vi.mock(import("@legendapp/list/react"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    LegendList: ((props: ComponentProps<typeof actual.LegendList>) => {
      const visible = props.maintainVisibleContentPosition;
      return (
        <div
          data-scient-list-probe="true"
          style={{ display: "contents" }}
          data-anchor-index={props.anchoredEndSpace?.anchorIndex}
          data-anchor-offset={props.anchoredEndSpace?.anchorOffset}
          data-anchor-max-size={props.anchoredEndSpace?.anchorMaxSize}
          data-content-inset-end={props.contentInsetEndAdjustment}
          data-maintain-scroll-at-end={props.maintainScrollAtEnd ? "enabled" : undefined}
          data-maintain-visible-content-position={
            typeof visible === "object" ? "object" : String(visible)
          }
          data-maintain-visible-content-position-size={
            typeof visible === "object" ? visible.size : undefined
          }
          data-maintain-visible-content-position-data={
            typeof visible === "object" ? visible.data : undefined
          }
        >
          <actual.LegendList {...props} />
        </div>
      );
    }) as typeof actual.LegendList,
  };
});
const liveThreadTitles = new Map<string, string>();
vi.mock(import("../../state/entities"), async (original) => {
  const entities = await original();
  return {
    ...entities,
    useThreadShell: (ref: Parameters<typeof entities.useThreadShell>[0]) => {
      const shell = entities.useThreadShell(ref);
      const title = ref ? liveThreadTitles.get(ref.threadId) : undefined;
      return title === undefined
        ? shell
        : ({ title, archivedAt: null, deletedAt: null } as unknown as typeof shell);
    },
  };
});
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => vi.fn(),
  Link: (({
    children,
    to: _to,
    params: _params,
    hash,
    resetScroll: _resetScroll,
    ...props
  }: ComponentProps<"a"> & {
    to?: string;
    params?: unknown;
    hash?: string;
    resetScroll?: boolean;
  }) => (
    <a {...props} href={"#" + (hash ?? "")}>
      {children}
    </a>
  )) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

// SCIENT-FORK:START — browser image fixtures must decode, unlike static-renderer placeholders.
const BROWSER_IMAGE_URL =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
// SCIENT-FORK:END

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
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
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
    entry: { id, createdAt: CREATED_AT, ...entry },
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

function longText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

async function renderElement(element: ReactElement) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container });
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
  const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
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

describe("MessagesTimeline work rows", () => {
  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("opens a nested diff with %s without collapsing the tool row", async (_name, key) => {
    const onOpenTurnDiff = vi.fn();
    await using screen = await renderTimeline(
      [
        work("file-change-1", {
          label: "Updated src/index.ts",
          tone: "tool",
          itemType: "file_change",
          toolLifecycleStatus: "completed",
          projectedItem: v2Item("file_change", { id: "file-change-1", fileName: "src/index.ts" }),
        }),
      ],
      { onOpenTurnDiff },
    );
    const row = screen.container.querySelector<HTMLElement>('[data-v2-item-type="file_change"]')!;
    const press = async (target: HTMLElement) => {
      await act(async () => {
        target.focus();
        await userEvent.keyboard(key);
      });
    };
    expect(row.getAttribute("aria-expanded")).toBe("false");
    await press(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const openDiff = screen.button("Open diff");
    await press(openDiff);
    expect(onOpenTurnDiff).toHaveBeenCalledWith("run-1", "src/index.ts");
    expect(onOpenTurnDiff).toHaveBeenCalledTimes(1);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    await press(row);
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows dynamic tool input without cached output when the row is expanded", async () => {
    await using screen = await renderTimeline([
      work("tool-with-cached-output", {
        label: "Example tool",
        toolTitle: "Example tool",
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: "completed",
        toolData: {
          input: { query: "KEEP_TOOL_INPUT" },
          output: { text: "RAW_CACHED_TOOL_OUTPUT" },
        },
      }),
    ]);
    await click(screen.button("Example tool"));
    expect(screen.text()).toContain("KEEP_TOOL_INPUT");
    expect(screen.text()).not.toContain("RAW_CACHED_TOOL_OUTPUT");
    await click(screen.button("Example tool"));
    await vi.waitFor(() => expect(screen.text()).not.toContain("KEEP_TOOL_INPUT"));
  });

  it("expands and collapses a tool call through its header", async () => {
    await using screen = await renderTimeline([
      work("work-standalone", {
        toolCallId: "call-standalone",
        label: "Run lint",
        tone: "tool",
        itemType: "command_execution",
        command: "pnpm lint",
        toolLifecycleStatus: "completed",
      }),
    ]);
    const header = () => screen.container.querySelector<HTMLElement>("[aria-expanded]")!;
    expect(header().getAttribute("aria-expanded")).toBe("false");
    await click(header());
    expect(header().getAttribute("aria-expanded")).toBe("true");
    await click(header());
    expect(header().getAttribute("aria-expanded")).toBe("false");
  });

  it("leads an unanswered question row with the question text", async () => {
    await using screen = await renderTimeline([
      work("question-work", {
        label: "User input requested",
        tone: "tool",
        questionAnswer: {
          requestId: ApprovalRequestId.make("question-request"),
          answers: {},
          questionTextById: { scope: "Which repository?" },
          attachmentsByQuestionId: {},
        },
      }),
    ]);
    const toggle = screen.button("Which repository?");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const before = screen.text().match(/Which repository\?/g)?.length ?? 0;
    expect(before).toBeGreaterThan(0);
    await click(toggle);
    expect(screen.text().match(/Which repository\?/g)?.length).toBe(before + 1);
  });

  it("collapses settled tool runs behind a generated summary and names a failure", async () => {
    await using screen = await renderTimeline([
      work("work-1", {
        label: "Ran command",
        command: "vp lint",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
      }),
      work("work-2", {
        label: "Run lint",
        command: "vp test run",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "failed",
      }),
    ]);
    const summary = screen.button(/^Ran 2 commands/);
    expect(summary.getAttribute("aria-label")).toContain("tool call failed");
    expect(screen.text()).not.toContain("vp lint");
    await click(summary);
    await vi.waitFor(() => expect(screen.text()).toContain("vp lint"));
  });

  it("keeps mixed work logs neutral after a later tool call succeeds", async () => {
    await using screen = await renderTimeline([
      work("work-failed", {
        label: "Run search",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "failed",
      }),
      work("work-info", { label: "Status updated", tone: "info" }),
      work("work-completed", {
        label: "Run tests",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
      }),
    ]);
    expect(screen.button("Ran 2 commands and received 1 update")).toBeDefined();
  });

  it("marks a failed tool inside an expanded work log", async () => {
    await using screen = await renderTimeline([
      work("work-info", { label: "Status updated", tone: "info" }),
      work("work-1", {
        label: "Glob",
        tone: "tool",
        toolLifecycleStatus: "failed",
        detail: "No files found",
      }),
    ]);
    await click(screen.button(/^Received 1 update/));
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[aria-label="Tool call failed"]')).not.toBeNull(),
    );
  });

  it("renders context compaction entries in the normal work log", async () => {
    await using screen = await renderTimeline([
      work("work-1", { label: "Context compacted", tone: "info" }),
    ]);
    expect(screen.text()).toContain("Context compacted");
  });

  it("formats changed file paths from the workspace root", async () => {
    await using screen = await renderTimeline(
      [
        work("context-info", { label: "Session started", tone: "info" }),
        work("work-1", {
          label: "Updated files",
          tone: "tool",
          itemType: "file_change",
          toolLifecycleStatus: "completed",
          changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
        }),
      ],
      { workspaceRoot: "C:/Users/mike/dev-stuff/t3code" },
    );
    await click(screen.button(/^Received 1 update/));
    await vi.waitFor(() => expect(screen.text()).toContain("src/session-logic.ts"));
    expect(screen.text()).not.toContain(
      "C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts",
    );
  });

  it("renders T3 MCP dynamic tools with their pretty name", async () => {
    const item = {
      id: "tool-t3-thread-read",
      type: "dynamic_tool",
      toolName: "mcp__t3-code__t3_thread_read",
      input: { threadId: "thread-child" },
      output: { messages: [] },
    };
    await using screen = await renderTimeline([
      work("context-info", { label: "Session started", tone: "info" }),
      work(item.id, {
        runId: null,
        label: item.toolName,
        tone: "tool",
        itemType: item.type,
        toolTitle: item.toolName,
        toolLifecycleStatus: "completed",
        toolData: { input: item.input, output: item.output },
        structuredPayload: v2Item("dynamic_tool", item),
        projectedItem: v2Item("dynamic_tool", item),
      }),
    ]);
    await click(screen.button(/^Received 1 update/));
    await vi.waitFor(() => expect(screen.text()).toContain("Read a Scient thread"));
    expect(screen.text()).not.toContain("mcp__t3-code__t3_thread_read");
  });

  it("keeps a provider retry collapsed in the work log", async () => {
    const retryItem = {
      id: "provider-error",
      status: "running",
      title: "Provider retry",
      failure: {
        class: "transport_error",
        message: "The response stream disconnected.",
        code: "responseStreamDisconnected",
        retryable: true,
      },
      retry: { attempt: 2, maxAttempts: 5, retryDelayMs: null },
    };
    await using screen = await renderTimeline(
      [
        work("provider-error", {
          runId: "run-1",
          label: "Retrying provider (2/5)",
          detail: retryItem.failure.message,
          tone: "info",
          itemType: "error",
          toolLifecycleStatus: "inProgress",
          projectedItem: v2Item("error", retryItem),
        }),
      ],
      {
        isWorking: true,
        activeTurnInProgress: true,
        latestRun: {
          runId: RunId.make("run-1"),
          status: "running",
          startedAt: CREATED_AT,
          completedAt: null,
        },
      },
    );
    expect(screen.text()).toContain("Retrying provider (2/5)");
    expect(screen.text()).not.toContain("Structured details");
  });

  it.each([
    [
      "**Viewing image first** with *care*, ~~old~~ `code` and [context](https://example.com)",
      "Viewing image first with care, old code and context",
      1,
    ],
    ["first paragraph\n\nsecond paragraph", "first paragraph second paragraph", 0],
    ["- first\n- second", "first second", 0],
    ["first  \nsecond", "first second", 0],
    ["![image description](image.png)", "image description", 0],
    ["![](image.png)", "Thought", 0],
    ["---", "Thought", 0],
  ] as const)(
    "shows plain text for a V2 reasoning preview: %s",
    async (markdown, expected, strongCount) => {
      await using screen = await renderTimeline([
        work("reasoning-preview", {
          label: markdown,
          detail: markdown,
          tone: "thinking",
          itemType: "reasoning",
          toolLifecycleStatus: "completed",
        }),
      ]);
      const row = () =>
        screen.container.querySelector<HTMLElement>("[role=button][aria-expanded]")!;
      const preview = () => row().textContent!.replace(/\s+/g, " ");
      expect(preview()).toContain(expected);
      expect(screen.container.querySelectorAll("strong")).toHaveLength(0);
      await click(row());
      expect(screen.container.querySelectorAll("strong")).toHaveLength(strongCount);
      expect(screen.container.querySelectorAll("[data-scient-reasoning-trace]")).toHaveLength(1);
      await click(row());
      expect(preview()).toContain(expected);
      await vi.waitFor(() => expect(screen.container.querySelectorAll("strong")).toHaveLength(0));
    },
  );
});

describe("MessagesTimeline messages", () => {
  it.each([
    { role: "assistant", selection: "across", findExpanded: false },
    { role: "assistant", selection: "across", findExpanded: true },
    { role: "user", selection: "across", findExpanded: false },
    { role: "assistant", selection: "inside", findExpanded: false },
    { role: "user", selection: "source", findExpanded: false },
  ] as const)(
    "copies Mermaid selection $selection in $role messages (find expanded: $findExpanded)",
    async ({ role, selection, findExpanded }) => {
      const code = "flowchart LR\n    A[Select message] --> B[Copy Markdown]";
      const source = `\`\`\`mermaid\n${code}\n\`\`\``;
      await using screen = await renderTimeline(
        [message(`Before diagram.\n\n${source}\n\nAfter diagram.`, { role })],
        {
          findExpanded,
        },
      );
      screen.container.querySelector(".scient-mermaid-card")!.scrollIntoView({ block: "center" });
      const diagram = await vi.waitFor(
        () => {
          const svg = screen.container.querySelector(".scient-mermaid-inline svg");
          expect(svg).not.toBeNull();
          return svg!;
        },
        { timeout: 10_000 },
      );
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
        await page.getByRole("menuitem", { name: "Show source" }).click();
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
        context: { version: 1, records: [record] },
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
    screen.container.querySelector(".scient-mermaid-card")!.scrollIntoView({ block: "center" });
    await vi.waitFor(
      () => expect(screen.container.querySelector(".scient-mermaid-inline svg")).not.toBeNull(),
      { timeout: 10_000 },
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

  it("preserves XML-like tags and comparisons in user messages as text", async () => {
    const source = [
      'Without reading a file, do you have <global-agent-instructions scope="workspace">',
      'Before <nested data-value="a&b">inside</nested> after',
      "</global-agent-instructions> in your context?",
      "Comparison: 2 < 3 and 5 > 4.",
    ];
    await using screen = await renderTimeline([message(source.join("\n"))]);
    for (const line of source) expect(screen.text()).toContain(line);
    expect(screen.container.querySelector("global-agent-instructions, nested")).toBeNull();
  });

  it("preserves XML-like source inside user code spans and fences", async () => {
    await using screen = await renderTimeline([
      message(
        [
          'Inline `<tag attr="x">`',
          "",
          "```xml",
          '<root><child enabled="true" /></root>',
          "```",
        ].join("\n"),
      ),
    ]);
    expect(screen.container.querySelector("code[data-inline-code]")?.textContent).toBe(
      '<tag attr="x">',
    );
    expect(screen.text()).toContain('<root><child enabled="true" /></root>');
  });

  it("does not show markdown titles in user messages", async () => {
    // SCIENT-FORK:START — same-origin media exercises the image renderer without a remote fetch.
    const localImageUrl = new URL("/favicon-16x16.png", window.location.href).href;
    // SCIENT-FORK:END
    await using screen = await renderTimeline([
      message(
        // SCIENT-FORK:START — remote images need consent; local images still exercise title stripping
        // (docs/internals/scient-chat-images.md, Contract and ownership).
        '[link](https://example.com "link tip") ![image](https://example.com/image.png "image tip") ' +
          `![local image](${localImageUrl} "image tip")`,
        // SCIENT-FORK:END
      ),
    ]);
    expect(screen.container.querySelector('a[href="https://example.com"]')).not.toBeNull();
    // SCIENT-FORK:START — the remote image remains a link card until Load image is chosen.
    expect(screen.container.querySelector('img[src="https://example.com/image.png"]')).toBeNull();
    expect(
      screen.container.querySelector('[data-scient-remote-image][aria-label="Web image: image"]'),
    ).not.toBeNull();
    expect(screen.button("Load image from example.com")).toBeDefined();
    expect(screen.container.querySelector('img[alt="local image"]')?.getAttribute("src")).toBe(
      localImageUrl,
    );
    // SCIENT-FORK:END
    expect(screen.container.querySelector('[title="link tip"], [title="image tip"]')).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const source =
      '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">';
    await using screen = await renderTimeline([message(source)]);
    expect(screen.text()).toContain(source);
    expect(screen.container.querySelector("script, img")).toBeNull();
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("renders sanitized raw HTML in assistant messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<details onclick="globalThis.__t3Xss = 1">',
          "<summary>Safe details</summary>",
          "<script>globalThis.__t3Xss = 2</script>",
          '<img src="x" onerror="globalThis.__t3Xss = 3">',
          '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
          "</details>",
        ].join(""),
        { role: "assistant" },
      ),
    ]);
    expect(screen.container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "Safe details",
    );
    expect(screen.text()).not.toContain("<details");
    expect(screen.container.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(screen.container.innerHTML).not.toContain("javascript:");
    await click(screen.button("Safe details"));
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("collapses long user messages behind a toggle and keeps their copy button", async () => {
    await using screen = await renderTimeline([message(longText())]);
    const toggle = screen.button("Show full message");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.buttons("Copy message")).toHaveLength(1);
    await click(toggle);
    expect(screen.button("Show less").getAttribute("aria-expanded")).toBe("true");
  });

  it("does not offer a collapse toggle for short user messages", async () => {
    await using screen = await renderTimeline([message("Short prompt.")]);
    expect(screen.buttons(/Show full message|Show less/)).toHaveLength(0);
  });

  it("identifies user-role messages sent by another agent", async () => {
    {
      await using screen = await renderTimeline([
        message("Review this area", { createdBy: "agent", creationSource: "provider" }),
      ]);
      expect(screen.text()).toContain("Sent by another agent");
    }
    await using screen = await renderTimeline([message("Review this area")]);
    expect(screen.text()).not.toContain("Sent by another agent");
  });

  it("shows steer intent ahead of committed user messages", async () => {
    await using screen = await renderTimeline([
      message("Adjust the current turn", { inputIntent: "steer" }),
    ]);
    expect(screen.text().indexOf("Steer")).toBeGreaterThanOrEqual(0);
    expect(screen.text().indexOf("Steer")).toBeLessThan(
      screen.text().indexOf("Adjust the current turn"),
    );
  });

  it("renders inline terminal labels as chips", async () => {
    await using screen = await renderTimeline([
      message(
        [
          longText("yoo what's @terminal-1:1-5 mean"),
          "",
          "<terminal_context>",
          "- Terminal 1 lines 1-5:",
          "  1 | julius@mac effect-http-ws-cli % bun i",
          "  2 | bun install v1.3.9 (cf6cdbbb)",
          "</terminal_context>",
        ].join("\n"),
      ),
    ]);
    expect(screen.text()).toContain("Terminal 1 lines 1-5");
    expect(screen.text()).toContain("yoo what's");
    expect(screen.text()).not.toContain("terminal_context");
    expect(screen.buttons("Show full message")).toHaveLength(1);
  });

  it("renders chips for standalone element-pick context messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          "<element_context>",
          "- <SubmitButton> (Button.tsx:12):",
          "  url: https://example.com/dashboard",
          "  selector: button.submit",
          "  source: /repo/src/Button.tsx:12:5",
          "  html:",
          '  <button class="submit">Save</button>',
          "</element_context>",
        ].join("\n"),
      ),
    ]);
    expect(screen.text()).toContain("SubmitButton");
    expect(screen.text()).not.toContain("element_context");
  });

  it("renders review comment contexts as structured cards instead of raw tags", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
          "Wadduo",
          "```diff",
          "@@ -0,0 +47,2 @@",
          '+  it("keeps valid zero-usage snapshots", () => {',
          "+    expect(snapshot).not.toBeNull();",
          "```",
          "</review_comment>",
        ].join("\n"),
      ),
    ]);
    expect(screen.text()).toContain("contextWindow.test.ts L47 to L58");
    expect(screen.text()).not.toContain("review_comment");
  });

  it("renders file review comments as source code", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
          "Clarify this.",
          "```md",
          "# Plan",
          "- Step one",
          "```",
          "</review_comment>",
        ].join("\n"),
      ),
    ]);
    expect(screen.text()).toContain("plan.md L1 to L2");
    expect(screen.text()).not.toContain("review_comment");
  });

  it("collapses superseded attempt output behind a disclosure", async () => {
    const runId = RunId.make("run-steered");
    const attempt = (id: string, ordinal: number, status: string) =>
      ({
        id,
        runId,
        attemptOrdinal: ordinal,
        rootNodeId: `node-${id}`,
        status,
        completedAt: null,
      }) as never;
    await using screen = await renderTimeline(
      [
        {
          ...message(
            "Partial response from the old attempt",
            { role: "assistant", runId },
            "superseded-response",
          ),
          attempt: attempt("attempt-1", 1, "superseded"),
        } as Entry,
        {
          ...message(
            "Current response remains visible",
            { role: "assistant", runId, streaming: true },
            "active-response",
          ),
          attempt: attempt("attempt-2", 2, "running"),
        } as Entry,
      ],
      {
        latestRun: { runId, status: "running", startedAt: CREATED_AT, completedAt: null },
      },
    );
    expect(screen.text()).toContain("Current response remains visible");
    expect(screen.text()).not.toContain("Partial response from the old attempt");
    const disclosure = screen.button(/Superseded attempt/);
    expect(disclosure.textContent).toContain("Cut off by a steer");
    await click(disclosure);
    expect(screen.text()).toContain("Partial response from the old attempt");
  });

  it("forks from a completed assistant response", async () => {
    const onForkFromRun = vi.fn(async () => {});
    // SCIENT-FORK:START — the clicked message is the public fork boundary
    // (docs/internals/scient-fork-divergence.md, Native V2 reliability model).
    const onForkAssistantMessage = vi.fn();
    // SCIENT-FORK:END
    await using screen = await renderTimeline(
      [
        {
          ...message("Done", { role: "assistant", runId: RunId.make("run-1") }, "assistant-1"),
          projectedItem: v2Item("assistant_message", {
            id: "assistant-item-1",
            messageId: "assistant-1",
            text: "Done",
            streaming: false,
          }),
        } as Entry,
      ],
      // SCIENT-FORK:START — UPSTREAM.md preserves server-owned boundary resolution.
      { onForkFromRun, onForkAssistantMessage },
      // SCIENT-FORK:END
    );
    // SCIENT-FORK:START — Scient fork V2 receives the message, not a client-chosen run boundary.
    await click(screen.button("Fork conversation from this response"));
    expect(onForkAssistantMessage).toHaveBeenCalledExactlyOnceWith("assistant-1");
    expect(onForkFromRun).not.toHaveBeenCalled();
    // SCIENT-FORK:END
  });

  it("opens the changed files of an assistant response", async () => {
    const assistantMessageId = MessageId.make("assistant-with-files");
    const runId = RunId.make("run-with-files");
    const onOpenTurnDiff = vi.fn();
    await using screen = await renderTimeline(
      [message("Updated the fixture.", { role: "assistant", runId }, assistantMessageId)],
      {
        onOpenTurnDiff,
        latestRun: { runId, status: "completed", startedAt: CREATED_AT, completedAt: CREATED_AT },
        turnDiffSummaries: [
          {
            runId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-with-files"),
            status: "ready",
            files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
            assistantMessageId,
            completedAt: CREATED_AT,
          },
        ],
      },
    );
    expect(screen.text()).toContain("1 changed file");
    await click(screen.button("Open diff"));
    expect(onOpenTurnDiff).toHaveBeenCalledWith(runId, "README.md");
  });
});

describe("MessagesTimeline attachments", () => {
  const withAttachment = (attachment: Record<string, unknown>) =>
    message("Read the report.", {
      attachments: [
        {
          type: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          ...attachment,
        },
      ] as never,
    });

  it("offers preview and download actions for PDF attachments", async () => {
    await using screen = await renderTimeline([
      withAttachment({
        id: "attachment-report-pdf",
        previewUrl: "https://environment.test/api/assets/report.pdf",
      }),
    ]);
    expect(screen.buttons("Preview report.pdf")).toHaveLength(1);
    expect(screen.buttons("Download report.pdf")).toHaveLength(1);
    expect(screen.container.querySelector('img[alt="report.pdf"]')).toBeNull();
  });

  it("does not create a download URL before the download is requested", async () => {
    await using screen = await renderTimeline([withAttachment({ id: "attachment-report-pdf" })]);
    expect(screen.buttons("Download report.pdf")).toHaveLength(1);
    expect(screen.container.querySelector("a[href]")).toBeNull();
  });

  it("does not download an optimistic file before the server supplies its attachment ID", async () => {
    await using screen = await renderTimeline([
      withAttachment({ id: "composer-local-report", downloadable: false }),
    ]);
    expect(screen.text()).toContain("report.pdf");
    expect(screen.buttons("Download report.pdf")).toHaveLength(0);
  });

  it("renders unknown attachment types as inert rows instead of crashing", async () => {
    await using screen = await renderTimeline([
      withAttachment({
        type: "recording",
        id: "attachment-voice-memo",
        name: "voice-memo.ogg",
        mimeType: "audio/ogg",
      }),
    ]);
    expect(screen.text()).toContain("voice-memo.ogg");
    expect(screen.buttons("Download voice-memo.ogg")).toHaveLength(0);
    expect(screen.container.querySelector("a[href], img")).toBeNull();
  });

  it("shows SnapShot window details only after the preview resolves", async () => {
    const snapShot = (previewUrl?: string) =>
      message("First prompt.", {
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1,
            ...(previewUrl ? { previewUrl } : {}),
            source: {
              kind: "snap-shot",
              capturedAt: CREATED_AT,
              appName: "Terminal",
              windowTitle: "t3code — Tests",
              appIconDataUrl: "data:image/png;base64,aWNvbg==",
            },
          },
        ] as never,
      });
    {
      await using screen = await renderTimeline([snapShot()]);
      expect(screen.text()).toContain("screenshot.png");
      expect(screen.text()).not.toContain("t3code — Tests");
    }
    await using screen = await renderTimeline([snapShot("data:image/png;base64,iVBORw0KGgo=")]);
    expect(screen.text()).toContain("Terminal");
    expect(screen.text()).toContain("t3code — Tests");
  });
});

describe("MessagesTimeline history and thread links", () => {
  it.each([
    ["imported runless", null],
    ["standard", RunId.make("citation-run")],
  ] as const)("reveals a cited response inside a folded %s turn", async (_label, runId) => {
    const quote = "The imported response contains this cited detail.";
    const props = {
      ...baseProps(),
      timelineEntries: [
        message("Investigate the issue.", { runId }, "citation-prompt"),
        message(quote, { role: "assistant", runId }, "citation-source"),
        message("Investigation complete.", { role: "assistant", runId }, "citation-answer"),
      ],
    };
    await using screen = await renderElement(<MessagesTimeline {...props} />);
    const source = () =>
      screen.container.querySelector<HTMLElement>(
        '[data-assistant-citation-source="citation-source"]',
      );
    await vi.waitFor(() => expect(screen.text()).toContain("Investigation complete."));
    expect(screen.buttons(/^Worked/)).toHaveLength(1);
    expect(source()).toBeNull();

    await screen.rerender(
      <MessagesTimeline
        {...props}
        citationRequest={{
          key: "open-citation",
          citation: {
            version: 1,
            environmentId: ENVIRONMENT_ID,
            threadId: ThreadId.make(props.routeThreadKey.slice("environment-local:".length)),
            messageId: MessageId.make("citation-source"),
            text: quote,
            start: 0,
            end: quote.length,
            prefix: "",
            suffix: "",
          },
        }}
      />,
    );

    await vi.waitFor(() => {
      expect(source()?.textContent ?? "").toContain(quote);
      const highlight = CSS.highlights.get("t3-assistant-citation");
      expect(highlight).toBeDefined();
      const range = [...highlight!][0] as Range;
      expect(range.toString()).toBe(quote);
      const viewport = screen.container.querySelector<HTMLElement>(
        "[data-assistant-citation-viewport]",
      )!;
      const bounds = range.getBoundingClientRect();
      expect(bounds.height).toBeGreaterThan(0);
      expect(bounds.top).toBeGreaterThanOrEqual(viewport.getBoundingClientRect().top);
      expect(bounds.bottom).toBeLessThanOrEqual(viewport.getBoundingClientRect().bottom);
    });
  });

  it("loads earlier turns from a control ahead of the bounded timeline", async () => {
    const onLoadEarlier = vi.fn();
    await using screen = await renderTimeline([message("Recent activity")], {
      historyControls: {
        hasMoreHistory: true,
        loading: false,
        error: "Earlier activity could not be loaded.",
        onLoadEarlier,
      },
    });
    expect(screen.text()).toContain("Earlier activity could not be loaded.");
    expect(screen.text().indexOf("Load earlier turns")).toBeLessThan(
      screen.text().indexOf("Recent activity"),
    );
    await click(screen.button("Load earlier turns"));
    expect(onLoadEarlier).toHaveBeenCalledOnce();
  });

  it("keeps an empty bounded timeline busy while earlier history loads", async () => {
    await using screen = await renderTimeline([], {
      historyControls: {
        hasMoreHistory: true,
        loading: true,
        error: null,
        onLoadEarlier: () => {},
      },
    });
    expect(screen.text()).toContain("Loading earlier turns…");
    expect(screen.button("Load earlier turns")).toHaveProperty("disabled", true);
    expect(screen.text()).not.toContain("Send a message to start the conversation.");
  });

  it("opens the parent thread from the top of an empty subagent timeline", async () => {
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline([], {
      onOpenThread,
      parentThreadLink: { threadId: ThreadId.make("thread-parent"), title: "Architecture audit" },
    });
    expect(screen.text()).toContain("Subagent of");
    expect(screen.text()).toContain("Architecture audit");
    expect(screen.text()).not.toContain("Send a message to start the conversation");
    await click(screen.button("Open parent thread"));
    expect(onOpenThread).toHaveBeenCalledWith("thread-parent");
  });

  it("opens a thread at its newest message after an empty pane and restores it on return", async () => {
    const props = baseProps();
    const entries = Array.from({ length: 12 }, (_, index) =>
      message(
        Array.from({ length: 60 }, (_, line) => `Paragraph ${index}.${line}`).join("\n\n"),
        { role: "assistant" },
        `message-${index}`,
      ),
    );
    await using screen = await renderTimeline([], {
      ...props,
      routeThreadKey: `${props.routeThreadKey}-loading`,
      hideEmptyPlaceholder: true,
    });

    // Each row is much taller than LegendList's estimate.
    await screen.rerender(<MessagesTimeline {...props} timelineEntries={entries} />);
    const viewport = props.listRef.current!.getScrollableNode();
    await vi.waitFor(() => {
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
      expect(screen.text()).toContain("Paragraph 11.59");
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1);
    });

    const otherThreadKey = `${props.routeThreadKey}-other`;
    await screen.rerender(
      <MessagesTimeline {...props} routeThreadKey={otherThreadKey} timelineEntries={entries} />,
    );
    await vi.waitFor(() =>
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1),
    );
    // Move beyond LegendList's one-viewport follow threshold so it cannot mask restoration.
    await userEvent.wheel(viewport, { delta: { y: -2000 } });
    await vi.waitFor(() => {
      expect(readTimelinePosition(otherThreadKey)?.atEnd).toBe(false);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
        viewport.clientHeight,
      );
    });

    await screen.rerender(<MessagesTimeline {...props} timelineEntries={entries} />);
    await vi.waitFor(() => {
      expect(screen.text()).toContain("Paragraph 11.59");
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1);
    });
  });

  it("does not render the transient V2 interruption request", async () => {
    await using screen = await renderTimeline([
      {
        id: "interrupt-request",
        kind: "event",
        createdAt: CREATED_AT,
        projectedItem: v2Item("run_interrupt_request", {
          id: "interrupt-request",
          message: "Waiting for the provider to stop.",
        }),
      } as Entry,
    ]);
    expect(screen.text()).not.toContain("Interrupt requested");
    expect(screen.text()).not.toContain("Waiting for the provider to stop.");
  });

  it("opens created threads from a lean row", async () => {
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline(
      [
        {
          id: "thread-created",
          kind: "event",
          createdAt: CREATED_AT,
          projectedItem: v2Item("thread_created", {
            id: "thread-created",
            nodeId: "node-1",
            ordinal: 1,
            title: "Claude research thread",
            targetThreadId: "thread-2",
            targetRunId: "run-2",
            targetProviderInstanceId: "claude-default",
            targetModel: "claude-sonnet-4-6",
          }),
        } as Entry,
      ],
      { onOpenThread },
    );
    expect(screen.text()).toContain("Claude research thread");
    expect(screen.text()).not.toContain("Work Log");
    await click(screen.button("Open Claude research thread"));
    expect(onOpenThread).toHaveBeenCalledWith("thread-2");
  });

  it("renders context handoffs as from → to model endpoints instead of the summary", async () => {
    const provider = (instanceId: string, driver: string, slug: string, name: string) => ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: {},
      checkedAt: CREATED_AT,
      models: [{ slug, name, isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    });
    const providers = [
      provider("codex_personal", "codex", "gpt-5.6-sol", "GPT 5.6 Sol"),
      provider("claudeAgent", "claudeAgent", "claude-fable-5", "Claude Fable 5"),
    ] as never;
    const handoff = (fields: Record<string, unknown>) =>
      ({
        id: "handoff-1",
        kind: "event",
        createdAt: CREATED_AT,
        projectedItem: v2Item("handoff", {
          id: "handoff-1",
          runId: "run-2",
          title: "Provider handoff",
          contextHandoffId: "handoff-1",
          fromProviderThreadIds: ["provider-thread-1"],
          toProviderThreadId: "provider-thread-2",
          strategy: "full_thread_summary",
          summary: "Full conversation context for provider handoff.",
          fromProviderInstanceIds: ["codex_personal"],
          toProviderInstanceId: "claudeAgent",
          ...fields,
        }),
      }) as Entry;
    const show = (entry: Entry, props: Partial<TimelineProps> = {}) =>
      renderElement(
        <RegistryProvider
          initialValues={[[serverEnvironment.providersValueAtom(ENVIRONMENT_ID), providers]]}
        >
          <MessagesTimeline {...baseProps()} timelineEntries={[entry]} {...props} />
        </RegistryProvider>,
      );

    {
      await using screen = await show(
        handoff({
          fromModelSelections: [{ instanceId: "codex_personal", model: "gpt-5.6-sol" }],
          toModel: "claude-fable-5",
        }),
      );
      expect(screen.text()).toContain("Context handoff");
      expect(screen.text()).toContain("GPT 5.6 Sol");
      expect(screen.text()).toContain("Claude Fable 5");
      expect(screen.text()).not.toContain("Full conversation context");
    }

    {
      await using screen = await show(handoff({}), {
        runs: [
          {
            id: "run-1",
            ordinal: 1,
            providerInstanceId: "codex_personal",
            modelSelection: { instanceId: "codex_personal", model: "gpt-5.6-sol" },
          },
          {
            id: "run-2",
            ordinal: 2,
            providerInstanceId: "claudeAgent",
            modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
          },
        ] as never,
      });
      expect(screen.text()).toContain("GPT 5.6 Sol");
      expect(screen.text()).toContain("Claude Fable 5");
    }

    await using screen = await show(handoff({}));
    expect(screen.text()).toContain("Codex Personal");
    expect(screen.text()).not.toContain("Full conversation context");
  });
});

describe("MessagesTimeline subagents", () => {
  it.each(
    (
      [
        {
          status: "running",
          progress: "Reading src/index.ts",
          result: null,
          preview: "Reading src/index.ts",
        },
        {
          status: "completed",
          progress: "Reading src/index.ts",
          result: "Tests should be isolated.",
          preview: "Tests should be isolated.",
        },
        {
          status: "running",
          progress: "Reading src/index.ts",
          result: "Partial streamed answer",
          preview: "Reading src/index.ts",
        },
        {
          status: "running",
          progress: undefined,
          result: "Streaming answer so far",
          preview: "Streaming answer so far",
        },
        {
          status: "cancelled",
          progress: "Reading src/index.ts",
          result: "Partial output before cancel",
          preview: "Partial output before cancel",
        },
        {
          status: "completed",
          progress: "Audited 12 packages",
          result: "  \n\t  ",
          preview: "Audited 12 packages",
        },
      ] as const
    ).flatMap((scenario) => [1, 2].map((count) => ({ ...scenario, count }))),
  )(
    "shows $count $status subagents with '$preview', grouping only multiple agents",
    async ({ status, progress, result, preview, count }) => {
      const onOpenThread = vi.fn();
      await using screen = await renderTimeline(
        Array.from(
          { length: count },
          (_, index) =>
            ({
              id: `subagent-progress-${index}`,
              kind: "event",
              createdAt: CREATED_AT,
              projectedItem: v2Item("subagent", {
                id: `subagent-progress-${index}`,
                nodeId: `node-subagent-${index}`,
                providerThreadId: "provider-thread-1",
                providerTurnId: "provider-turn-1",
                ordinal: 1,
                status,
                title: "Package audit",
                subagentId: `node-subagent-${index}`,
                origin: "provider_native",
                driver: "claudeAgent",
                providerInstanceId: "claudeAgent",
                childThreadId: "thread-subagent-1",
                prompt: "Inspect the package",
                progress,
                result,
              }),
            }) as Entry,
        ),
        { onOpenThread },
      );
      const children = () => screen.buttons("Open Package audit");
      // A settled run folds its work behind a "Worked for" summary.
      const fold = screen.buttons(/^Worked for/)[0];
      if (fold) await click(fold);
      if (count > 1) {
        expect(children()).toHaveLength(0);
        await click(screen.button(`${count} subagents`));
      } else {
        expect(screen.buttons(`${count} subagents`)).toHaveLength(0);
      }
      expect(children()).toHaveLength(count);
      expect(screen.text()).toContain(preview);
      expect(screen.text()).not.toContain("Inspect the package");
      if (result?.trim() && result !== preview) expect(screen.text()).not.toContain(result);
      if (progress && progress !== preview) expect(screen.text()).not.toContain(progress);
      await click(children()[0]!);
      expect(onOpenThread).toHaveBeenCalledWith("thread-subagent-1");
      if (count > 1) {
        await click(screen.button(`${count} subagents`));
        await vi.waitFor(() => expect(children()).toHaveLength(0));
      }
    },
  );
});

describe("timeline tooltip scroll dismissal", () => {
  const openPopup = () =>
    document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent ?? null;

  async function renderTooltip(pullRequest: boolean, outside: boolean) {
    const tooltip = pullRequest ? (
      <PullRequestLinkPreview
        link={<button>message link</button>}
        originalUrl="https://example.com"
        target={{
          environmentId: ENVIRONMENT_ID,
          input: { projectId: "project-1" as never, repository: "pingdotgg/t3code", number: 1 },
        }}
      />
    ) : (
      <Tooltip>
        <TooltipTrigger delay={50}>message link</TooltipTrigger>
        <TooltipPopup>https://example.com</TooltipPopup>
      </Tooltip>
    );
    const screen = await renderElement(
      <>
        <TooltipScrollDismissArea>
          <div data-testid="scrollable" className="h-[100px] overflow-auto">
            {outside ? null : tooltip}
            <div className="h-[1000px]" />
          </div>
        </TooltipScrollDismissArea>
        {outside ? tooltip : null}
      </>,
    );
    return Object.assign(screen, {
      trigger: screen.container.querySelector<HTMLButtonElement>("button")!,
      scrollable: screen.container.querySelector<HTMLElement>('[data-testid="scrollable"]')!,
    });
  }

  async function scroll(scrollable: HTMLElement) {
    await act(async () => {
      scrollable.scrollTop += 50;
      scrollable.dispatchEvent(new Event("scroll"));
    });
  }

  it.each([false, true])(
    "closes a hovered tooltip on scroll but keeps a focused one (pull request=%s)",
    async (pullRequest) => {
      await using screen = await renderTooltip(pullRequest, false);
      const { trigger, scrollable } = screen;
      await userEvent.hover(trigger);
      await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
      await scroll(scrollable);
      await vi.waitFor(() => expect(openPopup()).toBeNull());

      await userEvent.unhover(trigger);
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(trigger);
      await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
      await scroll(scrollable);
      expect(openPopup()).toBe("https://example.com");
      expect(document.activeElement).toBe(trigger);
    },
  );

  it("leaves tooltips outside the timeline open when it scrolls", async () => {
    await using screen = await renderTooltip(false, true);
    const { trigger, scrollable } = screen;
    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
    await scroll(scrollable);
    expect(openPopup()).toBe("https://example.com");
  });

  it("keeps a hovered tooltip open on a wheel that does not scroll", async () => {
    await using screen = await renderTooltip(false, false);
    const { trigger, scrollable } = screen;
    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
    await act(async () => {
      scrollable.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    });
    expect(openPopup()).toBe("https://example.com");
  });
});

describe("MessagesTimeline scroll position", () => {
  const tall = (index: number) =>
    message(
      `Message ${index}\n\n${"Long paragraph. ".repeat(80)}`,
      { role: "assistant" },
      `message-${index}`,
    );
  const tallEntries = Array.from({ length: 12 }, (_, index) => tall(index));

  async function waitForList(props: ReturnType<typeof baseProps>) {
    await vi.waitFor(() => {
      const viewport = props.listRef.current?.getScrollableNode();
      expect(viewport?.scrollHeight ?? 0).toBeGreaterThan(viewport?.clientHeight ?? 0);
    });
    return props.listRef.current!.getScrollableNode()!;
  }

  it("settles when earlier short replies load above long ones", async () => {
    const props = baseProps();
    const short = Array.from({ length: 80 }, (_, index) =>
      message(`Short reply ${index}`, { role: "assistant" }, `short-${index}`),
    );
    const long = Array.from({ length: 4 }, (_, index) =>
      message(
        `${"Long handbook paragraph. ".repeat(40)}\n\n`.repeat(60),
        { role: "assistant" },
        `long-${index}`,
      ),
    );
    let nestedCommits = 0;
    let maxNestedCommits = 0;
    const onRender = (_id: string, phase: string) => {
      nestedCommits = phase === "nested-update" ? nestedCommits + 1 : 0;
      maxNestedCommits = Math.max(maxNestedCommits, nestedCommits);
    };
    const timeline = (entries: Entry[]) => (
      <Profiler id="timeline" onRender={onRender}>
        <MessagesTimeline {...props} timelineEntries={entries} />
      </Profiler>
    );
    await using screen = await renderElement(timeline(long));
    const viewport = await waitForList(props);
    await act(async () => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
    });

    maxNestedCommits = 0;
    await screen.rerender(timeline([...short, ...long]));
    await vi.waitFor(async () => {
      await act(async () => {
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event("scroll"));
      });
      expect(screen.text()).toContain("Short reply 0");
    });
    expect(maxNestedCommits).toBeLessThan(8);
  });

  it("restores a manual reading position after reopening and switching threads", async () => {
    const props = baseProps();
    function Chat() {
      return (
        <div className="contents">
          <MessagesTimeline {...props} timelineEntries={tallEntries} />
        </div>
      );
    }
    let offset: number;
    {
      await using _chat = await renderElement(<Chat />);
      const viewport = await waitForList(props);
      await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(true));

      await userEvent.wheel(viewport, { delta: { y: -600 } });
      await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(false));
      offset = viewport.scrollTop;
    }
    expect(readTimelinePosition(props.routeThreadKey)).toMatchObject({
      atEnd: false,
      scrollOffset: offset,
    });

    const timeline = (routeThreadKey: string) => (
      <MessagesTimeline {...props} routeThreadKey={routeThreadKey} timelineEntries={tallEntries} />
    );
    await using screen = await renderElement(timeline(props.routeThreadKey));
    const reopenedViewport = await waitForList(props);
    await vi.waitFor(() =>
      expect(Math.abs(reopenedViewport.scrollTop - offset)).toBeLessThanOrEqual(1),
    );

    await screen.rerender(timeline(`${props.routeThreadKey}-other`));
    await vi.waitFor(() =>
      expect(
        reopenedViewport.scrollHeight - reopenedViewport.clientHeight - reopenedViewport.scrollTop,
      ).toBeLessThanOrEqual(1),
    );
    await screen.rerender(timeline(props.routeThreadKey));
    await vi.waitFor(() =>
      expect(Math.abs(reopenedViewport.scrollTop - offset)).toBeLessThanOrEqual(1),
    );
  });

  it("restores the composer after closing tool output only at the end", async () => {
    const props = baseProps();
    function Thread() {
      const composer = useComposerFocusState();
      return (
        <>
          <button onClick={() => composer.setIsComposerScrollCollapsed(true)}>Collapse</button>
          <output>{composer.isComposerScrollCollapsed ? "collapsed" : "resting"}</output>
          <MessagesTimeline
            {...props}
            onToolOutputCollapsedAtEnd={composer.restoreAfterTimelineReachedEnd}
            timelineEntries={[
              ...tallEntries,
              work("tool", {
                label: "Run command",
                tone: "tool",
                toolLifecycleStatus: "completed",
                detail: "Command output",
              }),
            ]}
          />
        </>
      );
    }
    await using screen = await renderElement(<Thread />);
    const composerState = () => screen.container.querySelector("output")!.textContent;
    const viewport = await waitForList(props);
    await click(screen.button("Collapse"));
    const toggle = () => screen.button("Command output");
    await click(toggle());
    await click(toggle());
    await vi.waitFor(() => expect(composerState()).toBe("resting"));

    await click(screen.button("Collapse"));
    await userEvent.wheel(viewport, { delta: { y: -2000 } });
    await click(toggle());
    await click(toggle());
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(composerState()).toBe("collapsed");
  });
});

describe("MessagesTimeline send anchor", () => {
  it("reports the anchored sent message once it is laid out", async () => {
    const onAnchorReady = vi.fn();
    const sent = message("Newest prompt.", {}, "message-2");
    await using _screen = await renderTimeline(
      [message("Earlier reply.", { role: "assistant" }), sent],
      {
        anchorMessageId: MessageId.make("message-2"),
        onAnchorReady,
        contentInsetEndAdjustment: 144,
      },
    );
    await vi.waitFor(() =>
      expect(onAnchorReady).toHaveBeenCalledWith(MessageId.make("message-2"), 1),
    );
  });

  it("does not anchor a follow-up user message that is not the newest turn", async () => {
    const onAnchorReady = vi.fn();
    await using _screen = await renderTimeline(
      [message("First prompt."), message("Newest prompt.", {}, "message-2")],
      {
        anchorMessageId: MessageId.make("message-2"),
        onAnchorReady,
      },
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(onAnchorReady).not.toHaveBeenCalled();
  });
});

// SCIENT-FORK:START - fork, attachment, direction, and activity policy in the real browser timeline.
const MESSAGE_CREATED_AT = CREATED_AT;
const decodeNativeWorkflowItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const decodeTimelineTransfer = Schema.decodeUnknownSync(OrchestrationV2ContextTransfer);
const buildProps = baseProps;
function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

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
  } = typeof options === "string" ? { text: options } : options;
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
          ...(previewUrl ? { previewUrl } : {}),
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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  return host.container.innerHTML;
}

it.each([
  "fork",
  "provider_handoff",
  "merge_back",
  "missing",
  "later-run",
  "inherited",
  "proven-inherited",
] as const)("renders one fork boundary while preserving %s handoff semantics", async (kind) => {
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
    type: kind === "provider_handoff" || kind === "merge_back" ? kind : "fork",
    sourceThreadId: "source",
    targetThreadId: "thread-1",
    sourcePoint: { threadId: "source" },
    basePoint: null,
    sourceProviderInstanceId: "codex",
    targetProviderInstanceId: "codex",
    targetRunId: kind === "later-run" ? "later-run" : "fork-first-run",
    status: "consumed",
    resolution: { strategy: "portable_context", contextHandoffId: "context-1" },
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
      contextTransfers={kind === "missing" ? undefined : [transfer]}
      timelineEntries={[
        {
          kind: "event",
          id: item.id,
          createdAt: MESSAGE_CREATED_AT,
          projectedItem: {
            item,
            position: 2,
            visibility: kind === "inherited" || kind === "proven-inherited" ? "inherited" : "local",
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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;
  expect(markup.match(/Conversation forked here/g)).toHaveLength(1);
  if (kind === "proven-inherited") expect(markup.match(/Context handoff/g)).toHaveLength(1);
  else if (kind === "fork") expect(markup).not.toContain("Context handoff");
  else expect(markup).toContain("Context handoff");
});

it("renders elapsed time for a completed turn", async () => {
  const runId = RunId.make("turn-with-fold");
  const assistantEntry = buildAssistantTimelineEntry({ text: "Done." });
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
          message: { ...assistantEntry.message, runId },
        },
      ]}
    />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain("Worked for 8.0s");
});

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
      timelineEntries={[buildAssistantTimelineEntry({ streaming: true })]}
      runningRunId={RunId.make("turn-1")}
      onForkAssistantMessage={() => {}}
    />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain('aria-label="Image attachment"');
  expect(markup).toContain('aria-label="Preview generated-image.png"');
  expect(markup).toContain('crossorigin="anonymous"');
  expect(markup).not.toContain("(empty response)");
});

it("keeps assistant changed-files headers sticky below the thread header", async () => {
  const assistantMessageId = MessageId.make("message-assistant-with-files");
  const runId = RunId.make("turn-with-files");
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      latestRun={{
        runId,
        status: "completed",
        startedAt: MESSAGE_CREATED_AT,
        completedAt: MESSAGE_CREATED_AT,
      }}
      timelineEntries={[
        {
          id: "entry-assistant-with-files",
          kind: "message",
          createdAt: MESSAGE_CREATED_AT,
          message: {
            id: assistantMessageId,
            role: "assistant",
            text: "Updated the fixture.",
            runId,
            createdAt: MESSAGE_CREATED_AT,
            updatedAt: MESSAGE_CREATED_AT,
            streaming: false,
          },
        },
      ]}
      turnDiffSummaries={[
        {
          runId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("checkpoint-with-files"),
          status: "ready",
          files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
          assistantMessageId,
          completedAt: MESSAGE_CREATED_AT,
        },
      ]}
    />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain("sticky top-2 z-10");
  expect(markup).not.toContain("self-start");
  expect(markup).toContain("whitespace-nowrap");
  expect(markup).toContain("size-3");
  expect(markup).not.toContain('aria-label="Collapse all folders"');
  expect(markup).toContain('aria-label="Open diff"');
  expect(markup).toContain("1 changed file");
});

it("does not render window details before the preview URL resolves", async () => {
  await using screen = await renderElement(
    <MessagesTimeline {...buildProps()} timelineEntries={[buildSnapShotTimelineEntry()]} />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain("screenshot.png");
  expect(markup).not.toContain("Terminal");
  expect(markup).not.toContain("t3code — Tests");
  expect(markup).not.toContain('src="data:image/png;base64,aWNvbg=="');
  expect(markup).not.toContain("h-28 w-52 max-w-full");
});

it("gives browser documents separate preview and download controls", async () => {
  const entry = {
    ...buildUserTimelineEntry("Read the report."),
    message: {
      ...buildUserTimelineEntry("Read the report.").message,
      attachments: [
        {
          type: "file" as const,
          id: "attachment-report-pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          previewUrl: "https://environment.test/api/assets/report.pdf",
        },
      ],
    },
  };

  await using screen = await renderElement(
    <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain('aria-label="Preview report.pdf"');
  expect(markup).toContain('aria-label="Download report.pdf"');
  expect(markup).not.toContain('download="report.pdf"');
  expect(markup).not.toContain('alt="report.pdf"');
});

it("renders video attachments with the shared video player", async () => {
  const entry = {
    ...buildUserTimelineEntry("Watch the demo."),
    message: {
      ...buildUserTimelineEntry("Watch the demo.").message,
      attachments: [
        {
          type: "file" as const,
          id: "attachment-demo-mp4",
          name: "demo.mp4",
          mimeType: "video/mp4",
          sizeBytes: 42,
          previewUrl: new URL(timelineVideoUrl, window.location.href).href,
        },
      ],
    },
  };

  await using screen = await renderElement(
    <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain("<video");
  expect(markup).toContain('aria-label="demo.mp4"');
  expect(markup).not.toContain("Expand demo.mp4");
});

it("shows the filename while an optimistic video is unavailable", async () => {
  const entry = {
    ...buildUserTimelineEntry("Uploading the demo."),
    message: {
      ...buildUserTimelineEntry("Uploading the demo.").message,
      attachments: [
        {
          type: "file" as const,
          id: "optimistic-demo-mp4",
          name: "pending-demo.mp4",
          mimeType: "video/mp4",
          sizeBytes: 42,
          downloadable: false,
        },
      ],
    },
  };

  await using screen = await renderElement(
    <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).not.toContain("<video");
  expect(markup).toContain(">pending-demo.mp4</div>");
});

it("renders an ordinary file with preview and download controls without creating its URL in advance", async () => {
  const entry = {
    ...buildUserTimelineEntry("Read the report."),
    message: {
      ...buildUserTimelineEntry("Read the report.").message,
      attachments: [
        {
          type: "file" as const,
          id: "attachment-report-pdf",
          name: "archive.zip",
          mimeType: "application/zip",
          sizeBytes: 42,
        },
      ],
    },
  };

  await using screen = await renderElement(
    <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain('aria-label="Preview archive.zip"');
  expect(markup).toContain('aria-label="Download archive.zip"');
  expect(markup).not.toContain("<a href=");
});

it("renders unknown attachment types as inert rows instead of crashing", async () => {
  const entry = {
    ...buildUserTimelineEntry("Play the recording."),
    message: {
      ...buildUserTimelineEntry("Play the recording.").message,
      attachments: [
        {
          // A newer server can introduce attachment types this build does
          // not know. They ride the open contract member.
          type: "recording",
          id: "attachment-voice-memo",
          name: "voice-memo.ogg",
          mimeType: "audio/ogg",
          sizeBytes: 42,
        },
      ],
    },
  };

  await using screen = await renderElement(
    <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain("voice-memo.ogg");
  expect(markup).not.toContain('aria-label="Download voice-memo.ogg"');
  expect(markup).not.toContain('alt="voice-memo.ogg"');
  expect(markup).not.toContain("<a href=");
});

it("preserves XML-like source inside user code spans and fences", async () => {
  const { MessagesTimeline } = await import("./MessagesTimeline");
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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain("data-inline-code");
  expect(screen.container.querySelector("code[data-inline-code]")?.textContent).toBe(
    '<tag attr="x">',
  );
  expect(screen.container.textContent).toContain('<root><child enabled="true" /></root>');
});

it("does not render markdown title attributes in user messages", async () => {
  const { MessagesTimeline } = await import("./MessagesTimeline");
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildUserTimelineEntry(
          '[link](https://example.com "link tip") ![image](https://example.com/image.png "image tip")',
        ),
      ]}
    />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain('href="https://example.com"');
  // The web image is a referenced link in user messages too, never an automatic request.
  expect(markup).toContain('href="https://example.com/image.png"');
  expect(markup).not.toContain('src="https://example.com/image.png"');
  expect(markup).not.toMatch(/\stitle="(?:link|image) tip"/);
});

it("continues to render sanitized raw HTML in assistant messages", async () => {
  const { MessagesTimeline } = await import("./MessagesTimeline");
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        buildAssistantTimelineEntry({
          text: "<details><summary>More</summary>Details</details>",
        }),
      ]}
    />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain('data-markdown-details=""');
  expect(markup).toContain("More");
  expect(markup).not.toContain("&lt;details&gt;");
});

it("sanitizes executable HTML while preserving supported assistant markup", async () => {
  const { MessagesTimeline } = await import("./MessagesTimeline");
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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain('data-markdown-details=""');
  expect(markup).toContain("Safe details");
  expect(markup).not.toMatch(/<script(?:\s|>)/i);
  expect(markup).not.toContain("onclick=");
  expect(markup).not.toContain("onerror=");
  expect(markup).not.toContain("javascript:");
  expect(markup).not.toContain("globalThis.__t3Xss");
});

it("exposes a per-response fork action for completed assistant items", async () => {
  const { MessagesTimeline } = await import("./MessagesTimeline");
  const projectedItem = {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: "assistant-item-1",
    item: {
      id: "assistant-item-1",
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
      type: "assistant_message",
      messageId: "assistant-message-1",
      text: "Done",
      streaming: false,
    },
  } as never;
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      onForkAssistantMessage={() => undefined}
      timelineEntries={[
        {
          id: "assistant-message-1",
          kind: "message",
          createdAt: MESSAGE_CREATED_AT,
          projectedItem,
          message: {
            id: MessageId.make("assistant-message-1"),
            role: "assistant",
            text: "Done",
            runId: RunId.make("run-1"),
            createdAt: MESSAGE_CREATED_AT,
            updatedAt: MESSAGE_CREATED_AT,
            streaming: false,
          },
        },
      ]}
    />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup.match(/aria-label="Fork conversation from this response"/g)).toHaveLength(1);
  expect(markup).not.toContain('aria-label="Fork from this response"');
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
            ? { type: "run", threadId: "original-thread", runId: "original-run" }
            : { type: "node", nodeId: "outgoing-source-node" },
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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;
  expect(markup.match(/Conversation forked here/g)).toHaveLength(1);
  expect(markup).not.toContain("Forked from conversation");
  expect(markup).toContain("Open fork");
  expect(markup).toContain("bg-border/60");
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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
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

it("applies Scient BiDi to sanitized assistant HTML", async () => {
  const { MessagesTimeline } = await import("./MessagesTimeline");
  await using screen = await renderElement(
    <ContentDirectionScope direction="rtl">
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildAssistantTimelineEntry({
            text: [
              "התשובה כאן",
              "",
              '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">',
            ].join("\n"),
          }),
        ]}
      />
    </ContentDirectionScope>,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain('dir="rtl"');
  expect(markup).toContain("התשובה כאן");
  expect(markup).not.toMatch(/<script(?:\s|>)/i);
  expect(markup).not.toContain("onerror=");
  expect(markup).not.toContain("globalThis.__t3Xss");
});

it("gives a kept earlier answer the final answer's copy button and spacing", async () => {
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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;
  expect(markup.match(/aria-label="Copy message"/g)).toHaveLength(2);
  expect(markup).toMatch(/class="pb-4[^"]*"[^>]*data-timeline-row-id="answer-entry"/);
  expect(markup).not.toContain('data-timeline-row-id="note-entry"');
});

it("summarizes changed files in one line", async () => {
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-1",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-1",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Updated files",
            tone: "tool",
            changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
          },
        },
      ]}
      workspaceRoot="C:/Users/mike/dev-stuff/t3code"
    />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain("Changed 1 file");
  expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
});

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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain("Ran 2 commands");
  expect(markup).toContain("lucide-square-terminal-lowered");
  expect(markup).not.toContain("lucide-circle-x");
  expect(markup).not.toContain("text-destructive");
  expect(markup).toContain("tool call failed");
});

it.each([
  [
    "a command",
    { itemType: "command_execution", command: "make build" },
    "lucide-square-terminal-lowered",
  ],
  [
    "a command that lists files",
    { itemType: "command_execution", command: "ls -la src" },
    "lucide-folder-open",
  ],
  [
    "a tree command",
    { itemType: "command_execution", command: "cd app && tree -L 2" },
    "lucide-folder-open",
  ],
  [
    "a find command",
    { itemType: "command_execution", command: "find . -name '*.ts'" },
    "lucide-folder-open",
  ],
  [
    "a command that fetches from the web",
    { itemType: "command_execution", command: "curl -s https://example.com" },
    "lucide-globe",
  ],
  ["an image view", { itemType: "dynamic_tool", viewedImagePath: "chart.png" }, "lucide-image"],
  [
    "a Scient skill tool",
    { itemType: "dynamic_tool", toolTitle: "mcp__t3-code__scient_skill_load" },
    "lucide-layers",
  ],
  ["an approval", { itemType: "approval_request", tone: "info" }, "lucide-shield-check"],
] as const)("marks %s with its trace icon", async (_name, fields, iconClass) => {
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[
        {
          id: "entry-trace-icon",
          kind: "work",
          createdAt: MESSAGE_CREATED_AT,
          entry: {
            id: "work-trace-icon",
            createdAt: MESSAGE_CREATED_AT,
            label: "Tool call",
            tone: "tool",
            toolLifecycleStatus: "completed",
            ...fields,
          },
        },
      ]}
    />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toMatch(new RegExp(`\\b${iconClass}[" ]`));
});

it.each([
  ["shares one trace icon", ["ls src", "find . -name x"], "lucide-folder-open"],
  ["mixes trace icons", ["ls src", "curl https://example.com"], "lucide-square-terminal-lowered"],
] as const)("gives a folded group that %s its icon", async (_name, commands, iconClass) => {
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={commands.map((command, index) => ({
        id: `entry-group-${index}`,
        kind: "work" as const,
        createdAt: MESSAGE_CREATED_AT,
        entry: {
          id: `work-group-${index}`,
          createdAt: MESSAGE_CREATED_AT,
          label: command,
          tone: "tool" as const,
          itemType: "command_execution" as const,
          command,
          toolLifecycleStatus: "completed" as const,
        },
      }))}
    />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain("Ran 2 commands");
  expect(markup).toMatch(new RegExp(`\\b${iconClass}[" ]`));
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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;
  expect(markup).toContain('aria-label="Operation failed"');
  expect(markup).not.toContain("tool call failed");
  expect(markup).toContain("The agent encountered a problem");
});
// SCIENT-FORK:END

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
          phases: [{ index: 0, title: "Review" }],
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
  ): Extract<OrchestrationV2TurnItem, { type: "subagent" }> => ({
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
    input: { taskId: "task-ci", timeout: 600_000 },
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
            ? [{ ...item, model: null, presentation: { kind: "subagent", role: "explorer" } }]
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
    const clock = fakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START + 125_000);
    return clock;
  }

  it("says on the collapsed row how many sub-agents work and for how long", async () => {
    using _clock = setupSubagentClock();
    await using screen = await renderElement(
      <MessagesTimeline {...buildProps()} {...timeline(subagents)} />,
    );
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const markup = screen.container.innerHTML;
    expect(markup).toContain("Kicked off 2 subagents · 1 working");
    // Since the launch, not since the turn began ("Working for 2m 5s").
    expect(markup).toContain("1m 5s");
  });

  it("lists each sub-agent with its type, a live timer, and why it stopped", async () => {
    using _clock = setupSubagentClock();
    await using screen = await renderElement(
      <MessagesTimeline {...buildProps()} {...timeline(subagents)} />,
    );
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
    using _clock = setupSubagentClock();
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
    await using screen = await renderElement(
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
    using _clock = setupSubagentClock();
    await using screen = await renderElement(
      <MessagesTimeline {...buildProps()} {...timeline([waiting])} />,
    );
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const markup = screen.container.innerHTML;
    expect(markup).toContain("Waiting for sub-agent · Review OMP host integration (up to 10 min)");
    // 25 s since the wait began.
    expect(markup).toContain(" · 25s");
  });

  it("keeps a step that has only just begun free of a timer", async () => {
    using _clock = setupSubagentClock();
    vi.setSystemTime(START + 104_000);
    await using screen = await renderElement(
      <MessagesTimeline {...buildProps()} {...timeline([waiting])} />,
    );
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const markup = screen.container.innerHTML;
    expect(markup).toContain("Waiting for sub-agent");
    expect(markup).not.toContain(" · 4s");
  });
});

// SCIENT-FORK:START — first-message framing and snapshot metadata survive actual image decoding.
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
  await vi.waitFor(
    () => {
      const image = screen.container.querySelector<HTMLImageElement>('img[alt="screenshot.png"]');
      expect(image?.complete).toBe(true);
      expect(image?.naturalWidth).toBe(1);
      expect(onAnchorReady).toHaveBeenCalledWith(firstEntry.message.id, 0);
      expect(onAnchorSizeChanged).toHaveBeenCalledWith(firstEntry.message.id, expect.any(Number));
      expect(onAnchorSizeChanged.mock.lastCall?.[1]).toBeGreaterThan(0);
    },
    { timeout: 5_000 },
  );
  const markup = screen.container.innerHTML;

  expect(markup).toContain('data-anchor-index="0"');
  expect(markup).toContain('data-anchor-offset="24"');
  expect(markup).not.toContain("data-anchor-max-size=");
  expect(markup).toContain('data-content-inset-end="144"');
  expect(markup).toContain("[overflow-anchor:none]");
  expect(markup).not.toContain('data-maintain-scroll-at-end="enabled"');
  expect(markup).toContain('data-maintain-visible-content-position="object"');
  expect(markup).toContain('data-maintain-visible-content-position-size="true"');
  expect(markup).toContain("Terminal");
  expect(markup).toContain("t3code — Tests");
  expect(markup).toContain('src="data:image/png;base64,aWNvbg=="');
  expect(markup).toContain('aria-label="Image attachment"');
  expect(markup).toContain("object-contain");
  expect(markup).not.toContain("col-span-2");
  // Decoding the image can trigger another real LegendList measurement.
  expect(onAnchorReady.mock.calls).toEqual(
    Array.from({ length: onAnchorReady.mock.calls.length }, () => [firstEntry.message.id, 0]),
  );
});
// SCIENT-FORK:END

it("does not push follow-up messages to the top", async () => {
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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).not.toContain("data-anchor-index=");
  expect(markup).not.toContain('data-maintain-scroll-at-end="enabled"');
  expect(onAnchorReady).not.toHaveBeenCalled();
});

it("never follows row growth in running or idle turns", async () => {
  const entries = [buildUserTimelineEntry("Hello")];
  const working = await renderScientMarkup(
    <MessagesTimeline {...buildProps()} isWorking timelineEntries={entries} />,
  );
  expect(working).not.toContain('data-maintain-scroll-at-end="enabled"');

  const idle = await renderScientMarkup(
    <MessagesTimeline {...buildProps()} timelineEntries={entries} />,
  );
  expect(idle).not.toContain('data-maintain-scroll-at-end="enabled"');
});

it("keeps reserved end space when tool work starts while reading history", async () => {
  const runId = RunId.make("run-with-active-tool");
  const firstEntry = buildUserTimelineEntry("Run the command.");
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      isWorking
      activeTurnInProgress
      latestRun={{
        runId,
        status: "running",
        startedAt: MESSAGE_CREATED_AT,
        completedAt: null,
      }}
      anchorMessageId={firstEntry.message.id}
      // SCIENT-FORK:START — no live-follow flag: the timeline never pins to its end.
      // SCIENT-FORK:END
      timelineEntries={[
        firstEntry,
        {
          id: "entry-active-tool",
          kind: "work",
          createdAt: MESSAGE_CREATED_AT,
          entry: {
            id: "work-active-tool",
            createdAt: MESSAGE_CREATED_AT,
            runId,
            label: "Run command",
            tone: "tool",
            itemType: "command_execution",
            command: "git status",
            toolLifecycleStatus: "inProgress",
          },
        },
      ]}
    />,
  );
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).toContain('data-anchor-index="0"');
  expect(markup).not.toContain('data-maintain-scroll-at-end="enabled"');
});

it("keeps following disabled after the send anchor is released", async () => {
  const firstEntry = buildUserTimelineEntry("First prompt.");
  const secondEntry = {
    ...buildUserTimelineEntry("Newest prompt."),
    id: "entry-2",
    message: {
      ...buildUserTimelineEntry("Newest prompt.").message,
      id: MessageId.make("message-2"),
    },
  };
  const timelineEntries = [firstEntry, secondEntry];

  // While the send anchor holds the end space open, ChatView owns streaming
  // scrolls and LegendList must not re-pin behind it.
  expect(
    await renderScientMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={firstEntry.message.id}
        timelineEntries={timelineEntries}
      />,
    ),
  ).not.toContain('data-maintain-scroll-at-end="enabled"');

  // Releasing reserved end space retains the bounded answer reader;
  // arbitrary list-layout changes must never pin the reader.
  expect(
    await renderScientMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={null}
        timelineEntries={timelineEntries}
      />,
    ),
  ).not.toContain('data-maintain-scroll-at-end="enabled"');

  // Reading history still wins over both.
  expect(
    await renderScientMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={null}
        timelineEntries={timelineEntries}
      />,
    ),
  ).not.toContain('data-maintain-scroll-at-end="enabled"');
});

// SCIENT-FORK:START — disclosure preserves reader ownership after restoration (UPSTREAM.md).
it("renders collapse controls for long user messages", async () => {
  await using screen = await renderElement(
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
    />,
  );
  // The browser restores first; static rendering never runs the list's onLoad effect.
  await vi.waitFor(() => {
    expect(
      screen.container
        .querySelector("[data-scient-list-probe]")
        ?.getAttribute("data-maintain-visible-content-position-size"),
    ).toBe("true");
  });
  const markup = screen.container.innerHTML;

  expect(markup).toContain("Show full message");
  // Prompt disclosure resizes the row without transferring reader ownership.
  expect(markup).not.toContain('data-maintain-scroll-at-end="enabled"');
  expect(markup).toContain('data-maintain-visible-content-position-size="true"');
  expect(markup).toContain('data-user-message-collapsed="true"');
  expect(markup).toContain('data-user-message-fade="true"');
  expect(markup).toContain('data-user-message-footer="true"');
});
// SCIENT-FORK:END

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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const markup = screen.container.innerHTML;

  expect(markup).not.toContain("data-anchor-index=");
  expect(markup).not.toContain('data-maintain-scroll-at-end="enabled"');
  expect(markup).toContain('data-maintain-visible-content-position-data="true"');
  expect(onAnchorReady).not.toHaveBeenCalled();
});

it("keeps answer following bounded when the send anchor is released", async () => {
  const firstEntry = buildUserTimelineEntry("First prompt.");
  const secondEntry = {
    ...buildUserTimelineEntry("Newest prompt."),
    id: "entry-2",
    message: {
      ...buildUserTimelineEntry("Newest prompt.").message,
      id: MessageId.make("message-2"),
    },
  };
  const timelineEntries = [firstEntry, secondEntry];

  expect(
    await renderScientMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={firstEntry.message.id}
        timelineEntries={timelineEntries}
      />,
    ),
  ).not.toContain('data-maintain-scroll-at-end="enabled"');

  // Releasing reserved end space retains the bounded answer reader;
  // arbitrary list-layout changes must never pin the reader.
  expect(
    await renderScientMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={null}
        timelineEntries={timelineEntries}
      />,
    ),
  ).not.toContain('data-maintain-scroll-at-end="enabled"');

  expect(
    await renderScientMarkup(
      <MessagesTimeline
        {...buildProps()}
        anchorMessageId={null}
        // SCIENT-FORK:START — no live-follow flag: the timeline never pins to its end.
        // SCIENT-FORK:END
        timelineEntries={timelineEntries}
      />,
    ),
  ).not.toContain('data-maintain-scroll-at-end="enabled"');
});

it.each([
  ["single row", 1, false],
  ["collapsed group", 2, false],
  ["expanded group", 2, true],
] as const)("marks generic dynamic tools with a wrench in a %s", async (_name, count, expanded) => {
  const markup = await renderScientExpandedMarkup(
    expanded,
    <MessagesTimeline
      {...buildProps()}
      timelineEntries={Array.from({ length: count }, (_, index) => ({
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
      }))}
    />,
  );

  expect(markup.match(/\blucide-wrench\b/g)).toHaveLength(expanded ? count + 1 : 1);
  expect(markup).not.toContain('data-scient-symbol="mono"');
  expect(markup).not.toContain("lucide-hammer");
  expect(markup).not.toContain("lucide-blocks");
});

it.each([
  ["Edit", "completed"],
  ["Write", "completed"],
  ["MultiEdit", "completed"],
  ["Edit", "inProgress"],
  ["Write", "inProgress"],
  ["MultiEdit", "inProgress"],
] as const)("marks native %s calls with a pencil while %s", async (toolName, status) => {
  const working = status === "inProgress";
  const markup = await renderScientExpandedMarkup(
    true,
    <MessagesTimeline
      {...buildProps()}
      isWorking={working}
      activeTurnInProgress={working}
      latestRun={{
        runId: RunId.make("run-1"),
        status: working ? "running" : "completed",
        startedAt: MESSAGE_CREATED_AT,
        completedAt: working ? null : MESSAGE_CREATED_AT,
      }}
      timelineEntries={[
        {
          id: "entry-native-edit",
          kind: "work",
          createdAt: MESSAGE_CREATED_AT,
          entry: {
            id: "work-native-edit",
            runId: RunId.make("run-1"),
            createdAt: MESSAGE_CREATED_AT,
            label: toolName,
            toolTitle: toolName,
            toolData: { toolName, input: { file_path: "src/example.ts" } },
            tone: "tool",
            itemType: "dynamic_tool",
            toolLifecycleStatus: status,
          },
        },
      ]}
    />,
  );

  expect(markup).toContain("lucide-pencil");
  expect(markup).not.toContain("lucide-wrench");
  expect(markup).not.toContain('data-scient-symbol="mono"');
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
    input: { threadId: "thread-child" },
    output: { messages: [] },
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
              toolData: { input: item.input, output: item.output },
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

  // SCIENT-FORK:START — with a live title, screen readers hear it too (#13140).
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
                toolData: { input: item.input, output: item.output },
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
  // SCIENT-FORK:END
});

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

async function renderScientExpandedMarkup(expand: boolean, element: ReactElement) {
  await using host = await renderElement(element);
  if (expand) {
    const toggle = host.container.querySelector<HTMLElement>('button[aria-expanded="false"]');
    if (toggle) await click(toggle);
  }
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  return host.container.innerHTML;
}

it("draws website tool icons locally instead of fetching a web favicon", async () => {
  const websiteEntry = (id: string, toolIcon: { pageUrl: string; faviconUrl?: string }) => ({
    id: `entry-${id}`,
    kind: "work" as const,
    createdAt: "2026-03-17T19:12:28.000Z",
    entry: {
      id: `work-${id}`,
      createdAt: "2026-03-17T19:12:28.000Z",
      label: `Opened page ${id}`,
      tone: "tool" as const,
      toolIcon: { _tag: "website" as const, ...toolIcon },
    },
  });
  const render = (entry: ReturnType<typeof websiteEntry>) =>
    renderScientMarkup(<MessagesTimeline {...buildProps()} timelineEntries={[entry]} />);

  // A page's /favicon.ico, a provider-supplied web favicon, and GitHub's hosted assets.
  for (const markup of [
    await render(websiteEntry("plain", { pageUrl: "https://example.org/report" })),
    await render(
      websiteEntry("explicit", {
        pageUrl: "https://example.org/report",
        faviconUrl: "https://cdn.example.org/icon.png",
      }),
    ),
    await render(websiteEntry("github", { pageUrl: "https://github.com/pingdotgg/t3code" })),
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

// SCIENT-FORK:START — attachment chips compose with upstream's nested work disclosures.
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
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
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
  // A picture keeps its tile even though it also has a chip: the chip names it, the tile is
  // the only way to see it. A plain file's row is what a chip replaces.
  expect(markup).toContain("grid-cols-1");

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
// SCIENT-FORK:END

it("does not enable following before or after a thread switch", async () => {
  const props = buildProps();
  const entries = [
    work("switch-work", {
      label: "Run lint",
      tone: "tool",
      itemType: "command_execution",
      command: "pnpm lint",
      toolLifecycleStatus: "completed",
    }),
  ];
  await using screen = await renderElement(
    <MessagesTimeline {...props} isWorking timelineEntries={entries} />,
  );
  const followsEnd = () =>
    screen.container.querySelector(
      '[data-scient-list-probe][data-maintain-scroll-at-end="enabled"]',
    );
  expect(followsEnd()).toBeNull();
  await screen.rerender(
    <MessagesTimeline
      {...props}
      routeThreadKey={props.routeThreadKey + "-next"}
      isWorking
      timelineEntries={entries}
    />,
  );
  expect(followsEnd()).toBeNull();
  await act(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(followsEnd()).toBeNull();
});

it.each([true, false])(
  "keeps the reading row in place when tool output toggles at the end: %s",
  async (isAtEnd) => {
    const props = buildProps();
    const history = Array.from({ length: 12 }, (_, i) =>
      message(
        "Earlier response " + i + "\n\n" + "Long paragraph. ".repeat(80),
        { role: "assistant" },
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
    if (!isAtEnd) await userEvent.wheel(viewport, { delta: { y: -100 } });
    const frame = () =>
      act(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    await frame();
    const offset = viewport.scrollTop;
    for (const expanded of [true, false]) {
      await click(screen.container.querySelector<HTMLElement>('[role="button"][aria-expanded]')!);
      await frame();
      expect(viewport.scrollTop).toBeCloseTo(offset, 0);
      // A late detail update uses the same reader owner as the initial disclosure.
      if (expanded) {
        await screen.rerender(timeline("Command output\n" + "Late output\n".repeat(8)));
        await frame();
        expect(viewport.scrollTop).toBeCloseTo(offset, 0);
      }
    }
  },
);
describe("compact reasoning math", () => {
  it("keeps formulas while flattening compact reasoning previews", () => {
    const authoredSource = "## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]";
    const source = scientMathMarkdownText(authoredSource);
    const processor = unified()
      .use(remarkParse)
      .use(scientMathRemarkPluginsForMessage(CHAT_MARKDOWN_REMARK_PLUGINS, authoredSource));
    const tree = processor.parse(source);
    processor.runSync(tree, { value: source });
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => node.type)).toEqual([
      "text",
      "inlineMath",
      "text",
      "inlineMath",
    ]);
    expect(tree.children.map((node) => ("value" in node ? node.value : null))).toEqual([
      "Reasoning Use norm ",
      "|x|",
      " and ",
      "x^2",
    ]);
  });
});
