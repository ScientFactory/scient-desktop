import type { OrchestrationEvent, ProviderRuntimeEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { createAnalyticsEventMapper } from "./AnalyticsEventObservers.ts";

function providerEvent(input: Record<string, unknown>): ProviderRuntimeEvent {
  return input as unknown as ProviderRuntimeEvent;
}

function orchestrationEvent(input: Record<string, unknown>): OrchestrationEvent {
  return input as unknown as OrchestrationEvent;
}

describe("AnalyticsEventObservers", () => {
  it("counts one stopped outcome for duplicate abort/completion notifications, not a provider failure", () => {
    const mapper = createAnalyticsEventMapper();
    const event = {
      provider: "grok",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: "2026-08-31T10:00:00Z",
    };
    const stopped = mapper.providerEvent(
      providerEvent({ ...event, type: "turn.aborted", payload: { reason: "private reason" } }),
    );
    expect(stopped).toEqual([
      {
        name: "provider.turn.stopped",
        properties: {
          provider: "grok",
          model: undefined,
          durationMs: undefined,
          stopClass: "aborted",
        },
      },
    ]);
    expect(
      mapper.providerEvent(
        providerEvent({ ...event, type: "turn.completed", payload: { state: "cancelled" } }),
      ),
    ).toEqual([]);
    expect(JSON.stringify(stopped)).not.toContain("private reason");
  });

  it("clears correlations when a collection boundary changes", () => {
    const mapper = createAnalyticsEventMapper();
    const event = {
      provider: "droid",
      threadId: "private-thread",
      turnId: "private-turn",
      createdAt: "2026-08-31T10:00:00Z",
    };
    mapper.providerEvent(
      providerEvent({ ...event, type: "turn.started", payload: { model: "private-model" } }),
    );
    mapper.clear();
    const result = mapper.providerEvent(
      providerEvent({ ...event, type: "turn.completed", payload: { state: "completed" } }),
    );
    expect(result[0]!.properties.model).toBeUndefined();
    expect(result[0]!.properties.durationMs).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("correlates a successful provider turn without retaining transcript content", () => {
    const mapper = createAnalyticsEventMapper();
    expect(
      mapper.providerEvent(
        providerEvent({
          type: "turn.started",
          provider: "codex",
          threadId: "thread-1",
          turnId: "turn-1",
          createdAt: "2026-08-09T10:00:00.000Z",
          payload: { model: "gpt-5.6-sol", effort: "high" },
        }),
      ),
    ).toEqual([]);
    mapper.providerEvent(
      providerEvent({
        type: "item.started",
        provider: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
        createdAt: "2026-08-09T10:00:01.000Z",
        payload: { itemType: "command_execution", title: "private command" },
      }),
    );
    mapper.orchestrationEvent(
      orchestrationEvent({
        type: "thread.message-sent",
        payload: {
          threadId: "thread-1",
          role: "assistant",
          turnId: "turn-1",
          attachments: [{ id: "private-attachment" }],
        },
      }),
    );

    expect(
      mapper.providerEvent(
        providerEvent({
          type: "turn.completed",
          provider: "codex",
          threadId: "thread-1",
          turnId: "turn-1",
          createdAt: "2026-08-09T10:00:12.000Z",
          payload: { state: "completed", usage: { private: true } },
        }),
      ),
    ).toEqual([
      {
        name: "provider.turn.completed",
        properties: {
          provider: "codex",
          model: "gpt-5.6-sol",
          durationMs: 12_000,
          usedTools: true,
          hasAttachment: true,
        },
      },
    ]);
  });

  it("uses only the provider's bounded error class for a failed turn", () => {
    const mapper = createAnalyticsEventMapper();
    mapper.providerEvent(
      providerEvent({
        type: "turn.started",
        provider: "claudeAgent",
        threadId: "thread-2",
        turnId: "turn-2",
        createdAt: "2026-08-09T10:00:00.000Z",
        payload: { model: "claude-sonnet-5" },
      }),
    );
    mapper.providerEvent(
      providerEvent({
        type: "runtime.error",
        provider: "claudeAgent",
        threadId: "thread-2",
        turnId: "turn-2",
        createdAt: "2026-08-09T10:00:03.000Z",
        payload: { class: "transport_error", message: "private provider error" },
      }),
    );

    expect(
      mapper.providerEvent(
        providerEvent({
          type: "turn.completed",
          provider: "claudeAgent",
          threadId: "thread-2",
          turnId: "turn-2",
          createdAt: "2026-08-09T10:00:04.000Z",
          payload: { state: "failed", errorMessage: "private provider error" },
        }),
      ),
    ).toEqual([
      {
        name: "provider.turn.failed",
        properties: {
          provider: "claudeAgent",
          model: "claude-sonnet-5",
          durationMs: 4_000,
          failureClass: "transport_error",
        },
      },
    ]);
  });

  it("records terminal fork and revert outcomes from durable orchestration events", () => {
    const mapper = createAnalyticsEventMapper();
    mapper.orchestrationEvent(
      orchestrationEvent({
        type: "thread.forked",
        payload: {
          originThreadId: "origin",
          newThreadId: "fork",
          workspaceMode: "local",
          sourceCheckpointTurnCount: null,
        },
      }),
      { refork: true },
    );

    expect(
      mapper.orchestrationEvent(
        orchestrationEvent({
          type: "thread.fork-completed",
          payload: { threadId: "fork" },
        }),
      ),
    ).toEqual([
      {
        name: "thread.fork.completed",
        properties: {
          workspaceMode: "local",
          boundaryClass: "conversation",
          refork: true,
        },
      },
    ]);
    expect(
      mapper.orchestrationEvent(
        orchestrationEvent({
          eventId: "private-revert-event",
          type: "thread.reverted",
          payload: { threadId: "fork" },
        }),
      ),
    ).toEqual([{ name: "thread.revert.completed", properties: {} }]);
  });

  it("records canonical revert failures without reading private activity content", () => {
    const mapper = createAnalyticsEventMapper();
    const event = orchestrationEvent({
      eventId: "private-failure-event",
      type: "thread.activity-appended",
      payload: {
        threadId: "private-thread",
        activity: {
          kind: "checkpoint.revert.failed",
          get summary() {
            throw new Error("analytics must not read private summaries");
          },
          get payload() {
            throw new Error("analytics must not read private failure details");
          },
        },
      },
    });
    expect(mapper.orchestrationEvent(event)).toEqual([
      { name: "thread.revert.failed", properties: { failureClass: "unknown" } },
    ]);
    expect(mapper.orchestrationEvent(event)).toEqual([]);
    mapper.clear();
    expect(mapper.orchestrationEvent(event)).toHaveLength(1);
  });

  it("does not mistake other error activities for a revert failure", () => {
    const mapper = createAnalyticsEventMapper();
    for (const kind of ["checkpoint.capture.failed", "provider.error", "revert.failed"]) {
      expect(
        mapper.orchestrationEvent(
          orchestrationEvent({
            eventId: kind,
            type: "thread.activity-appended",
            payload: { activity: { kind, tone: "error" } },
          }),
        ),
      ).toEqual([]);
    }
  });

  it("deduplicates revert completion without suppressing later attempts", () => {
    const mapper = createAnalyticsEventMapper();
    const event = orchestrationEvent({
      eventId: "first-revert-event",
      type: "thread.reverted",
      payload: { threadId: "private-thread" },
    });
    expect(mapper.orchestrationEvent(event)).toHaveLength(1);
    expect(mapper.orchestrationEvent(event)).toEqual([]);
    expect(
      mapper.orchestrationEvent(orchestrationEvent({ ...event, eventId: "next-revert-event" })),
    ).toHaveLength(1);
  });
});
