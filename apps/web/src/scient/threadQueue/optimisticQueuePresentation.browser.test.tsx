import {
  act as _fixtureAct,
  render as _fixtureRender,
  type Screen,
  fakeTimers as _fixtureFakeTimers,
} from "../../../test/render";
import "../../index.css";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import {
  MessageId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
  type ScientThreadQueueItem,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { useState } from "react";

import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";
import { STATUS_MIN_VISIBLE_MS } from "@t3tools/client-runtime/delayed-status";
import { QUEUE_ADMISSION_STATUS_DELAY_MS, ThreadQueueStrip } from "./ThreadQueueStrip";
import {
  deriveQueueAcknowledgedUserMessages,
  pendingQueueAdmissionPreviews,
  optimisticTimelineMessages,
  settleQueueAdmissionPreview,
  type OptimisticUserMessage,
} from "./optimisticQueuePresentation";

async function _cleanupFixture0(_fixture: _Fixture) {
  vi.useRealTimers();
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
  onEdit.mockClear();
  onAcknowledged.mockClear();
}
const message: OptimisticUserMessage = {
  id: MessageId.make("pending"),
  role: "user",
  text: "שלום follow-up ".repeat(30),
  runId: null,
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
  streaming: false,
  attachments: [
    {
      type: "image",
      id: "plot",
      name: "plot.png",
      mimeType: "image/png",
      sizeBytes: 1,
      previewUrl: "blob:synthetic-preview",
    },
  ],
  queueAdmission: { threadKey: "host:thread", accepted: false },
};
const item: ScientThreadQueueItem = {
  queueItemId: "qitem_server",
  messageId: message.id,
  text: message.text,
  attachments: [
    {
      type: "image",
      name: "plot.png",
      mimeType: "image/png",
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,AA==",
    },
  ],
  createdAt: message.createdAt,
  updatedAt: message.updatedAt,
};
const onEdit = vi.fn();
const onAcknowledged =
  vi.fn<(messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "id">>) => void>();
const serverMessage: OrchestrationV2ConversationMessage = {
  createdBy: "user",
  creationSource: "web",
  id: message.id,
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  role: "user",
  text: message.text,
  attachments: [],
  streaming: false,
  createdAt: DateTime.makeUnsafe(message.createdAt),
  updatedAt: DateTime.makeUnsafe(message.updatedAt),
};
async function render(
  _fixture: _Fixture,
  messages: OptimisticUserMessage[],
  items: ScientThreadQueueItem[] = [],
  serverProjection: Pick<OrchestrationV2ThreadProjection, "messages"> | null = null,
  threadKey = "host:thread",
  attachmentUrls?: ReadonlyMap<string, string>,
) {
  if (!_fixture.host) {
    _fixture.host = document.createElement("div");
    _fixture.host.style.width = "320px";
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  await _fixtureAct(
    async () =>
      await _fixture.root0!.rerender(
        <PreviewWitness
          messages={messages}
          items={items}
          serverProjection={serverProjection}
          threadKey={threadKey}
          attachmentUrls={attachmentUrls}
        />,
      ),
  );
}

// Compose the owner's projection selector with the mounted queue strip and the host memo boundary.
function PreviewWitness({
  messages,
  items,
  serverProjection,
  threadKey,
  attachmentUrls,
}: {
  messages: OptimisticUserMessage[];
  items: ScientThreadQueueItem[];
  serverProjection: Pick<OrchestrationV2ThreadProjection, "messages"> | null;
  threadKey: string;
  attachmentUrls: ReadonlyMap<string, string> | undefined;
}) {
  const projectionMessages = serverProjection?.messages;
  const [selection, setSelection] = useState(() => ({
    source: projectionMessages,
    acknowledged: deriveQueueAcknowledgedUserMessages(projectionMessages ?? []),
  }));
  let acknowledged = selection.acknowledged;
  if (selection.source !== projectionMessages) {
    const next = {
      source: projectionMessages,
      acknowledged: deriveQueueAcknowledgedUserMessages(projectionMessages ?? []),
    };
    setSelection(next);
    acknowledged = next.acknowledged;
  }
  onAcknowledged(acknowledged);
  const serverMessages = serverProjection?.messages ?? [];
  const pending = pendingQueueAdmissionPreviews(messages, threadKey, items, acknowledged);
  return (
    <>
      <div data-testid="timeline">
        {serverMessages.map((entry) => (
          <div key={entry.id}>{entry.text}</div>
        ))}
        {deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: [],
          optimisticMessages: optimisticTimelineMessages(messages).filter(
            (entry) => !serverMessages.some((server) => server.id === entry.id),
          ),
        }).map((entry) =>
          entry.kind === "message" ? <div key={entry.id}>{entry.message.text}</div> : null,
        )}
      </div>
      <ThreadQueueStrip
        items={items}
        pendingMessages={pending.map((entry) => ({
          id: entry.id,
          text: entry.text,
          attachmentCount: entry.attachments?.length ?? 0,
          imageCount: entry.attachments?.filter((file) => file.type === "image").length ?? 0,
          accepted: entry.queueAdmission?.accepted === true,
        }))}
        {...(attachmentUrls === undefined ? {} : { attachmentUrls })}
        error={null}
        threadBusy
        supportsExplicitSend
        awaitingCompletion={false}
        paused={false}
        dispatchingItemId={null}
        retryable={false}
        onSend={() => {}}
        onSteer={() => {}}
        onEdit={onEdit}
        onDelete={() => {}}
        onReorder={() => {}}
      />
    </>
  );
}

