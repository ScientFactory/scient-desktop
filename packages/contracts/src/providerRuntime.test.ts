import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderRuntimeEvent, type ProviderRuntimeEventType } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const encodeRuntimeEvent = Schema.encodeSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("round-trips stopped ordinary items without changing existing statuses", () => {
    for (const status of ["inProgress", "completed", "failed", "declined", "stopped"]) {
      const event = decodeRuntimeEvent({
        type: "item.completed",
        eventId: "stopped-tool",
        provider: "omp",
        threadId: "thread",
        turnId: "turn",
        createdAt: "2026-10-02T00:00:00.000Z",
        itemId: "tool",
        payload: { itemType: "dynamic_tool_call", status },
      });
      expect(decodeRuntimeEvent(encodeRuntimeEvent(event))).toEqual(event);
      expect(event.payload).toEqual({ itemType: "dynamic_tool_call", status });
    }
  });
  it("round-trips truncation stop reasons without changing legacy events", () => {
    const base = {
      type: "turn.completed",
      eventId: "token-limit",
      provider: "droid",
      threadId: "thread",
      turnId: "turn",
      createdAt: "2026-09-06T00:00:00.000Z",
      payload: { state: "failed", errorMessage: "Any wording" },
    };
    for (const payload of [
      base.payload,
      { state: "completed", stopReason: "length" },
      { state: "completed", stopReason: "max_tokens" },
    ]) {
      const event = decodeRuntimeEvent({ ...base, payload });
      expect(decodeRuntimeEvent(encodeRuntimeEvent(event))).toEqual(event);
      expect(event.payload).toEqual(payload);
    }
  });
  it("includes every runtime event in the public event type", () => {
    expectTypeOf<ProviderRuntimeEvent["type"]>().toEqualTypeOf<ProviderRuntimeEventType>();
  });

  it("decodes an authoritative provider reauthentication signal", () => {
    const parsed = decodeRuntimeEvent({
      type: "auth.status",
      eventId: "event-auth-expired",
      provider: "claudeAgent",
      providerInstanceId: "claudeAgent",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        requiresReauthentication: true,
        error: "OAuth access token has been revoked.",
      },
    });

    expect(parsed.type).toBe("auth.status");
    if (parsed.type !== "auth.status") {
      throw new Error("expected auth.status");
    }
    expect(parsed.payload.requiresReauthentication).toBe(true);
  });
});
