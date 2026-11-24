import { CheckpointRef, EnvironmentId, MessageId, RunId } from "@t3tools/contracts";

import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, render } from "../../../test/render";
import timelineVideoUrl from "../../../test/fixtures/silent-video.mp4?url";
import { MessagesTimeline } from "./MessagesTimeline";

const environmentQuery = vi.hoisted(() => ({
  error: "Pull request not found",
  data: null as unknown,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: environmentQuery.data,
    dataUpdatedAt: 0,
    error: environmentQuery.error,
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
          style={{
            display: "contents",
          }}
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

// SCIENT-FORK:START — browser image fixtures must decode, unlike static-renderer placeholders.

// SCIENT-FORK:END

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenThread: () => {},
    onForkFromRun: async () => {},
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

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("MessagesTimeline work rows", () => {
  // regression: da7c4f234d test(web): chat markdown and timeline tests run in a real browser (#20905)
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

// SCIENT-FORK:START - fork, attachment, direction, and activity policy in the real browser timeline.
const MESSAGE_CREATED_AT = CREATED_AT;

const buildProps = baseProps;
function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from(
    {
      length: 9,
    },
    (_, index) =>
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

// regression: 299404a754 feat(desktop): add cross-platform window capture (#8103)
it("does not render window details before the preview URL resolves", async () => {
  await using screen = await renderElement(
    <MessagesTimeline {...buildProps()} timelineEntries={[buildSnapShotTimelineEntry()]} />,
  );
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain("screenshot.png");
  expect(markup).not.toContain("Terminal");
  expect(markup).not.toContain("t3code — Tests");
  expect(markup).not.toContain('src="data:image/png;base64,aWNvbg=="');
  expect(markup).not.toContain("h-28 w-52 max-w-full");
});
// regression: 7751299848 feat(web): preview document attachments in the file viewer (#9292)
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
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain('aria-label="Preview report.pdf"');
  expect(markup).toContain('aria-label="Download report.pdf"');
  expect(markup).not.toContain('download="report.pdf"');
  expect(markup).not.toContain('alt="report.pdf"');
});
// regression: 922bd69225 refactor(media): unify file and media previews across clients (#9253)
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
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain("<video");
  expect(markup).toContain('aria-label="demo.mp4"');
  expect(markup).not.toContain("Expand demo.mp4");
});
// regression: 922bd69225 refactor(media): unify file and media previews across clients (#9253)
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
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).not.toContain("<video");
  expect(markup).toContain(">pending-demo.mp4</div>");
});
// regression: 4fed6cfb35 feat: add inline file previews and attachment chips across surfaces (#11265)
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
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain('aria-label="Preview archive.zip"');
  expect(markup).toContain('aria-label="Download archive.zip"');
  expect(markup).not.toContain("<a href=");
});
// regression: da7c4f234d test(web): chat markdown and timeline tests run in a real browser (#20905)
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
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain("voice-memo.ogg");
  expect(markup).not.toContain('aria-label="Download voice-memo.ogg"');
  expect(markup).not.toContain('alt="voice-memo.ogg"');
  expect(markup).not.toContain("<a href=");
});

// regression: 4a9edff4c1 feat(web): collapse tool activity into one line (#7152)
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
  await vi.waitFor(() =>
    expect(screen.container.querySelector("[data-timeline-row-kind]")).not.toBeNull(),
  );
  const markup = screen.container.innerHTML;
  expect(markup).toContain("Changed 1 file");
  expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
});

// SCIENT-FORK:END

// SCIENT-FORK:START — first-message framing and snapshot metadata survive actual image decoding.

// SCIENT-FORK:END

// SCIENT-FORK:START — disclosure preserves reader ownership after restoration (UPSTREAM.md).

// regression: 99efaa0faa Collapse long user messages by default (#2180)
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

// SCIENT-FORK:START — attachment chips compose with upstream's nested work disclosures.

// SCIENT-FORK:END