it("keeps pending and accepted follow-ups beside the composer until the queue snapshot arrives", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await render(_fixture, [message]);
  expect(_fixture.host!.querySelector('[data-testid="timeline"]')!.textContent).toBe("");
  const pending = _fixture.host!.querySelector('[data-testid="thread-queue-pending-pending"]')!;
  expect(pending.querySelector('[role="status"]')).toBeNull();
  expect(pending.querySelector('[aria-label="1 attachment"]')).not.toBeNull();
  expect(pending.querySelector("button")).toBeNull();
  expect(_fixture.host!.scrollWidth).toBeLessThanOrEqual(321);
  const accepted = settleQueueAdmissionPreview([message], message.id, true);
  await render(_fixture, accepted);
  expect(
    _fixture.host!.querySelector('[data-testid="thread-queue-pending-pending"]'),
  ).not.toBeNull();
  expect(
    _fixture.host!.querySelector('[data-testid="thread-queue-strip"]')!.textContent,
  ).not.toContain("Queued");
  expect(_fixture.host!.querySelector('[data-testid="timeline"]')!.textContent).toBe("");
  await render(_fixture, accepted, [item]);
  expect(_fixture.host!.querySelector('[data-testid^="thread-queue-pending-"]')).toBeNull();
  expect(_fixture.host!.querySelectorAll('[data-testid^="thread-queue-row-"]')).toHaveLength(1);
  await userEvent.click(_fixture.host!.querySelector('[aria-label="Edit queued message"]')!);
  expect(onEdit).toHaveBeenCalledWith(item);
  // Delivery can beat the next queue poll; the stale preview must not duplicate it.
  await render(_fixture, accepted, [], { messages: [serverMessage] });
  expect(_fixture.host!.querySelector('[data-testid="thread-queue-strip"]')).toBeNull();
  expect(_fixture.host!.querySelector('[data-testid="timeline"]')!.textContent).toBe(message.text);
});

it("moves the preview to the timeline only if the server confirms an immediate send", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await render(_fixture, [message]);
  await render(_fixture, settleQueueAdmissionPreview([message], message.id, false));
  expect(_fixture.host!.querySelector('[data-testid="thread-queue-strip"]')).toBeNull();
  expect(_fixture.host!.querySelector('[data-testid="timeline"]')!.textContent).toBe(message.text);
});

it("does not leak a pending row to another thread or leave a row after rejection", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await render(_fixture, [message], [], null, "other-host:thread");
  expect(_fixture.host!.querySelector('[data-testid="thread-queue-strip"]')).toBeNull();
  await render(_fixture, []);
  expect(_fixture.host!.querySelector('[data-testid="thread-queue-strip"]')).toBeNull();
  expect(_fixture.host!.querySelector('[data-testid="timeline"]')!.textContent).toBe("");
});

it("says Queuing… only when admission is slow, and never Queued", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  _fixture.stack.use(_fixtureFakeTimers());
  const status = () =>
    _fixture.host!.querySelector('[data-testid="thread-queue-pending-pending"] [role="status"]')
      ?.textContent ?? null;
  const advance = async (ms: number) => await _fixtureAct(() => vi.advanceTimersByTime(ms));

  await render(_fixture, [message]);
  await advance(QUEUE_ADMISSION_STATUS_DELAY_MS - 1);
  expect(status()).toBeNull();
  await advance(1);
  expect(status()).toBe("Queuing…");

  // Acceptance clears it after a short hold instead of swapping in "Queued".
  await render(_fixture, settleQueueAdmissionPreview([message], message.id, true));
  expect(status()).toBe("Queuing…");
  await advance(STATUS_MIN_VISIBLE_MS);
  expect(status()).toBeNull();
  expect(
    _fixture.host!.querySelector('[data-testid="thread-queue-strip"]')!.textContent,
  ).not.toContain("Queued");

  // A fast admission never shows a label.
  const fast = { ...message, id: MessageId.make("fast") };
  await render(_fixture, [fast]);
  await advance(QUEUE_ADMISSION_STATUS_DELAY_MS - 1);
  await render(_fixture, settleQueueAdmissionPreview([fast], fast.id, true));
  await advance(QUEUE_ADMISSION_STATUS_DELAY_MS + STATUS_MIN_VISIBLE_MS);
  expect(
    _fixture.host!.querySelector('[data-testid="thread-queue-strip"]')!.textContent,
  ).not.toMatch(/Queuing…|Queued/);
});

