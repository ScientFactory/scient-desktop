import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeCursorAdapter } from "./CursorAdapter.ts";
import {
  observeAdapterNotificationLifecycle,
  ProviderNotificationAdapterTestLayer,
} from "./ProviderNotificationDrain.testSupport.ts";

describe("CursorAdapter notification drain lifetime", () => {
  it("delivers post-start notifications and bounds replacement, stop, and startup failure", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        observeAdapterNotificationLifecycle({
          provider: "cursor",
          makeAdapter: (sessionRuntimeFactory) => makeCursorAdapter({}, { sessionRuntimeFactory }),
        }).pipe(Effect.provide(ProviderNotificationAdapterTestLayer)),
      ),
    );

    expect(result).toEqual({
      firstEventProvider: "cursor",
      firstEventDelta: "late-first",
      firstScopeClosed: true,
      replacementEventProvider: "cursor",
      replacementEventDelta: "late-replacement",
      replacementScopeClosed: true,
      sessionPresentAfterStop: false,
      failedStart: true,
      failedScopeClosed: true,
      failedSessionPresent: false,
    });
  });
});
