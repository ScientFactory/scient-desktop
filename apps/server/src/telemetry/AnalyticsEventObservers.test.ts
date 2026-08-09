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
        orchestrationEvent({ type: "thread.reverted", payload: { threadId: "fork" } }),
      ),
    ).toEqual([{ name: "thread.revert.completed", properties: {} }]);
  });
});