it("keeps the row's text and controls in place when the queued row replaces it", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const second: ScientThreadQueueItem = {
    ...item,
    queueItemId: "qitem_existing",
    messageId: MessageId.make("existing"),
    text: "Existing",
    attachments: [],
  };
  // Both carry the same image: the pending preview and the queued row's attachment.
  const settled = message;
  const queued: ScientThreadQueueItem = {
    ...item,
    attachments: item.attachments.map((attachment) => ({ ...attachment, id: "plot" })),
  };
  const unresolved = new Map<string, string>();
  const resolved = new Map([["plot", "data:image/png;base64,AA=="]]);
  const box = (selector: string) => {
    const rect = _fixture.host!.querySelector(selector)!.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, height: rect.height };
  };
  const textOf = (row: string) => `${row} span[dir="auto"]`;

  const accepted = settleQueueAdmissionPreview([settled], settled.id, true);
  await render(_fixture, accepted, [second], null, "host:thread", unresolved);
  const pendingRow = '[data-testid="thread-queue-pending-pending"]';
  const before = {
    existing: box(textOf('[data-testid="thread-queue-row-qitem_existing"]')),
    row: box(pendingRow),
    text: box(textOf(pendingRow)),
  };

  expect(_fixture.host!.querySelectorAll(`${pendingRow} [data-thumbnail-slot]`)).toHaveLength(1);

  // The queued row arrives before its image URL resolves, then the URL resolves.
  const queuedRow = '[data-testid="thread-queue-row-qitem_server"]';
  for (const urls of [unresolved, resolved]) {
    await render(_fixture, accepted, [second, queued], null, "host:thread", urls);
    expect(_fixture.host!.querySelector(pendingRow)).toBeNull();
    expect(box(textOf('[data-testid="thread-queue-row-qitem_existing"]'))).toEqual(before.existing);
    expect(box(queuedRow)).toEqual(before.row);
    expect(box(textOf(queuedRow))).toEqual(before.text);
  }
  expect(_fixture.host!.querySelectorAll(`${queuedRow} img`)).toHaveLength(1);
});

it("reacts to projection replacement, excludes non-user acknowledgements, and retains the memo on an unchanged projection", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const pendingRow = () =>
    _fixture.host!.querySelector('[data-testid="thread-queue-pending-pending"]');
  const lastAcknowledged = () => onAcknowledged.mock.lastCall![0];
  await render(_fixture, [message]);
  expect(pendingRow()).not.toBeNull();
  const absent = lastAcknowledged();
  await render(_fixture, settleQueueAdmissionPreview([message], message.id, true));
  expect(lastAcknowledged()).toBe(absent);
  expect(pendingRow()).not.toBeNull();

  const assistantProjection = { messages: [{ ...serverMessage, role: "assistant" as const }] };
  await render(_fixture, [message], [], assistantProjection);
  expect(pendingRow()).not.toBeNull();
  const assistantAcknowledged = lastAcknowledged();
  await render(
    _fixture,
    settleQueueAdmissionPreview([message], message.id, true),
    [],
    assistantProjection,
  );
  expect(lastAcknowledged()).toBe(assistantAcknowledged);
  expect(pendingRow()).not.toBeNull();

  // The user message arrives before either the receipt or the queue poll.
  const delivered = { messages: [serverMessage] };
  await render(_fixture, [message], [], delivered);
  expect(pendingRow()).toBeNull();
  expect(_fixture.host!.querySelector('[data-testid="thread-queue-strip"]')).toBeNull();
  expect(_fixture.host!.querySelector('[data-testid="timeline"]')!.textContent).toBe(message.text);
  const userAcknowledged = lastAcknowledged();
  await render(_fixture, settleQueueAdmissionPreview([message], message.id, true), [], delivered);
  expect(lastAcknowledged()).toBe(userAcknowledged);
  expect(pendingRow()).toBeNull();

  // Replacing the projection without changing its messages keeps the same visible result.
  await render(_fixture, [message], [], { ...delivered });
  expect(pendingRow()).toBeNull();
  await render(_fixture, [message], [], assistantProjection);
  expect(pendingRow()).not.toBeNull();
  await render(_fixture, [message]);
  expect(pendingRow()).not.toBeNull();
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
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
